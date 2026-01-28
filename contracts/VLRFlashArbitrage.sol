// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// =============================================================================
// BALANCER V2 INTERFACES
// =============================================================================

interface IBalancerV2Vault {
    function flashLoan(
        address recipient,
        IERC20[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}

// =============================================================================
// UNISWAP V3 INTERFACES
// =============================================================================

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

// =============================================================================
// FUTARCHY INTERFACES
// =============================================================================

interface IFutarchyProposal {
    function collateralToken1() external view returns (IERC20);
    function collateralToken2() external view returns (IERC20);
    function wrappedOutcome(uint256 index) external view returns (IERC20 wrapped1155, bytes memory data);
}

interface IFutarchyRouter {
    function splitPosition(address proposal, address collateralToken, uint256 amount) external;
    function mergePositions(address proposal, address collateralToken, uint256 amount) external;
}

// =============================================================================
// VLR FLASH ARBITRAGE V2 (MAINNET) - BALANCER V2 FLASH LOANS
// =============================================================================

/**
 * @title VLRFlashArbitrage
 * @notice Permissionless flash arbitrage for VLR/USDS markets on Ethereum Mainnet
 * @dev Uses Balancer V2 flash loans (0% fee, 211M VLR liquidity)
 * 
 * Architecture:
 * - Flash Loans: Balancer V2 Vault (0% fee!)
 * - Outcome Swaps: Uniswap V3 (YES_VLR/YES_USDS & NO_VLR/NO_USDS pools)
 * - Repayment Swaps: Uniswap V3 SwapRouter (multi-hop via USDC)
 * 
 * Strategy SPOT_SPLIT (Profitable when MIN(YES,NO) > Spot):
 *   1. Flash borrow VLR from Balancer V2 (FREE!)
 *   2. Split VLR -> YES_VLR + NO_VLR
 *   3. Swap YES_VLR -> YES_USDS (Uniswap V3)
 *   4. Swap NO_VLR -> NO_USDS (Uniswap V3)
 *   5. Merge YES_USDS + NO_USDS -> USDS
 *   6. Swap USDS -> USDC -> VLR (Uniswap V3 multi-hop)
 *   7. Repay flash loan + keep profit
 * 
 * Strategy MERGE_SPOT (Profitable when MAX(YES,NO) < Spot):
 *   1. Flash borrow VLR from Balancer V2 (FREE!)
 *   2. Swap VLR -> USDC -> USDS (multi-hop)
 *   3. Split USDS -> YES_USDS + NO_USDS
 *   4. Swap YES_USDS -> YES_VLR (Uniswap V3)
 *   5. Swap NO_USDS -> NO_VLR (Uniswap V3)
 *   6. Merge YES_VLR + NO_VLR -> VLR
 *   7. Repay flash loan + keep profit
 */
contract VLRFlashArbitrage is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ==========================================================================
    // CONSTANTS (Verified Mainnet Addresses)
    // ==========================================================================

    // Tokens
    address public constant VLR = 0x4e107a0000DB66f0E9Fd2039288Bf811dD1f9c74;
    address public constant USDS = 0xdC035D45d973E3EC169d2276DDab16f1e407384F;
    address public constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    // Proposal & Outcome Tokens
    address public constant PROPOSAL = 0x4e018f1D8b93B91a0Ce186874eDb53CB6fFfCa62;
    address public constant YES_VLR = 0x354582ff9f500f05b506666b75B33dbc90A8708d;
    address public constant NO_VLR = 0x4B53aE333bB337c0C8123aD84CE2F541ed53746E;
    address public constant YES_USDS = 0xa51aFa14963FaE9696b6844D652196959Eb5b9F6;
    address public constant NO_USDS = 0x1a9c528Bc34a7267b1c51a8CD3fad9fC99136171;

    // Balancer V2 Vault (211M VLR available, 0% fee!)
    IBalancerV2Vault public constant balancerVault = IBalancerV2Vault(0xBA12222222228d8Ba445958a75a0704d566BF2C8);

    // Routers
    ISwapRouter public constant swapRouter = ISwapRouter(0xE592427A0AEce92De3Edee1F18E0157C05861564);
    IFutarchyRouter public constant futarchyRouter = IFutarchyRouter(0xAc9Bf8EbA6Bd31f8E8c76f8E8B2AAd0BD93f98Dc);

    // Fee tiers
    uint24 public constant OUTCOME_FEE = 500;      // 0.05% for outcome pools
    uint24 public constant USDS_USDC_FEE = 500;    // 0.05% for USDS/USDC
    uint24 public constant VLR_USDC_FEE = 3000;    // 0.3% for VLR/USDC

    // Admin for emergency recovery only
    address public admin;

    // ==========================================================================
    // ENUMS & STRUCTS
    // ==========================================================================

    enum ArbitrageDirection {
        SPOT_SPLIT,   // Split VLR -> sell outcomes -> merge USDS -> swap back
        MERGE_SPOT    // Swap VLR -> USDS -> split -> buy outcomes -> merge VLR
    }

    struct ArbitrageResult {
        bool success;
        uint256 profit;
        uint256 borrowAmount;
    }

    // Transient state for callback
    ArbitrageDirection private _activeDirection;
    uint256 private _minProfit;
    address private _profitRecipient;
    ArbitrageResult private _lastResult;

    // ==========================================================================
    // EVENTS & ERRORS
    // ==========================================================================

    event ArbitrageExecuted(
        address indexed caller,
        ArbitrageDirection direction,
        uint256 borrowAmount,
        uint256 profit
    );

    error ArbitrageFailed(uint256 balanceAfter, uint256 required, string reason);

    // ==========================================================================
    // CONSTRUCTOR
    // ==========================================================================

    constructor() {
        admin = msg.sender;
    }

    // ==========================================================================
    // EXTERNAL FUNCTIONS
    // ==========================================================================

    /**
     * @notice Execute flash arbitrage - ANYONE CAN CALL
     * @param borrowAmount Amount of VLR to flash borrow
     * @param direction Arbitrage strategy (SPOT_SPLIT or MERGE_SPOT)
     * @param minProfit Minimum profit required (protects against MEV)
     */
    function executeArbitrage(
        uint256 borrowAmount,
        ArbitrageDirection direction,
        uint256 minProfit
    ) external nonReentrant returns (ArbitrageResult memory result) {
        // Store transient state
        _activeDirection = direction;
        _minProfit = minProfit;
        _profitRecipient = msg.sender;

        // Prepare flash loan parameters
        IERC20[] memory tokens = new IERC20[](1);
        tokens[0] = IERC20(VLR);

        uint256[] memory amounts = new uint256[](1);
        amounts[0] = borrowAmount;

        // Flash borrow VLR from Balancer V2 (0% fee!)
        balancerVault.flashLoan(
            address(this),
            tokens,
            amounts,
            abi.encode(borrowAmount, direction)
        );

        result = _lastResult;
        return result;
    }

    // ==========================================================================
    // BALANCER V2 FLASH LOAN CALLBACK
    // ==========================================================================

    /**
     * @notice Balancer V2 flash callback - called by Vault during flashLoan()
     * @dev Must repay borrowed tokens to Vault by end of callback
     */
    function receiveFlashLoan(
        IERC20[] memory, // tokens - unused
        uint256[] memory amounts,
        uint256[] memory feeAmounts,  // Always 0 for Balancer V2!
        bytes memory userData
    ) external {
        require(msg.sender == address(balancerVault), "Only Balancer Vault");

        (uint256 borrowAmount, ArbitrageDirection direction) = abi.decode(userData, (uint256, ArbitrageDirection));
        uint256 repayAmount = amounts[0] + feeAmounts[0];  // feeAmounts[0] is always 0

        // Execute strategy
        if (direction == ArbitrageDirection.SPOT_SPLIT) {
            _executeSpotSplit(borrowAmount);
        } else {
            _executeMergeSpot(borrowAmount);
        }

        // Check balance and repay
        uint256 vlrBalance = IERC20(VLR).balanceOf(address(this));
        if (vlrBalance < repayAmount) {
            revert ArbitrageFailed(vlrBalance, repayAmount, "Insufficient to repay");
        }

        uint256 profit = vlrBalance - repayAmount;
        if (profit < _minProfit) {
            revert ArbitrageFailed(vlrBalance, repayAmount, "Profit below minimum");
        }

        // Repay flash loan to Balancer Vault
        IERC20(VLR).transfer(address(balancerVault), repayAmount);

        // Send profit to caller
        if (profit > 0) {
            IERC20(VLR).safeTransfer(_profitRecipient, profit);
        }

        // Store result
        _lastResult = ArbitrageResult({
            success: true,
            profit: profit,
            borrowAmount: borrowAmount
        });

        emit ArbitrageExecuted(_profitRecipient, direction, borrowAmount, profit);
    }

    // ==========================================================================
    // STRATEGY: SPOT_SPLIT
    // ==========================================================================

    /**
     * @dev SPOT_SPLIT: Split VLR -> sell outcomes -> merge USDS -> swap back
     * Profitable when MIN(YES, NO) outcome price > spot price
     */
    function _executeSpotSplit(uint256 amount) internal {
        // 1. Split VLR -> YES_VLR + NO_VLR
        _safeApprove(IERC20(VLR), address(futarchyRouter), amount);
        futarchyRouter.splitPosition(PROPOSAL, VLR, amount);

        // 2. Swap YES_VLR -> YES_USDS
        uint256 yesVlrBal = IERC20(YES_VLR).balanceOf(address(this));
        if (yesVlrBal > 0) {
            _swapExactInput(YES_VLR, YES_USDS, OUTCOME_FEE, yesVlrBal);
        }

        // 3. Swap NO_VLR -> NO_USDS
        uint256 noVlrBal = IERC20(NO_VLR).balanceOf(address(this));
        if (noVlrBal > 0) {
            _swapExactInput(NO_VLR, NO_USDS, OUTCOME_FEE, noVlrBal);
        }

        // 4. Merge YES_USDS + NO_USDS -> USDS
        uint256 yesUsdsBal = IERC20(YES_USDS).balanceOf(address(this));
        uint256 noUsdsBal = IERC20(NO_USDS).balanceOf(address(this));
        uint256 mergeAmount = yesUsdsBal < noUsdsBal ? yesUsdsBal : noUsdsBal;

        if (mergeAmount > 0) {
            _safeApprove(IERC20(YES_USDS), address(futarchyRouter), mergeAmount);
            _safeApprove(IERC20(NO_USDS), address(futarchyRouter), mergeAmount);
            futarchyRouter.mergePositions(PROPOSAL, USDS, mergeAmount);
        }

        // 5. Swap USDS -> USDC -> VLR (multi-hop via Uniswap V3)
        uint256 usdsBal = IERC20(USDS).balanceOf(address(this));
        if (usdsBal > 0) {
            _swapUsdsToVlr(usdsBal);
        }
    }

    // ==========================================================================
    // STRATEGY: MERGE_SPOT
    // ==========================================================================

    /**
     * @dev MERGE_SPOT: Swap VLR -> USDS -> split -> buy outcomes -> merge
     * Profitable when MAX(YES, NO) outcome price < spot price
     */
    function _executeMergeSpot(uint256 amount) internal {
        // 1. Swap VLR -> USDC -> USDS (multi-hop)
        _swapVlrToUsds(amount);

        // 2. Split USDS -> YES_USDS + NO_USDS
        uint256 usdsBal = IERC20(USDS).balanceOf(address(this));
        _safeApprove(IERC20(USDS), address(futarchyRouter), usdsBal);
        futarchyRouter.splitPosition(PROPOSAL, USDS, usdsBal);

        // 3. Swap YES_USDS -> YES_VLR
        uint256 yesUsdsBal = IERC20(YES_USDS).balanceOf(address(this));
        if (yesUsdsBal > 0) {
            _swapExactInput(YES_USDS, YES_VLR, OUTCOME_FEE, yesUsdsBal);
        }

        // 4. Swap NO_USDS -> NO_VLR
        uint256 noUsdsBal = IERC20(NO_USDS).balanceOf(address(this));
        if (noUsdsBal > 0) {
            _swapExactInput(NO_USDS, NO_VLR, OUTCOME_FEE, noUsdsBal);
        }

        // 5. Merge YES_VLR + NO_VLR -> VLR
        uint256 yesVlrBal = IERC20(YES_VLR).balanceOf(address(this));
        uint256 noVlrBal = IERC20(NO_VLR).balanceOf(address(this));
        uint256 mergeAmount = yesVlrBal < noVlrBal ? yesVlrBal : noVlrBal;

        if (mergeAmount > 0) {
            _safeApprove(IERC20(YES_VLR), address(futarchyRouter), mergeAmount);
            _safeApprove(IERC20(NO_VLR), address(futarchyRouter), mergeAmount);
            futarchyRouter.mergePositions(PROPOSAL, VLR, mergeAmount);
        }
    }

    // ==========================================================================
    // SWAP HELPERS
    // ==========================================================================

    function _swapExactInput(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn
    ) internal returns (uint256 amountOut) {
        _safeApprove(IERC20(tokenIn), address(swapRouter), amountIn);

        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: fee,
            recipient: address(this),
            deadline: block.timestamp,
            amountIn: amountIn,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0
        });

