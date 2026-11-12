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
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

interface IFutarchyProposalMinimal {
    function collateralToken1() external view returns (address);
    function collateralToken2() external view returns (address);
    function wrappedOutcome(uint256 index) external view returns (address wrapped1155, bytes memory data);
}

interface IFutarchyRouter {
    function splitPosition(address proposal, address collateralToken, uint256 amount) external;
    function mergePositions(address proposal, address collateralToken, uint256 amount) external;
}

// =============================================================================
// NVDA FLASH ARBITRAGE - ROBINHOOD CHAIN (4663)
// =============================================================================

/**
 * @title NVDAFlashArbitrageRobinhood
 * @notice Keeps the YES and NO conditional NVDA/USDG pools of one futarchy proposal consistent with the
 *         NVDA/USDG spot pool. Port of VLRFlashArbitrageV3 with the same two strategies:
 *
 *         SPOT_SPLIT (both conditional prices above spot): get NVDA at spot, split it into YES_NVDA + NO_NVDA,
 *         sell each in its conditional pool, merge the YES_USDG + NO_USDG back into USDG, pay for the NVDA.
 *
 *         MERGE_SPOT (both conditional prices below spot): sell NVDA at spot for USDG, split the USDG into
 *         YES_USDG + NO_USDG, buy YES_NVDA and NO_NVDA, merge them back into NVDA, deliver the NVDA sold.
 *
 * @dev Differences from the template, all forced by the chain:
 *      - There is no Balancer vault on Robinhood Chain. The working capital comes from a flash swap on the spot
 *        pool itself: the pool sends the output first and is paid inside `uniswapV3SwapCallback`.
 *      - Pools are called directly (no Universal Router, no Permit2), so the contract never gives a standing
 *        approval to anything. The only approvals are exact amounts to the FutarchyRouter, consumed in the same call.
 *      - NVDA has 18 decimals and USDG 6. Outcome tokens have the decimals of their collateral. No price is
 *        computed on-chain: the only check is the realised USDG profit.
 *      - Profit is always measured in USDG and paid to the treasury. `executeArbitrage` can only be called by
        the operator (the bot's own key, which holds nothing but gas) or the owner.
      - The market (proposal and its two conditional pools) is a constructor argument, so a new market for the
        same NVDA/USDG pair needs a new deployment but no source change. Token order in each pool is read
        from the pool.
 *
 *      Profit-or-revert: `executeArbitrage` reverts unless the USDG gained is at least `minProfit`. The contract
 *      holds nothing between calls: USDG profit and any leftover outcome tokens go to the treasury in the same call.
 */
