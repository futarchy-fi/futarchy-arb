// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// =============================================================================
// BALANCER V3 VAULT INTERFACE
// =============================================================================

interface IBalancerV3Vault {
    function unlock(bytes calldata data) external returns (bytes memory result);
    function sendTo(IERC20 token, address to, uint256 amount) external;
    function settle(IERC20 token, uint256 amount) external returns (uint256 credit);
}

// =============================================================================
// UNIV2 PAIR INTERFACE (DXswap / Honeyswap)
// =============================================================================

interface IUniV2Pair {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
    function token0() external view returns (address);
}

// =============================================================================
// ERC4626 VAULT INTERFACE (sDAI)
// =============================================================================

interface IERC4626 {
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
}

// =============================================================================
// FUTARCHY INTERFACES
// =============================================================================

interface IFutarchyProposal {
    function collateralToken1() external view returns (IERC20);
    function collateralToken2() external view returns (IERC20);
    function wrappedOutcome(uint256 index) external view returns (IERC20 wrapped1155, bytes memory data);
}

interface IAlgebraFactory {
    function poolByPair(address tokenA, address tokenB) external view returns (address pool);
}

interface IAlgebraPool {
    function globalState() external view returns (uint160 price, int24 tick, uint16, uint16, uint8, uint8, bool);
    function liquidity() external view returns (uint128);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IAlgebraSwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 limitSqrtPrice;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IFutarchyRouter {
    function splitPosition(address proposal, address collateralToken, uint256 amount) external;
    function mergePositions(address proposal, address collateralToken, uint256 amount) external;
}

// =============================================================================
// PNK/sDAI FLASH ARBITRAGE CONTRACT
// =============================================================================

/**
 * @title PNKFlashArbitrage
 * @notice Permissionless flash loan arbitrage for PNK/sDAI futarchy markets on Gnosis Chain.
 * @dev Route: WETH ↔ PNK (DXswap V2) and WETH ↔ WXDAI (Honeyswap) ↔ sDAI (ERC4626 vault).
 *      Always flash borrows WETH from Balancer V3. No Balancer V2 dependency.
 */
contract PNKFlashArbitrage is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ==========================================================================
    // CONSTANTS — UniV2 fee parameters
    // ==========================================================================

    /// @dev DXswap V2: 0.25% fee → feeNum=9975, feeDenom=10000
    uint256 constant DX_FEE_NUM = 9975;
    uint256 constant DX_FEE_DENOM = 10000;

    /// @dev Honeyswap: 0.3% fee → feeNum=997, feeDenom=1000
    uint256 constant HONEY_FEE_NUM = 997;
    uint256 constant HONEY_FEE_DENOM = 1000;

    // ==========================================================================
    // STATE VARIABLES
    // ==========================================================================

    IBalancerV3Vault public immutable balancerVault;
    IAlgebraSwapRouter public immutable swaprRouter;
    IFutarchyRouter public immutable futarchyRouter;
    IAlgebraFactory public immutable algebraFactory;

    address public immutable pnkToken;
    address public immutable sdaiToken;
    address public immutable wethToken;
    address public immutable wxdaiToken;
    address public immutable dxswapPair;       // PNK/WETH (DXswap V2)
    address public immutable wethWxdaiPair;    // WETH/WXDAI (Honeyswap)

    address public admin;

    // Transient state for flash loan callback
    address private _activeProposal;
    ArbitrageDirection private _activeDirection;
    uint256 private _minProfit;
    address private _profitRecipient;
    ArbitrageResult private _lastResult;

    // ==========================================================================
    // STRUCTS & ENUMS
    // ==========================================================================

    struct ProposalInfo {
        address proposal;
        address collateralToken1;
        address collateralToken2;
        address yesPnk;
        address noPnk;
        address yesSdai;
        address noSdai;
        address yesPool;
        address noPool;
        bool isValid;
    }

    enum ArbitrageDirection {
        SPOT_SPLIT,   // Split PNK → sell outcome tokens → merge sDAI → convert back
        MERGE_SPOT    // Buy outcome tokens → merge to PNK → convert back
    }

    struct ArbitrageResult {
        bool success;
        uint256 profit;           // Profit in WETH
        uint256 leftoverYesPnk;
        uint256 leftoverNoPnk;
        uint256 leftoverYesSdai;
        uint256 leftoverNoSdai;
        uint256 leftoverPnk;
        uint256 leftoverSdai;
    }