        return swapRouter.exactInputSingle(params);
    }

    function _swapUsdsToVlr(uint256 amountIn) internal returns (uint256 amountOut) {
        _safeApprove(IERC20(USDS), address(swapRouter), amountIn);

        // Path: USDS -> USDC (500) -> VLR (3000)
        bytes memory path = abi.encodePacked(
            USDS,
            USDS_USDC_FEE,
            USDC,
            VLR_USDC_FEE,
            VLR
        );

        ISwapRouter.ExactInputParams memory params = ISwapRouter.ExactInputParams({
            path: path,
            recipient: address(this),
            deadline: block.timestamp,
            amountIn: amountIn,
            amountOutMinimum: 0
        });

        return swapRouter.exactInput(params);
    }

    function _swapVlrToUsds(uint256 amountIn) internal returns (uint256 amountOut) {
        _safeApprove(IERC20(VLR), address(swapRouter), amountIn);

        // Path: VLR -> USDC (3000) -> USDS (500)
        bytes memory path = abi.encodePacked(
            VLR,
            VLR_USDC_FEE,
            USDC,
            USDS_USDC_FEE,
            USDS
        );

        ISwapRouter.ExactInputParams memory params = ISwapRouter.ExactInputParams({
            path: path,
            recipient: address(this),
            deadline: block.timestamp,
            amountIn: amountIn,
            amountOutMinimum: 0
        });

        return swapRouter.exactInput(params);
    }

    // ==========================================================================
    // UTILS
    // ==========================================================================

    function _safeApprove(IERC20 token, address spender, uint256 amount) internal {
        uint256 currentAllowance = token.allowance(address(this), spender);
        if (currentAllowance < amount) {
            token.approve(spender, type(uint256).max);
        }
    }

    // ==========================================================================
    // ADMIN (Emergency Recovery Only)
    // ==========================================================================

    function recoverTokens(address token, uint256 amount) external {
        require(msg.sender == admin, "Admin only");
        IERC20(token).safeTransfer(admin, amount);
    }

    function transferAdmin(address newAdmin) external {
        require(msg.sender == admin, "Admin only");
        require(newAdmin != address(0), "Invalid admin");
        admin = newAdmin;
    }

    receive() external payable {}
}
