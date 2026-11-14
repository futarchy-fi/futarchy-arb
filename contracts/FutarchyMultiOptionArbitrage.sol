// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// =============================================================================
// INTERFACES
// =============================================================================

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
}

interface IUniswapV3PoolMinimal {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
    function flash(address recipient, uint256 amount0, uint256 amount1, bytes calldata data) external;
}

interface IUniswapV3FactoryMinimal {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

interface IFutarchyMultiProposal {
    function numOutcomes() external view returns (uint256);
    function collateralToken1() external view returns (address);
    function collateralToken2() external view returns (address);
    function parentCollectionId() external view returns (bytes32);
    function wrappedOutcomeFor(address collateralToken, uint256 outcome) external view returns (address token, bytes memory data);
    function parentWrappedOutcome(address collateralToken) external view returns (address token, bytes memory data);
}

interface IFutarchyMultiRouter {
    function splitPosition(address proposal, address collateralToken, uint256 amount) external;
    function mergePositions(address proposal, address collateralToken, uint256 amount) external;
}

// =============================================================================
// MULTI-OPTION FUTARCHY ARBITRAGE
// =============================================================================

/**
 * @title FutarchyMultiOptionArbitrage
 * @notice Arbitrage for multi-option futarchy markets (FutarchyMultiProposal) on Uniswap V3.
 *
 *         A market has N options. For a company token C (NVDA) and a currency token U (USDG), option k has
 *         two outcome tokens, k_C and k_U, and two pools:
 *           price pool        k_C / k_U   its price is the value of C if k wins
 *           probability pool  k_U / U     its price p_k is the probability of k
 *         Splitting 1 C gives 1 of every k_C; splitting 1 U gives 1 of every k_U; merging is the reverse.
 *         Two identities follow, and this contract trades each one back into line:
 *
 *           sum_k p_k * price_k = spot price of C      (executeSpotArbitrage)
 *           sum_k p_k           = 1                    (executeProbabilityArbitrage)
 *
 *         SUM_ABOVE_SPOT: take C from the spot pool, split, sell every k_C for k_U, merge the k_U back to U
 *                         (trading only the unequal remainders in the probability pools), pay the spot pool.
 *         SUM_BELOW_SPOT: borrow U, split it, buy the same amount of every k_C, merge to C, sell the C at
 *                         spot, repay.
 *         PROBABILITIES_ABOVE_ONE: split U, sell every k_U.
 *         PROBABILITIES_BELOW_ONE: buy one of every k_U, merge to U.
 *
 * @dev    - Profit-or-revert: every entry point reverts unless the currency gained is at least `minProfit`.
 *         - Capital: SUM_ABOVE_SPOT is a flash swap on the spot pool (the company tokens arrive first and
 *           are paid for at the end). The other three need currency up front and borrow it with a Uniswap V3
 *           flash loan from any pool that holds it (pick the lowest fee), repaid with the pool fee. A working
 *           balance would avoid that fee but would mean holding funds; nothing is held between calls: profit
 *           and any leftover outcome tokens go to the treasury in the same transaction.
 *         - Approvals: pools are called directly and paid in their callbacks. The only approvals are exact
 *           amounts to the futarchy router, consumed in the same call.
 *         - Roles: the operator (the bot key, gas only) can only run arbitrages. The owner adds markets,
 *           changes roles and recovers stray tokens. The treasury receives the profit.
 *         - Markets are added by the owner without redeploying. Every pool must be the Uniswap V3 factory's
 *           pool for exactly the expected token pair, so a fake pool cannot be registered by mistake. A
 *           nested market (a proposal whose collateral is a parent option's tokens) uses that parent
 *           option's price pool as its "spot" pool.
 *         - No price is computed on-chain and decimals never matter here: the only check is realised profit.
 */
contract FutarchyMultiOptionArbitrage {
    // ==========================================================================
    // CONSTANTS
    // ==========================================================================

    IFutarchyMultiRouter public immutable futarchyRouter;
    IUniswapV3FactoryMinimal public immutable uniswapFactory;

    uint160 private constant MIN_SQRT_RATIO = 4295128739;
    uint160 private constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    uint8 private constant MODE_PAY = 0; // plain swap: pay what the pool asks for
    uint8 private constant MODE_SPOT_ABOVE = 1; // flash swap on the spot pool, sum above spot
    uint8 private constant MODE_SPOT_BELOW = 2; // flash loan, sum below spot
    uint8 private constant MODE_PRICE_BUY = 3; // exact-output buy of k_C; top up k_U before paying
    uint8 private constant MODE_PROB_ABOVE = 4; // flash loan, probabilities above one
    uint8 private constant MODE_PROB_BELOW = 5; // flash loan, probabilities below one

    // ==========================================================================
    // STATE
    // ==========================================================================

    struct Market {
        address proposal;
        address companyBase; // collateral argument for the router (C)
        address currencyBase; // collateral argument for the router (U)
        address company; // token the router takes and returns for C (C itself, or the parent option's C token)
        address currency; // same for U
        address spotPool; // company / currency
        address flashPool; // any other Uniswap V3 pool holding `currency`: source of the flash loans
        address[] companyTokens; // k_C
        address[] currencyTokens; // k_U
        address[] pricePools; // k_C / k_U
        address[] probPools; // k_U / currency
        bool active;
    }

    struct PoolTokens {
        address token0;
        address token1;
    }

    enum SpotDirection {
        SUM_ABOVE_SPOT,
        SUM_BELOW_SPOT
    }

    enum ProbabilityDirection {
        PROBABILITIES_ABOVE_ONE,
        PROBABILITIES_BELOW_ONE
    }

    address public owner;
    address public operator;
    address public treasury;

    Market[] private _markets;
    mapping(address => PoolTokens) private _pools; // every registered pool, checked against the factory

    // Context of the run in progress (zero between calls).
    bool private _executing;
    uint256 private _marketId;
    uint256 private _level;
    uint256 private _companyAmount;
    bool private _splitDone;

    // ==========================================================================
    // EVENTS & ERRORS
    // ==========================================================================

    event SpotArbitrageExecuted(uint256 indexed marketId, SpotDirection direction, uint256 companyAmount, uint256 profit);
    event ProbabilityArbitrageExecuted(
        uint256 indexed marketId, ProbabilityDirection direction, uint256 currencyAmount, uint256 profit
    );
    event MarketAdded(uint256 indexed marketId, address indexed proposal, uint256 options);
    event MarketActiveChanged(uint256 indexed marketId, bool active);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OperatorChanged(address indexed previousOperator, address indexed newOperator);
    event TreasuryChanged(address indexed previousTreasury, address indexed newTreasury);

    error NotOwner();
    error NotOperator();
    error NotExecuting();
    error UnknownPool(address pool);
    error PoolMismatch(address pool);
    error MarketInactive(uint256 marketId);
    error ArbitrageFailed(uint256 balanceAfter, uint256 required, string reason);
    error TokenCallFailed(address token);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator && msg.sender != owner) revert NotOperator();
        _;
    }

    // ==========================================================================
    // CONSTRUCTOR
    // ==========================================================================

    constructor(address futarchyRouter_, address uniswapFactory_, address operator_, address treasury_) {
        require(
            futarchyRouter_ != address(0) && uniswapFactory_ != address(0) && operator_ != address(0)
                && treasury_ != address(0),
            "Zero address"
        );
        futarchyRouter = IFutarchyMultiRouter(futarchyRouter_);
        uniswapFactory = IUniswapV3FactoryMinimal(uniswapFactory_);
        owner = msg.sender;
        operator = operator_;
        treasury = treasury_;
        emit OwnershipTransferred(address(0), msg.sender);
        emit OperatorChanged(address(0), operator_);
        emit TreasuryChanged(address(0), treasury_);
    }

    // ==========================================================================
    // MARKETS
    // ==========================================================================

    /**
     * @notice Register a market. The outcome tokens are read from the proposal; each pool must be the
     *         factory's pool for exactly the expected pair.
     * @param proposal The FutarchyMultiProposal.
     * @param spotPool Pool trading the market's company token against its currency token.
     * @param flashPool Any Uniswap V3 pool other than `spotPool` holding the currency token (flash loans).
     * @param pricePools pricePools[k] trades k_C / k_U.
     * @param probPools probPools[k] trades k_U / currency.
     */
    function addMarket(
        address proposal,
        address spotPool,
        address flashPool,
        address[] calldata pricePools,
        address[] calldata probPools
    ) external onlyOwner returns (uint256 marketId) {
        IFutarchyMultiProposal p = IFutarchyMultiProposal(proposal);
        uint256 n = p.numOutcomes();
        require(n >= 2 && pricePools.length == n && probPools.length == n, "Bad pool count");

        marketId = _markets.length;
        Market storage m = _markets.push();
        m.proposal = proposal;
        m.companyBase = p.collateralToken1();
        m.currencyBase = p.collateralToken2();
        if (p.parentCollectionId() == bytes32(0)) {
            (m.company, m.currency) = (m.companyBase, m.currencyBase);
        } else {
            // Nested market: the router takes and returns the parent option's tokens.
            (m.company,) = p.parentWrappedOutcome(m.companyBase);
            (m.currency,) = p.parentWrappedOutcome(m.currencyBase);
        }

        _registerPool(spotPool, m.company, m.currency);
        m.spotPool = spotPool;

        // The flash pool only has to be a real pool that holds the currency.
        IUniswapV3PoolMinimal fp = IUniswapV3PoolMinimal(flashPool);
        (address f0, address f1) = (fp.token0(), fp.token1());
        // It must not be the spot pool: a pool is locked during its own flash loan and cannot be traded.
        if ((f0 != m.currency && f1 != m.currency) || flashPool == spotPool) revert PoolMismatch(flashPool);
        _registerPool(flashPool, f0, f1);
        m.flashPool = flashPool;

        for (uint256 k = 0; k < n; k++) {
            (address kc,) = p.wrappedOutcomeFor(m.companyBase, k);
            (address ku,) = p.wrappedOutcomeFor(m.currencyBase, k);
            _registerPool(pricePools[k], kc, ku);
            _registerPool(probPools[k], ku, m.currency);
            m.companyTokens.push(kc);
            m.currencyTokens.push(ku);
            m.pricePools.push(pricePools[k]);
            m.probPools.push(probPools[k]);
        }
        m.active = true;
        emit MarketAdded(marketId, proposal, n);
    }

    function setMarketActive(uint256 marketId, bool active) external onlyOwner {
        _markets[marketId].active = active;
        emit MarketActiveChanged(marketId, active);
    }

    function _registerPool(address pool, address tokenA, address tokenB) private {
        IUniswapV3PoolMinimal p = IUniswapV3PoolMinimal(pool);
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        if (tokenA == tokenB || tokenA == address(0) || uniswapFactory.getPool(t0, t1, p.fee()) != pool) {
            revert PoolMismatch(pool);
        }
        _pools[pool] = PoolTokens(t0, t1);
    }

    function marketCount() external view returns (uint256) {
        return _markets.length;
    }

    function getMarket(uint256 marketId) external view returns (Market memory) {
        return _markets[marketId];
    }

    // ==========================================================================
    // ARBITRAGE 1: sum_k p_k * price_k = spot
    // ==========================================================================

    /**
     * @notice Trade the weighted sum of the option prices back to spot. Reverts unless it nets `minProfit`.
     * @param marketId The market.
     * @param direction SUM_ABOVE_SPOT (0) or SUM_BELOW_SPOT (1).
     * @param companyAmount Company tokens bought at spot and split (above), or bought as options, merged and
     *                      sold at spot (below).
     * @param level Currency outcome tokens to hold of every option before merging (above) or to split
     *              before buying (below); the difference per option is traded in its probability pool.
     *              0 picks it automatically: the smallest balance (above), the first option's cost (below).
     * @param currencyBudget SUM_BELOW_SPOT only: currency to borrow for the duration of the call. It must
     *                       cover the split plus any top-ups; about 1.3 times the spot value is plenty.
     * @param minProfit Minimum profit in the currency token (after the flash fee, if any).
     * @return profit Currency sent to the treasury.
     */
    function executeSpotArbitrage(
        uint256 marketId,
        SpotDirection direction,
        uint256 companyAmount,
        uint256 level,
        uint256 currencyBudget,
        uint256 minProfit
    ) external onlyOperator returns (uint256 profit) {
        Market storage m = _begin(marketId, level);
        require(companyAmount > 0 && companyAmount <= uint256(type(int256).max), "Bad amount");
        uint256 before = _balance(m.currency);

        if (direction == SpotDirection.SUM_ABOVE_SPOT) {
            // Buy exactly `companyAmount` at spot; the currency is paid in the callback.
            _swap(m.spotPool, m.currency, m.company, -int256(companyAmount), abi.encode(MODE_SPOT_ABOVE, uint256(0)));
        } else {
            require(currencyBudget > 0, "Budget required");
            _companyAmount = companyAmount;
            _flash(m, currencyBudget, MODE_SPOT_BELOW);
        }

        profit = _finish(m, before, minProfit);
        emit SpotArbitrageExecuted(marketId, direction, companyAmount, profit);
    }

    // ==========================================================================
    // ARBITRAGE 2: sum_k p_k = 1
    // ==========================================================================

    /**
     * @notice Trade the probabilities back to a sum of one. Reverts unless it nets `minProfit`.
     * @param marketId The market.
     * @param direction PROBABILITIES_ABOVE_ONE (0): split and sell every option.
     *                  PROBABILITIES_BELOW_ONE (1): buy one of every option and merge.
     * @param currencyAmount Currency split (above) or number of full sets bought (below). Borrowed from the
     *                       flash pool for the duration of the call.
     * @param minProfit Minimum profit in the currency token, after the flash fee.
     * @return profit Currency sent to the treasury.
     */
    function executeProbabilityArbitrage(
        uint256 marketId,
        ProbabilityDirection direction,
        uint256 currencyAmount,
        uint256 minProfit
    ) external onlyOperator returns (uint256 profit) {
        Market storage m = _begin(marketId, 0);
        require(currencyAmount > 0 && currencyAmount <= uint256(type(int256).max), "Bad amount");
        uint256 before = _balance(m.currency);

        _flash(m, currencyAmount, direction == ProbabilityDirection.PROBABILITIES_ABOVE_ONE ? MODE_PROB_ABOVE : MODE_PROB_BELOW);

        profit = _finish(m, before, minProfit);
        emit ProbabilityArbitrageExecuted(marketId, direction, currencyAmount, profit);
    }

    // ==========================================================================
    // UNISWAP V3 CALLBACKS
    // ==========================================================================

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        if (!_executing) revert NotExecuting();
        PoolTokens memory pt = _pools[msg.sender];
        if (pt.token0 == address(0)) revert UnknownPool(msg.sender);
        Market storage m = _markets[_marketId];

        (address owedToken, uint256 owed, uint256 received) = amount0Delta > 0
            ? (pt.token0, uint256(amount0Delta), uint256(-amount1Delta))
            : (pt.token1, uint256(amount1Delta), uint256(-amount0Delta));

        (uint8 mode, uint256 k) = abi.decode(data, (uint8, uint256));
        if (mode == MODE_SPOT_ABOVE) {
            if (msg.sender != m.spotPool) revert UnknownPool(msg.sender);
            _runSumAboveSpot(m, received);
        } else if (mode == MODE_PRICE_BUY) {
            if (msg.sender != m.pricePools[k]) revert UnknownPool(msg.sender);
            // First purchase: split the currency now that one option's cost is known.
            if (!_splitDone) {
                _splitDone = true;
                _split(m, m.currency, m.currencyBase, _level > 0 ? _level : owed);
            }
            // Short of this option's currency token: buy the difference in its probability pool.
            uint256 have = _balance(owedToken);
            if (have < owed) {
                _swap(m.probPools[k], m.currency, owedToken, -int256(owed - have), abi.encode(MODE_PAY, uint256(0)));
            }
        }

        uint256 balance = _balance(owedToken);
        if (balance < owed) revert ArbitrageFailed(balance, owed, "Insufficient to repay");
        _transfer(owedToken, msg.sender, owed);
    }

    function uniswapV3FlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external {
        if (!_executing) revert NotExecuting();
        Market storage m = _markets[_marketId];
        if (msg.sender != m.flashPool) revert UnknownPool(msg.sender);

        (uint8 mode, uint256 amount) = abi.decode(data, (uint8, uint256));
        uint256 n = m.currencyTokens.length;
        if (mode == MODE_SPOT_BELOW) {
            _runSumBelowSpot(m, _companyAmount);
            // Sell the merged company tokens at spot.
            _sellAll(m.spotPool, m.company, m.currency);
        } else if (mode == MODE_PROB_ABOVE) {
            // Split the currency and sell every option's token.
            _split(m, m.currency, m.currencyBase, amount);
            for (uint256 k = 0; k < n; k++) {
                _sellAll(m.probPools[k], m.currencyTokens[k], m.currency);
            }
        } else {
            // Buy `amount` of every option's token and merge the full sets.
            for (uint256 k = 0; k < n; k++) {
                _swap(m.probPools[k], m.currency, m.currencyTokens[k], -int256(amount), abi.encode(MODE_PAY, uint256(0)));
            }
            _mergeAll(m, m.currencyTokens, m.currencyBase);
        }

        uint256 owed = amount + (_pools[msg.sender].token0 == m.currency ? fee0 : fee1);
        uint256 balance = _balance(m.currency);
        if (balance < owed) revert ArbitrageFailed(balance, owed, "Insufficient to repay");
        _transfer(m.currency, msg.sender, owed);
    }

    // ==========================================================================
    // STRATEGIES
    // ==========================================================================

    /// @dev Holding `companyIn` company tokens from the spot pool; must end with enough currency to pay for them.
    function _runSumAboveSpot(Market storage m, uint256 companyIn) internal {
        uint256 n = m.companyTokens.length;

        // 1. Split, then sell every option's company token for its currency token.
        _split(m, m.company, m.companyBase, companyIn);
        uint256 lowest = type(uint256).max;
        for (uint256 k = 0; k < n; k++) {
            _sellAll(m.pricePools[k], m.companyTokens[k], m.currencyTokens[k]);
            uint256 bal = _balance(m.currencyTokens[k]);
            if (bal < lowest) lowest = bal;
        }

        // 2. Bring every option's balance to the merge level: sell what is above it first (that raises
        //    the currency needed to buy what is below it).
        uint256 level = _level > 0 ? _level : lowest;
        for (uint256 k = 0; k < n; k++) {
            uint256 bal = _balance(m.currencyTokens[k]);
            if (bal > level) {
                _swap(m.probPools[k], m.currencyTokens[k], m.currency, int256(bal - level), abi.encode(MODE_PAY, uint256(0)));
            }
        }
        for (uint256 k = 0; k < n; k++) {
            uint256 bal = _balance(m.currencyTokens[k]);
            if (bal < level) {
                _swap(m.probPools[k], m.currency, m.currencyTokens[k], -int256(level - bal), abi.encode(MODE_PAY, uint256(0)));
            }
        }

        // 3. Merge the full sets back into the currency.
        _mergeAll(m, m.currencyTokens, m.currencyBase);
    }

    /// @dev Holding borrowed currency; ends holding up to `companyOwed` company tokens (merged from options).
    function _runSumBelowSpot(Market storage m, uint256 companyOwed) internal {
        uint256 n = m.companyTokens.length;

        // 1. Buy exactly `companyOwed` of every option's company token. The currency is split inside the
        //    first purchase's callback; a shortfall of any option's currency token is bought there too.
        for (uint256 k = 0; k < n; k++) {
            _swap(m.pricePools[k], m.currencyTokens[k], m.companyTokens[k], -int256(companyOwed), abi.encode(MODE_PRICE_BUY, k));
        }

        // 2. Sell the currency tokens that were not needed.
        for (uint256 k = 0; k < n; k++) {
            _sellAll(m.probPools[k], m.currencyTokens[k], m.currency);
        }

        // 3. Merge the full sets back into the company token.
        _mergeAll(m, m.companyTokens, m.companyBase);
    }

    // ==========================================================================
    // HELPERS
    // ==========================================================================

    function _begin(uint256 marketId, uint256 level) private returns (Market storage m) {
        require(!_executing, "Reentrant");
        m = _markets[marketId];
        if (!m.active) revert MarketInactive(marketId);
        _executing = true;
        _marketId = marketId;
        _level = level;
        _splitDone = false;
    }

    /// @dev Borrow `amount` of the market's currency from its flash pool; the work happens in the callback.
    function _flash(Market storage m, uint256 amount, uint8 mode) private {
        bool currencyIsToken0 = _pools[m.flashPool].token0 == m.currency;
        IUniswapV3PoolMinimal(m.flashPool).flash(
            address(this), currencyIsToken0 ? amount : 0, currencyIsToken0 ? 0 : amount, abi.encode(mode, amount)
        );
    }

    /// @dev Checks the profit, sends everything to the treasury and clears the run context.
    function _finish(Market storage m, uint256 currencyBefore, uint256 minProfit) private returns (uint256 profit) {
        uint256 currencyAfter = _balance(m.currency);
        if (currencyAfter < currencyBefore + minProfit) {
            revert ArbitrageFailed(currencyAfter, currencyBefore + minProfit, "Profit below minimum");
        }
        profit = currencyAfter - currencyBefore;

        _sweep(m.currency);
        _sweep(m.company);
        uint256 n = m.companyTokens.length;
        for (uint256 k = 0; k < n; k++) {
            _sweep(m.companyTokens[k]);
            _sweep(m.currencyTokens[k]);
        }

        _executing = false;
        _level = 0;
        _companyAmount = 0;
        _splitDone = false;
    }

    function _split(Market storage m, address token, address base, uint256 amount) private {
        if (amount == 0) return;
        _approve(token, address(futarchyRouter), amount);
        futarchyRouter.splitPosition(m.proposal, base, amount);
    }

    /// @dev Merges as many full sets of `tokens` as are held.
    function _mergeAll(Market storage m, address[] storage tokens, address base) private {
        uint256 n = tokens.length;
        uint256 amount = type(uint256).max;
        for (uint256 k = 0; k < n; k++) {
            uint256 bal = _balance(tokens[k]);
            if (bal < amount) amount = bal;
        }
        if (amount == 0) return;
        for (uint256 k = 0; k < n; k++) {
            _approve(tokens[k], address(futarchyRouter), amount);
        }
        futarchyRouter.mergePositions(m.proposal, base, amount);
    }

    function _sellAll(address pool, address tokenIn, address tokenOut) private {
        uint256 bal = _balance(tokenIn);
        if (bal > 0) _swap(pool, tokenIn, tokenOut, int256(bal), abi.encode(MODE_PAY, uint256(0)));
    }

    /// @dev Swap straight on a pool: positive `amountSpecified` is exact input, negative exact output.
    ///      No per-swap limit: the final profit check covers it.
    function _swap(address pool, address tokenIn, address tokenOut, int256 amountSpecified, bytes memory data) private {
        bool zeroForOne = tokenIn < tokenOut;
        IUniswapV3PoolMinimal(pool).swap(
            address(this), zeroForOne, amountSpecified, zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1, data
        );
    }

    function _balance(address token) private view returns (uint256) {
        return IERC20Minimal(token).balanceOf(address(this));
    }

    function _sweep(address token) private {
        uint256 bal = _balance(token);
        if (bal > 0) _transfer(token, treasury, bal);
    }

    function _transfer(address token, address to, uint256 amount) private {
        _callToken(token, abi.encodeWithSelector(0xa9059cbb, to, amount)); // transfer(address,uint256)
    }

    function _approve(address token, address spender, uint256 amount) private {
        _callToken(token, abi.encodeWithSelector(0x095ea7b3, spender, amount)); // approve(address,uint256)
    }

    /// @dev Accepts tokens that return nothing as well as tokens that return true.
    function _callToken(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TokenCallFailed(token);
    }

    // ==========================================================================
    // OWNER
    // ==========================================================================

    /// @notice Recover any token sent to this contract by mistake.
    function recoverTokens(address token, uint256 amount) external onlyOwner {
        _transfer(token, owner, amount);
    }

    function setOperator(address newOperator) external onlyOwner {
        require(newOperator != address(0), "Invalid operator");
        emit OperatorChanged(operator, newOperator);
        operator = newOperator;
    }

    function setTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "Invalid treasury");
        emit TreasuryChanged(treasury, newTreasury);
        treasury = newTreasury;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Invalid owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
