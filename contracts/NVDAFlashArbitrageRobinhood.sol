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
 *      - Profit is always measured and paid in USDG, and `executeArbitrage` is owner-only.
 *
 *      Profit-or-revert: `executeArbitrage` reverts unless the USDG gained is at least `minProfit`. The contract
 *      holds nothing between calls: USDG profit and any leftover outcome tokens go to the owner in the same call.
 */
contract NVDAFlashArbitrageRobinhood {
    // ==========================================================================
    // CONSTANTS (Robinhood Chain, verified on-chain in the constructor)
    // ==========================================================================

    address public constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC; // 18 decimals
    address public constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168; // 6 decimals

    address public constant PROPOSAL = 0x9693989EF16C43274D0b85138BaF22F21651970a;
    address public constant YES_NVDA = 0x77B80692651F2e92Ed97eACA828dde7dcAcFcdBa;
    address public constant NO_NVDA = 0x88A914eB5b3F02B4e2d315Cc1275A8d7d659942d;
    address public constant YES_USDG = 0x5744CeC6770CBb1f20c7Fd370B3DC8940133e43A;
    address public constant NO_USDG = 0xbB42e72258217E4893dE20A42a44746c312234A6;

    address public constant SPOT_POOL = 0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3; // USDG / NVDA, fee 500
    address public constant YES_POOL = 0xba71c15c9A92a3875144Accc0416FE67D898b77C; // YES_USDG / YES_NVDA, fee 500
    address public constant NO_POOL = 0x2616fBb93e1b3283d2a14760768D5Ec2ec352c90; // NO_NVDA / NO_USDG, fee 500

    IFutarchyRouter public constant futarchyRouter = IFutarchyRouter(0x7834bB7f4724393043701B2A944feaE0496e00AD);

    uint160 private constant MIN_SQRT_RATIO = 4295128739;
    uint160 private constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    uint8 private constant MODE_PAY = 0; // plain swap: pay what the pool asks for
    uint8 private constant MODE_SPOT_SPLIT = 1; // flash swap on the spot pool, strategy SPOT_SPLIT
    uint8 private constant MODE_MERGE_SPOT = 2; // flash swap on the spot pool, strategy MERGE_SPOT

    // ==========================================================================
    // STATE
    // ==========================================================================

    address public owner;
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

    error NotOwner();
    error NotExecuting();
    error UnknownPool(address pool);
    error PoolMismatch(address pool);
    error ArbitrageFailed(uint256 balanceAfter, uint256 required, string reason);
    error TokenCallFailed(address token);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ==========================================================================
    // CONSTRUCTOR
    // ==========================================================================

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);

        // The token order of each pool is hardcoded below. Refuse to deploy if the chain disagrees.
        _checkPool(SPOT_POOL, USDG, NVDA);
        _checkPool(YES_POOL, YES_USDG, YES_NVDA);
        _checkPool(NO_POOL, NO_NVDA, NO_USDG);
    }

    function _checkPool(address pool, address token0, address token1) private view {
        IUniswapV3PoolMinimal p = IUniswapV3PoolMinimal(pool);
        if (p.token0() != token0 || p.token1() != token1 || p.fee() != 500) revert PoolMismatch(pool);
    }

    // ==========================================================================
    // EXTERNAL FUNCTIONS
    // ==========================================================================

    /**
     * @notice Run one arbitrage. Reverts unless it nets at least `minProfit` USDG.
     * @param nvdaAmount NVDA (18 decimals) taken from the spot pool: bought for SPOT_SPLIT, sold for MERGE_SPOT.
     * @param direction SPOT_SPLIT (0) when both conditional prices are above spot, MERGE_SPOT (1) when below.
     * @param minProfit Minimum USDG profit (6 decimals).
     * @return profit USDG sent to the owner.
     */
    function executeArbitrage(uint256 nvdaAmount, ArbitrageDirection direction, uint256 minProfit)
        external
        onlyOwner
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

        // Hold nothing between calls: profit and any unmatched outcome tokens go to the owner.
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
            (token0, token1) = (YES_USDG, YES_NVDA);
        } else if (msg.sender == NO_POOL) {
            (token0, token1) = (NO_NVDA, NO_USDG);
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
        if (bal > 0) _transfer(token, owner, bal);
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

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Invalid owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