contract NVDAFlashArbitrageRobinhood {
    // ==========================================================================
    // CONSTANTS (Robinhood Chain) AND THE MARKET (set and checked in the constructor)
    // ==========================================================================

    address public constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC; // 18 decimals
    address public constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168; // 6 decimals
    address public constant SPOT_POOL = 0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3; // USDG / NVDA, fee 500

    address public immutable PROPOSAL;
    address public immutable YES_NVDA;
    address public immutable NO_NVDA;
    address public immutable YES_USDG;
    address public immutable NO_USDG;
    address public immutable YES_POOL; // YES_NVDA / YES_USDG in either order, fee 500
    address public immutable NO_POOL; // NO_NVDA / NO_USDG in either order, fee 500

    IFutarchyRouter public constant futarchyRouter = IFutarchyRouter(0x7834bB7f4724393043701B2A944feaE0496e00AD);

    uint160 private constant MIN_SQRT_RATIO = 4295128739;
    uint160 private constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    uint8 private constant MODE_PAY = 0; // plain swap: pay what the pool asks for
    uint8 private constant MODE_SPOT_SPLIT = 1; // flash swap on the spot pool, strategy SPOT_SPLIT
    uint8 private constant MODE_MERGE_SPOT = 2; // flash swap on the spot pool, strategy MERGE_SPOT

    // ==========================================================================
    // STATE
    // ==========================================================================

    address public owner; // sets the operator and the treasury, recovers stray tokens
    address public operator; // the bot: may only call executeArbitrage
    address public treasury; // receives the profit
    bool private _executing;

    enum ArbitrageDirection {
        SPOT_SPLIT,
        MERGE_SPOT
    }

    // ==========================================================================
    // EVENTS & ERRORS
    // ==========================================================================

    event ArbitrageExecuted(address indexed caller, ArbitrageDirection direction, uint256 nvdaAmount, uint256 profitUsdg);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OperatorChanged(address indexed previousOperator, address indexed newOperator);
    event TreasuryChanged(address indexed previousTreasury, address indexed newTreasury);

    error NotOwner();
    error NotOperator();
    error NotExecuting();
    error UnknownPool(address pool);
    error PoolMismatch(address pool);
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

    /**
     * @param proposal The futarchy proposal (collateral 1 must be NVDA, collateral 2 USDG).
     * @param yesPool The YES_NVDA / YES_USDG pool, fee 500.
     * @param noPool The NO_NVDA / NO_USDG pool, fee 500.
     * @param operator_ The bot key allowed to call executeArbitrage.
     * @param treasury_ Where the profit goes.
     */
    constructor(address proposal, address yesPool, address noPool, address operator_, address treasury_) {
        require(operator_ != address(0) && treasury_ != address(0), "Zero address");
        owner = msg.sender;
        operator = operator_;
        treasury = treasury_;
        emit OwnershipTransferred(address(0), msg.sender);
        emit OperatorChanged(address(0), operator_);
        emit TreasuryChanged(address(0), treasury_);

        IFutarchyProposalMinimal p = IFutarchyProposalMinimal(proposal);
        if (p.collateralToken1() != NVDA || p.collateralToken2() != USDG) revert PoolMismatch(proposal);
        PROPOSAL = proposal;
        (address yesNvda,) = p.wrappedOutcome(0);
        (address noNvda,) = p.wrappedOutcome(1);
        (address yesUsdg,) = p.wrappedOutcome(2);
        (address noUsdg,) = p.wrappedOutcome(3);
        (YES_NVDA, NO_NVDA, YES_USDG, NO_USDG) = (yesNvda, noNvda, yesUsdg, noUsdg);

        // Refuse to deploy unless each pool trades exactly the expected pair at fee 500.
        _checkPool(SPOT_POOL, USDG, NVDA);
        _checkPool(yesPool, yesNvda, yesUsdg);
        _checkPool(noPool, noNvda, noUsdg);
        YES_POOL = yesPool;
        NO_POOL = noPool;
    }

    function _checkPool(address pool, address tokenA, address tokenB) private view {
        IUniswapV3PoolMinimal p = IUniswapV3PoolMinimal(pool);
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        if (p.token0() != t0 || p.token1() != t1 || p.fee() != 500) revert PoolMismatch(pool);
    }

    // ==========================================================================
    // EXTERNAL FUNCTIONS
    // ==========================================================================

    /**
     * @notice Run one arbitrage. Reverts unless it nets at least `minProfit` USDG.
     * @param nvdaAmount NVDA (18 decimals) taken from the spot pool: bought for SPOT_SPLIT, sold for MERGE_SPOT.
     * @param direction SPOT_SPLIT (0) when both conditional prices are above spot, MERGE_SPOT (1) when below.
     * @param minProfit Minimum USDG profit (6 decimals).
     * @return profit USDG sent to the treasury.
     */
    function executeArbitrage(uint256 nvdaAmount, ArbitrageDirection direction, uint256 minProfit)
        external
        onlyOperator
        returns (uint256 profit)
    {
        require(!_executing, "Reentrant");
        require(nvdaAmount > 0 && nvdaAmount <= uint256(type(int256).max), "Bad amount");
        _executing = true;

        uint256 usdgBefore = _balance(USDG);

        if (direction == ArbitrageDirection.SPOT_SPLIT) {
            // Buy exactly `nvdaAmount` NVDA (token1) with USDG (token0); the USDG is paid in the callback.
            IUniswapV3PoolMinimal(SPOT_POOL).swap(
                address(this), true, -int256(nvdaAmount), MIN_SQRT_RATIO + 1, abi.encode(MODE_SPOT_SPLIT)
            );
        } else {
            // Sell exactly `nvdaAmount` NVDA (token1) for USDG (token0); the NVDA is delivered in the callback.
            IUniswapV3PoolMinimal(SPOT_POOL).swap(
                address(this), false, int256(nvdaAmount), MAX_SQRT_RATIO - 1, abi.encode(MODE_MERGE_SPOT)
            );
            // The merge returned more NVDA than was owed: sell the surplus so that profit is in USDG.
            uint256 surplus = _balance(NVDA);
            if (surplus > 0) _swapExactIn(SPOT_POOL, NVDA, USDG, surplus);
        }

        uint256 usdgAfter = _balance(USDG);
        if (usdgAfter < usdgBefore + minProfit) {
            revert ArbitrageFailed(usdgAfter, usdgBefore + minProfit, "Profit below minimum");
        }
        profit = usdgAfter - usdgBefore;

        // Hold nothing between calls: profit and any unmatched outcome tokens go to the treasury.
        _sweepAll(USDG);
        _sweepAll(NVDA);
        _sweepAll(YES_USDG);
        _sweepAll(NO_USDG);
        _sweepAll(YES_NVDA);
        _sweepAll(NO_NVDA);

        _executing = false;
        emit ArbitrageExecuted(msg.sender, direction, nvdaAmount, profit);
    }

    // ==========================================================================
    // UNISWAP V3 CALLBACK
    // ==========================================================================

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        if (!_executing) revert NotExecuting();

        address token0;
        address token1;
        if (msg.sender == SPOT_POOL) {
            (token0, token1) = (USDG, NVDA);
        } else if (msg.sender == YES_POOL) {
            (token0, token1) = YES_NVDA < YES_USDG ? (YES_NVDA, YES_USDG) : (YES_USDG, YES_NVDA);
        } else if (msg.sender == NO_POOL) {
            (token0, token1) = NO_NVDA < NO_USDG ? (NO_NVDA, NO_USDG) : (NO_USDG, NO_NVDA);
        } else {
            revert UnknownPool(msg.sender);
        }

        uint8 mode = abi.decode(data, (uint8));
        if (mode != MODE_PAY) {
            if (msg.sender != SPOT_POOL) revert UnknownPool(msg.sender);
            if (mode == MODE_SPOT_SPLIT) {
                // Received NVDA (token1), owe USDG (token0).
                _executeSpotSplit(uint256(-amount1Delta));
            } else {
                // Received USDG (token0), owe NVDA (token1).
                _executeMergeSpot(uint256(-amount0Delta));
            }
        }

        (address owedToken, uint256 owed) =
            amount0Delta > 0 ? (token0, uint256(amount0Delta)) : (token1, uint256(amount1Delta));
        uint256 have = _balance(owedToken);
        if (have < owed) revert ArbitrageFailed(have, owed, "Insufficient to repay");
        _transfer(owedToken, msg.sender, owed);
    }

    // ==========================================================================
    // STRATEGY: SPOT_SPLIT
    // ==========================================================================

    function _executeSpotSplit(uint256 nvdaIn) internal {
        // 1. Split NVDA -> YES_NVDA + NO_NVDA
        _approve(NVDA, address(futarchyRouter), nvdaIn);
        futarchyRouter.splitPosition(PROPOSAL, NVDA, nvdaIn);

        // 2. Sell YES_NVDA -> YES_USDG and NO_NVDA -> NO_USDG
        _swapExactIn(YES_POOL, YES_NVDA, YES_USDG, _balance(YES_NVDA));
        _swapExactIn(NO_POOL, NO_NVDA, NO_USDG, _balance(NO_NVDA));

        // 3. Merge YES_USDG + NO_USDG -> USDG
        _merge(YES_USDG, NO_USDG, USDG);
    }

    // ==========================================================================
    // STRATEGY: MERGE_SPOT
    // ==========================================================================

    function _executeMergeSpot(uint256 usdgIn) internal {
        // 1. Split USDG -> YES_USDG + NO_USDG
        _approve(USDG, address(futarchyRouter), usdgIn);
        futarchyRouter.splitPosition(PROPOSAL, USDG, usdgIn);

        // 2. Buy YES_NVDA with YES_USDG and NO_NVDA with NO_USDG
        _swapExactIn(YES_POOL, YES_USDG, YES_NVDA, _balance(YES_USDG));
        _swapExactIn(NO_POOL, NO_USDG, NO_NVDA, _balance(NO_USDG));

        // 3. Merge YES_NVDA + NO_NVDA -> NVDA
        _merge(YES_NVDA, NO_NVDA, NVDA);
    }

    // ==========================================================================
    // HELPERS
    // ==========================================================================

    function _merge(address yesToken, address noToken, address collateral) internal {
        uint256 yesBal = _balance(yesToken);
        uint256 noBal = _balance(noToken);
        uint256 amount = yesBal < noBal ? yesBal : noBal;
        if (amount == 0) return;
        _approve(yesToken, address(futarchyRouter), amount);
        _approve(noToken, address(futarchyRouter), amount);
        futarchyRouter.mergePositions(PROPOSAL, collateral, amount);
    }

    /// @dev Exact-input swap straight on a pool. No per-swap minimum: the final profit check covers it.
    function _swapExactIn(address pool, address tokenIn, address tokenOut, uint256 amountIn) internal {
        if (amountIn == 0) return;
        bool zeroForOne = tokenIn < tokenOut;
        IUniswapV3PoolMinimal(pool).swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            abi.encode(MODE_PAY)
        );
    }

    function _balance(address token) internal view returns (uint256) {
        return IERC20Minimal(token).balanceOf(address(this));
    }

    function _sweepAll(address token) internal {
        uint256 bal = _balance(token);
        if (bal > 0) _transfer(token, treasury, bal);
    }

    function _transfer(address token, address to, uint256 amount) internal {
        _callToken(token, abi.encodeWithSelector(0xa9059cbb, to, amount)); // transfer(address,uint256)
    }

    function _approve(address token, address spender, uint256 amount) internal {
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

    /// @notice Recover native ETH forced into this contract (it has no payable entry point).
    function recoverNative() external onlyOwner {
        (bool ok,) = owner.call{value: address(this).balance}("");
        require(ok, "Native transfer failed");
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