    error ArbitrageFailed(uint256 balanceAfter, uint256 borrowAmount, string reason);

    // ==========================================================================
    // EVENTS
    // ==========================================================================

    event ArbitrageExecuted(
        address indexed caller,
        address indexed proposal,
        ArbitrageDirection direction,
        uint256 borrowAmount,
        uint256 profit
    );

    event AdminChanged(address indexed oldAdmin, address indexed newAdmin);

    // ==========================================================================
    // CONSTRUCTOR
    // ==========================================================================

    constructor(
        address _balancerVault,
        address _swaprRouter,
        address _futarchyRouter,
        address _algebraFactory,
        address _pnkToken,
        address _sdaiToken,
        address _wethToken,
        address _wxdaiToken,
        address _dxswapPair,
        address _wethWxdaiPair
    ) {
        balancerVault = IBalancerV3Vault(_balancerVault);
        swaprRouter = IAlgebraSwapRouter(_swaprRouter);
        futarchyRouter = IFutarchyRouter(_futarchyRouter);
        algebraFactory = IAlgebraFactory(_algebraFactory);
        pnkToken = _pnkToken;
        sdaiToken = _sdaiToken;
        wethToken = _wethToken;
        wxdaiToken = _wxdaiToken;
        dxswapPair = _dxswapPair;
        wethWxdaiPair = _wethWxdaiPair;
        admin = msg.sender;
    }

    // ==========================================================================
    // VIEW FUNCTIONS
    // ==========================================================================

    function loadProposal(address proposalAddress) public view returns (ProposalInfo memory info) {
        IFutarchyProposal proposal = IFutarchyProposal(proposalAddress);

        info.proposal = proposalAddress;
        info.collateralToken1 = address(proposal.collateralToken1());
        info.collateralToken2 = address(proposal.collateralToken2());

        info.isValid = (info.collateralToken1 == pnkToken && info.collateralToken2 == sdaiToken)
                    || (info.collateralToken1 == sdaiToken && info.collateralToken2 == pnkToken);
        if (!info.isValid) return info;

        if (info.collateralToken1 == pnkToken) {
            // token1=PNK: indices 0,1 are PNK outcomes; 2,3 are sDAI outcomes
            (IERC20 yesPnk,) = proposal.wrappedOutcome(0);
            (IERC20 noPnk,)  = proposal.wrappedOutcome(1);
            (IERC20 yesSdai,) = proposal.wrappedOutcome(2);
            (IERC20 noSdai,)  = proposal.wrappedOutcome(3);
            info.yesPnk  = address(yesPnk);
            info.noPnk   = address(noPnk);
            info.yesSdai = address(yesSdai);
            info.noSdai  = address(noSdai);
        } else {
            // token1=sDAI: indices 0,1 are sDAI outcomes; 2,3 are PNK outcomes
            (IERC20 yesSdai,) = proposal.wrappedOutcome(0);
            (IERC20 noSdai,)  = proposal.wrappedOutcome(1);
            (IERC20 yesPnk,)  = proposal.wrappedOutcome(2);
            (IERC20 noPnk,)   = proposal.wrappedOutcome(3);
            info.yesSdai = address(yesSdai);
            info.noSdai  = address(noSdai);
            info.yesPnk  = address(yesPnk);
            info.noPnk   = address(noPnk);
        }

        info.yesPool = algebraFactory.poolByPair(info.yesPnk, info.yesSdai);
        info.noPool  = algebraFactory.poolByPair(info.noPnk, info.noSdai);
    }

    // ==========================================================================
    // PERMISSIONLESS FLASH LOAN EXECUTION
    // ==========================================================================

    /**
     * @notice Execute flash arbitrage — anyone can call.
     * @param proposalAddress Futarchy proposal to arbitrage
     * @param borrowAmount Amount of WETH to flash borrow
     * @param direction Arbitrage strategy (SPOT_SPLIT or MERGE_SPOT)
     * @param minProfit Minimum profit in WETH (MEV protection)
     */
    function executeArbitrage(
        address proposalAddress,
        uint256 borrowAmount,
        ArbitrageDirection direction,
        uint256 minProfit
    ) external nonReentrant returns (ArbitrageResult memory result) {
        _activeProposal = proposalAddress;
        _activeDirection = direction;
        _minProfit = minProfit;
        _profitRecipient = msg.sender;

        bytes memory callbackData = abi.encodeWithSelector(
            this.onUnlock.selector,
            borrowAmount
        );

        balancerVault.unlock(callbackData);

        result = _lastResult;
        _activeProposal = address(0);

        return result;
    }

    /**
     * @notice Balancer V3 callback — called by Vault during unlock().
     */
    function onUnlock(uint256 borrowAmount) external returns (bytes memory) {
        require(msg.sender == address(balancerVault), "Only Balancer Vault");

        // 1. Get WETH from vault (flash loan)
        balancerVault.sendTo(IERC20(wethToken), address(this), borrowAmount);

        // 2. Load proposal and execute strategy
        ProposalInfo memory info = loadProposal(_activeProposal);
        require(info.isValid, "Invalid proposal");

        if (_activeDirection == ArbitrageDirection.SPOT_SPLIT) {
            _executeSpotSplit(info, borrowAmount);
        } else {
            _executeMergeSpot(info, borrowAmount);
        }

        // 3. Calculate profit in WETH
        uint256 balanceAfter = IERC20(wethToken).balanceOf(address(this));

        if (balanceAfter < borrowAmount) {
            revert ArbitrageFailed(balanceAfter, borrowAmount, "Insufficient to repay");
        }

        uint256 profit = balanceAfter - borrowAmount;

        if (profit < _minProfit) {
            revert ArbitrageFailed(balanceAfter, borrowAmount, "Profit below minimum");
        }

        // 4. Repay flash loan
        IERC20(wethToken).transfer(address(balancerVault), borrowAmount);
        balancerVault.settle(IERC20(wethToken), borrowAmount);

        // 5. Send WETH profit to caller
        if (profit > 0) {
            IERC20(wethToken).safeTransfer(_profitRecipient, profit);
        }

        // 6. Send all leftover tokens to caller
        (
            uint256 sentYesPnk,
            uint256 sentNoPnk,
            uint256 sentYesSdai,
            uint256 sentNoSdai,
            uint256 sentPnk,
            uint256 sentSdai
        ) = _sendAllLeftovers(info, _profitRecipient);

        // 7. Build result
        ArbitrageResult memory result = ArbitrageResult({
            success: true,
            profit: profit,
            leftoverYesPnk: sentYesPnk,
            leftoverNoPnk: sentNoPnk,
            leftoverYesSdai: sentYesSdai,
            leftoverNoSdai: sentNoSdai,
            leftoverPnk: sentPnk,
            leftoverSdai: sentSdai
        });

        _lastResult = result;

        emit ArbitrageExecuted(
            _profitRecipient,
            _activeProposal,
            _activeDirection,
            borrowAmount,
            profit
        );

        return abi.encode(result);
    }

    // ==========================================================================
    // ARBITRAGE STRATEGIES
    // ==========================================================================

    /**
     * @dev SPOT_SPLIT: WETH → PNK → split → sell outcomes → merge sDAI → WXDAI → WETH
     *      Profitable when outcome PNK prices > spot PNK price.
     */
    function _executeSpotSplit(ProposalInfo memory info, uint256 wethAmount) internal {
        // 1. WETH → PNK via DXswap V2
        uint256 pnkAmount = _swapViaPair(dxswapPair, wethToken, wethAmount, DX_FEE_NUM, DX_FEE_DENOM);

        // 2. Split PNK → YES_PNK + NO_PNK
        IERC20(pnkToken).approve(address(futarchyRouter), pnkAmount);
        futarchyRouter.splitPosition(info.proposal, pnkToken, pnkAmount);

        // 3. Sell YES_PNK → YES_SDAI
        uint256 yesPnkBal = IERC20(info.yesPnk).balanceOf(address(this));
        if (yesPnkBal > 0 && info.yesPool != address(0)) {
            _swapOnPool(info.yesPool, info.yesPnk, yesPnkBal);
        }

        // 4. Sell NO_PNK → NO_SDAI
        uint256 noPnkBal = IERC20(info.noPnk).balanceOf(address(this));
        if (noPnkBal > 0 && info.noPool != address(0)) {
            _swapOnPool(info.noPool, info.noPnk, noPnkBal);
        }

        // 5. Merge YES_SDAI + NO_SDAI → sDAI
        uint256 yesSdaiBal = IERC20(info.yesSdai).balanceOf(address(this));
        uint256 noSdaiBal  = IERC20(info.noSdai).balanceOf(address(this));
        uint256 mergeSdaiAmt = yesSdaiBal < noSdaiBal ? yesSdaiBal : noSdaiBal;

        if (mergeSdaiAmt > 0) {
            IERC20(info.yesSdai).approve(address(futarchyRouter), mergeSdaiAmt);
            IERC20(info.noSdai).approve(address(futarchyRouter), mergeSdaiAmt);
            futarchyRouter.mergePositions(info.proposal, sdaiToken, mergeSdaiAmt);
        }

        // 6. sDAI → WXDAI (ERC4626 redeem, zero slippage)
        uint256 sdaiBal = IERC20(sdaiToken).balanceOf(address(this));
        if (sdaiBal > 0) {
            IERC4626(sdaiToken).redeem(sdaiBal, address(this), address(this));
        }

        // 7. WXDAI → WETH via Honeyswap
        uint256 wxdaiBal = IERC20(wxdaiToken).balanceOf(address(this));
        if (wxdaiBal > 0) {
            _swapViaPair(wethWxdaiPair, wxdaiToken, wxdaiBal, HONEY_FEE_NUM, HONEY_FEE_DENOM);
        }
    }

    /**
     * @dev MERGE_SPOT: WETH → WXDAI → sDAI → split → buy outcomes → merge PNK → WETH
     *      Profitable when spot PNK price > outcome PNK prices.
     */
    function _executeMergeSpot(ProposalInfo memory info, uint256 wethAmount) internal {
        // 1. WETH → WXDAI via Honeyswap
        uint256 wxdaiAmount = _swapViaPair(wethWxdaiPair, wethToken, wethAmount, HONEY_FEE_NUM, HONEY_FEE_DENOM);

        // 2. WXDAI → sDAI (ERC4626 deposit, zero slippage)
        IERC20(wxdaiToken).approve(sdaiToken, wxdaiAmount);
        uint256 sdaiAmount = IERC4626(sdaiToken).deposit(wxdaiAmount, address(this));

        // 3. Split sDAI → YES_SDAI + NO_SDAI
        IERC20(sdaiToken).approve(address(futarchyRouter), sdaiAmount);
        futarchyRouter.splitPosition(info.proposal, sdaiToken, sdaiAmount);

        // 4. Sell YES_SDAI → YES_PNK (buy YES_PNK)
        uint256 yesSdaiBal = IERC20(info.yesSdai).balanceOf(address(this));
        if (yesSdaiBal > 0 && info.yesPool != address(0)) {
            _swapOnPool(info.yesPool, info.yesSdai, yesSdaiBal);
        }

        // 5. Sell NO_SDAI → NO_PNK (buy NO_PNK)
        uint256 noSdaiBal = IERC20(info.noSdai).balanceOf(address(this));
        if (noSdaiBal > 0 && info.noPool != address(0)) {
            _swapOnPool(info.noPool, info.noSdai, noSdaiBal);
        }

        // 6. Merge YES_PNK + NO_PNK → PNK
        uint256 yesPnkBal = IERC20(info.yesPnk).balanceOf(address(this));
        uint256 noPnkBal  = IERC20(info.noPnk).balanceOf(address(this));
        uint256 mergePnkAmt = yesPnkBal < noPnkBal ? yesPnkBal : noPnkBal;

        if (mergePnkAmt > 0) {
            IERC20(info.yesPnk).approve(address(futarchyRouter), mergePnkAmt);
            IERC20(info.noPnk).approve(address(futarchyRouter), mergePnkAmt);
            futarchyRouter.mergePositions(info.proposal, pnkToken, mergePnkAmt);
        }

        // 7. PNK → WETH via DXswap V2
        uint256 pnkBal = IERC20(pnkToken).balanceOf(address(this));
        if (pnkBal > 0) {
            _swapViaPair(dxswapPair, pnkToken, pnkBal, DX_FEE_NUM, DX_FEE_DENOM);
        }
    }

    // ==========================================================================
    // SWAP HELPERS
    // ==========================================================================

    /**
     * @dev Generic UniV2 pair swap. Handles both DXswap (0.25%) and Honeyswap (0.3%).
     * @param pair     The UniV2 pair contract address
     * @param tokenIn  Token being sold
     * @param amountIn Amount of tokenIn to sell
     * @param feeNum   Fee numerator (9975 for DXswap, 997 for Honeyswap)
     * @param feeDenom Fee denominator (10000 for DXswap, 1000 for Honeyswap)
     */
    function _swapViaPair(
        address pair,
        address tokenIn,
        uint256 amountIn,
        uint256 feeNum,
        uint256 feeDenom
    ) internal returns (uint256 amountOut) {
        address token0 = IUniV2Pair(pair).token0();
        (uint112 reserve0, uint112 reserve1,) = IUniV2Pair(pair).getReserves();

        bool isToken0 = tokenIn == token0;
        (uint256 reserveIn, uint256 reserveOut) = isToken0
            ? (uint256(reserve0), uint256(reserve1))
            : (uint256(reserve1), uint256(reserve0));

        uint256 amountInWithFee = amountIn * feeNum;
        amountOut = (amountInWithFee * reserveOut) / (reserveIn * feeDenom + amountInWithFee);

        IERC20(tokenIn).safeTransfer(pair, amountIn);
        if (isToken0) {
            IUniV2Pair(pair).swap(0, amountOut, address(this), "");
        } else {
            IUniV2Pair(pair).swap(amountOut, 0, address(this), "");
        }
    }

    /**
     * @dev Swap on an Algebra (Swapr) concentrated liquidity pool via router.
     */
    function _swapOnPool(
        address pool,
        address tokenIn,
        uint256 amountIn
    ) internal returns (uint256 amountOut) {
        if (pool == address(0) || amountIn == 0) return 0;

        IAlgebraPool algebraPool = IAlgebraPool(pool);
        address token0 = algebraPool.token0();
        address token1 = algebraPool.token1();
        address tokenOut = tokenIn == token0 ? token1 : token0;

        IERC20(tokenIn).approve(address(swaprRouter), amountIn);

        IAlgebraSwapRouter.ExactInputSingleParams memory params =
            IAlgebraSwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: amountIn,
                amountOutMinimum: 0,
                limitSqrtPrice: 0
            });

        amountOut = swaprRouter.exactInputSingle(params);
    }

    // ==========================================================================
    // LEFTOVER TRANSFER HELPER
    // ==========================================================================

    function _sendAllLeftovers(ProposalInfo memory info, address recipient) internal
        returns (
            uint256 sentYesPnk,
            uint256 sentNoPnk,
            uint256 sentYesSdai,
            uint256 sentNoSdai,
            uint256 sentPnk,
            uint256 sentSdai
        )
    {
        sentYesPnk = IERC20(info.yesPnk).balanceOf(address(this));
        if (sentYesPnk > 0) IERC20(info.yesPnk).safeTransfer(recipient, sentYesPnk);

        sentNoPnk = IERC20(info.noPnk).balanceOf(address(this));
        if (sentNoPnk > 0) IERC20(info.noPnk).safeTransfer(recipient, sentNoPnk);

        sentYesSdai = IERC20(info.yesSdai).balanceOf(address(this));
        if (sentYesSdai > 0) IERC20(info.yesSdai).safeTransfer(recipient, sentYesSdai);

        sentNoSdai = IERC20(info.noSdai).balanceOf(address(this));
        if (sentNoSdai > 0) IERC20(info.noSdai).safeTransfer(recipient, sentNoSdai);

        sentPnk = IERC20(pnkToken).balanceOf(address(this));
        if (sentPnk > 0) IERC20(pnkToken).safeTransfer(recipient, sentPnk);

        sentSdai = IERC20(sdaiToken).balanceOf(address(this));
        if (sentSdai > 0) IERC20(sdaiToken).safeTransfer(recipient, sentSdai);

        // Also sweep WXDAI dust
        uint256 wxdaiBal = IERC20(wxdaiToken).balanceOf(address(this));
        if (wxdaiBal > 0) IERC20(wxdaiToken).safeTransfer(recipient, wxdaiBal);

        // WETH dust (beyond profit already sent)
        uint256 wethBal = IERC20(wethToken).balanceOf(address(this));
        if (wethBal > 0) IERC20(wethToken).safeTransfer(recipient, wethBal);
    }

    // ==========================================================================
    // ADMIN (Emergency Recovery Only)
    // ==========================================================================

    function transferAdmin(address newAdmin) external {
        require(msg.sender == admin, "Only admin");
        require(newAdmin != address(0), "Invalid admin");
        emit AdminChanged(admin, newAdmin);
        admin = newAdmin;
    }

    function recoverTokens(address token, uint256 amount) external {
        require(msg.sender == admin, "Only admin");
        IERC20(token).safeTransfer(admin, amount);
    }

    receive() external payable {}
}
