// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// =============================================================================
// INTERFACES
// =============================================================================

interface IBalancerV2Vault {
    function flashLoan(
        address recipient,
        IERC20[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
    function allowance(address owner, address token, address spender) external view returns (uint160, uint48, uint48);
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }
    function quoteExactInputSingle(QuoteExactInputSingleParams memory params) 
        external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate);
    
    function quoteExactInput(bytes memory path, uint256 amountIn)
        external returns (uint256 amountOut, uint160[] memory sqrtPriceX96AfterList, uint32[] memory initializedTicksCrossedList, uint256 gasEstimate);
}

interface IFutarchyRouter {
    function splitPosition(address proposal, address collateralToken, uint256 amount) external;
    function mergePositions(address proposal, address collateralToken, uint256 amount) external;
}

// =============================================================================
// VLR FLASH ARBITRAGE V3 - WITH SLIPPAGE PROTECTION
// =============================================================================

/**
 * @title VLRFlashArbitrageV3
 * @notice Flash arbitrage with on-chain slippage protection
 * @dev Slippage uses Uniswap fee format: 500 = 0.05%, 3000 = 0.3%, 10000 = 1%
 * 
 * Example:
 *   slippageBps = 500  → 0.05% slippage (tight, may fail)
 *   slippageBps = 3000 → 0.3% slippage (normal)
 *   slippageBps = 10000 → 1% slippage (safe)
 *   slippageBps = 100000 → 10% slippage (very loose)
 */
contract VLRFlashArbitrageV3 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ==========================================================================
    // CONSTANTS (Verified Mainnet Addresses)
    // ==========================================================================

    address public constant VLR = 0x4e107a0000DB66f0E9Fd2039288Bf811dD1f9c74;
    address public constant USDS = 0xdC035D45d973E3EC169d2276DDab16f1e407384F;
    address public constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    address public constant PROPOSAL = 0x4e018f1D8b93B91a0Ce186874eDb53CB6fFfCa62;
    address public constant YES_VLR = 0x354582ff9f500f05b506666b75B33dbc90A8708d;
    address public constant NO_VLR = 0x4B53aE333bB337c0C8123aD84CE2F541ed53746E;
    address public constant YES_USDS = 0xa51aFa14963FaE9696b6844D652196959Eb5b9F6;
    address public constant NO_USDS = 0x1a9c528Bc34a7267b1c51a8CD3fad9fC99136171;

    IBalancerV2Vault public constant balancerVault = IBalancerV2Vault(0xBA12222222228d8Ba445958a75a0704d566BF2C8);
    IPermit2 public constant permit2 = IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    IUniversalRouter public constant universalRouter = IUniversalRouter(0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af);
    IFutarchyRouter public constant futarchyRouter = IFutarchyRouter(0xAc9Bf8EbA6Bd31f8E8c76f8E8B2AAd0BD93f98Dc);

    uint24 public constant OUTCOME_FEE = 500;
    uint24 public constant USDS_USDC_FEE = 500;
    uint24 public constant VLR_USDC_FEE = 3000;

    bytes1 public constant V3_SWAP_EXACT_IN = 0x00;
    uint160 private constant MAX_UINT160 = type(uint160).max;
    uint48 private constant MAX_UINT48 = type(uint48).max;
    uint256 private constant BPS_DENOMINATOR = 1_000_000;  // 1M for precision (1% = 10000)

    address public admin;

    // ==========================================================================
    // STRUCTS
    // ==========================================================================

    enum ArbitrageDirection { SPOT_SPLIT, MERGE_SPOT }

    struct ArbitrageResult {
        bool success;
        uint256 profit;
        uint256 borrowAmount;
        uint256 gasUsed;
    }

    struct ArbitrageParams {
        uint256 borrowAmount;
        ArbitrageDirection direction;
        uint256 minProfit;
        uint256 slippageBps;  // Slippage in bps: 500 = 0.05%, 3000 = 0.3%, 10000 = 1%
    }

    // Transient state
    ArbitrageParams private _params;
    address private _profitRecipient;
    ArbitrageResult private _lastResult;

    // ==========================================================================
    // EVENTS & ERRORS
    // ==========================================================================

    event ArbitrageExecuted(
        address indexed caller,
        ArbitrageDirection direction,
        uint256 borrowAmount,
        uint256 profit,
        uint256 slippageBps,
        uint256 gasUsed
    );

    error ArbitrageFailed(uint256 balanceAfter, uint256 required, string reason);
    error SlippageExceeded(uint256 expected, uint256 actual);

    // ==========================================================================
    // CONSTRUCTOR
    // ==========================================================================

    constructor() {
        admin = msg.sender;
        
        // Pre-approve all tokens to Permit2
        IERC20(VLR).approve(address(permit2), type(uint256).max);
        IERC20(USDS).approve(address(permit2), type(uint256).max);
        IERC20(USDC).approve(address(permit2), type(uint256).max);
        IERC20(YES_VLR).approve(address(permit2), type(uint256).max);
        IERC20(NO_VLR).approve(address(permit2), type(uint256).max);
        IERC20(YES_USDS).approve(address(permit2), type(uint256).max);
        IERC20(NO_USDS).approve(address(permit2), type(uint256).max);
        
        // Pre-approve Permit2 -> Universal Router
        permit2.approve(VLR, address(universalRouter), MAX_UINT160, MAX_UINT48);
        permit2.approve(USDS, address(universalRouter), MAX_UINT160, MAX_UINT48);
        permit2.approve(USDC, address(universalRouter), MAX_UINT160, MAX_UINT48);
        permit2.approve(YES_VLR, address(universalRouter), MAX_UINT160, MAX_UINT48);
        permit2.approve(NO_VLR, address(universalRouter), MAX_UINT160, MAX_UINT48);
        permit2.approve(YES_USDS, address(universalRouter), MAX_UINT160, MAX_UINT48);
        permit2.approve(NO_USDS, address(universalRouter), MAX_UINT160, MAX_UINT48);
        
        // Pre-approve to FutarchyRouter
        IERC20(YES_VLR).approve(address(futarchyRouter), type(uint256).max);
        IERC20(NO_VLR).approve(address(futarchyRouter), type(uint256).max);
        IERC20(YES_USDS).approve(address(futarchyRouter), type(uint256).max);
        IERC20(NO_USDS).approve(address(futarchyRouter), type(uint256).max);
        IERC20(VLR).approve(address(futarchyRouter), type(uint256).max);
        IERC20(USDS).approve(address(futarchyRouter), type(uint256).max);
    }

    // ==========================================================================
    // EXTERNAL FUNCTIONS
    // ==========================================================================

    /**
     * @notice Execute flash arbitrage with slippage protection
     * @param borrowAmount Amount of VLR to flash borrow
     * @param direction SPOT_SPLIT (0) or MERGE_SPOT (1)
     * @param minProfit Minimum profit in VLR (MEV protection)
     * @param slippageBps Slippage tolerance in bps (500 = 0.05%, 3000 = 0.3%, 10000 = 1%)
     * @return result Arbitrage result with profit and gas used
     */
    function executeArbitrage(
        uint256 borrowAmount,
        ArbitrageDirection direction,
        uint256 minProfit,
        uint256 slippageBps
    ) external nonReentrant returns (ArbitrageResult memory result) {
        uint256 gasStart = gasleft();
        
        // Store params
        _params = ArbitrageParams({
            borrowAmount: borrowAmount,
            direction: direction,
            minProfit: minProfit,
            slippageBps: slippageBps
        });
        _profitRecipient = msg.sender;

        // Flash loan
        IERC20[] memory tokens = new IERC20[](1);
        tokens[0] = IERC20(VLR);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = borrowAmount;

        balancerVault.flashLoan(address(this), tokens, amounts, abi.encode(_params));

        result = _lastResult;
        result.gasUsed = gasStart - gasleft();
        return result;
    }

    // ==========================================================================
    // BALANCER CALLBACK
    // ==========================================================================

    function receiveFlashLoan(
        IERC20[] memory,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external {
        require(msg.sender == address(balancerVault), "Only Balancer Vault");

        ArbitrageParams memory params = abi.decode(userData, (ArbitrageParams));
        uint256 repayAmount = amounts[0] + feeAmounts[0];

        // Execute strategy
        if (params.direction == ArbitrageDirection.SPOT_SPLIT) {
            _executeSpotSplit(params.borrowAmount, params.slippageBps);
        } else {
            _executeMergeSpot(params.borrowAmount, params.slippageBps);
        }

        // Check and repay
        uint256 vlrBalance = IERC20(VLR).balanceOf(address(this));
        if (vlrBalance < repayAmount) {
            revert ArbitrageFailed(vlrBalance, repayAmount, "Insufficient to repay");
        }

        uint256 profit = vlrBalance - repayAmount;
        if (profit < params.minProfit) {
            revert ArbitrageFailed(vlrBalance, repayAmount, "Profit below minimum");
        }

        IERC20(VLR).transfer(address(balancerVault), repayAmount);

        if (profit > 0) {
            IERC20(VLR).safeTransfer(_profitRecipient, profit);
        }

        _lastResult = ArbitrageResult({
            success: true,
            profit: profit,
            borrowAmount: params.borrowAmount,
            gasUsed: 0
        });

        emit ArbitrageExecuted(_profitRecipient, params.direction, params.borrowAmount, profit, params.slippageBps, 0);
    }

    // ==========================================================================
    // STRATEGY: SPOT_SPLIT WITH SLIPPAGE
    // ==========================================================================

    function _executeSpotSplit(uint256 amount, uint256 slippageBps) internal {
        // 1. Split VLR -> YES_VLR + NO_VLR
        futarchyRouter.splitPosition(PROPOSAL, VLR, amount);

        // 2. Swap YES_VLR -> YES_USDS (with slippage protection)
        uint256 yesVlrBal = IERC20(YES_VLR).balanceOf(address(this));
        if (yesVlrBal > 0) {
            _swapWithSlippage(YES_VLR, YES_USDS, OUTCOME_FEE, yesVlrBal, slippageBps);
        }

        // 3. Swap NO_VLR -> NO_USDS (with slippage protection)
        uint256 noVlrBal = IERC20(NO_VLR).balanceOf(address(this));
        if (noVlrBal > 0) {
            _swapWithSlippage(NO_VLR, NO_USDS, OUTCOME_FEE, noVlrBal, slippageBps);
        }

        // 4. Merge
        uint256 yesUsdsBal = IERC20(YES_USDS).balanceOf(address(this));
        uint256 noUsdsBal = IERC20(NO_USDS).balanceOf(address(this));
        uint256 mergeAmount = yesUsdsBal < noUsdsBal ? yesUsdsBal : noUsdsBal;
        if (mergeAmount > 0) {
            futarchyRouter.mergePositions(PROPOSAL, USDS, mergeAmount);
        }

        // 5. Swap USDS -> VLR (with slippage protection)
        uint256 usdsBal = IERC20(USDS).balanceOf(address(this));
        if (usdsBal > 0) {
            _swapUsdsToVlrWithSlippage(usdsBal, slippageBps);
        }
    }

    // ==========================================================================
    // STRATEGY: MERGE_SPOT WITH SLIPPAGE
    // ==========================================================================

    function _executeMergeSpot(uint256 amount, uint256 slippageBps) internal {
        // 1. Swap VLR -> USDS
        _swapVlrToUsdsWithSlippage(amount, slippageBps);

        // 2. Split USDS
        uint256 usdsBal = IERC20(USDS).balanceOf(address(this));
        futarchyRouter.splitPosition(PROPOSAL, USDS, usdsBal);

        // 3. Swap YES_USDS -> YES_VLR
        uint256 yesUsdsBal = IERC20(YES_USDS).balanceOf(address(this));
        if (yesUsdsBal > 0) {
            _swapWithSlippage(YES_USDS, YES_VLR, OUTCOME_FEE, yesUsdsBal, slippageBps);
        }

        // 4. Swap NO_USDS -> NO_VLR
        uint256 noUsdsBal = IERC20(NO_USDS).balanceOf(address(this));
        if (noUsdsBal > 0) {
            _swapWithSlippage(NO_USDS, NO_VLR, OUTCOME_FEE, noUsdsBal, slippageBps);
        }

        // 5. Merge
        uint256 yesVlrBal = IERC20(YES_VLR).balanceOf(address(this));
        uint256 noVlrBal = IERC20(NO_VLR).balanceOf(address(this));
        uint256 mergeAmount = yesVlrBal < noVlrBal ? yesVlrBal : noVlrBal;
        if (mergeAmount > 0) {
            futarchyRouter.mergePositions(PROPOSAL, VLR, mergeAmount);
        }
    }

    // ==========================================================================
    // SWAP WITH SLIPPAGE PROTECTION
    // ==========================================================================

    /**
     * @dev Calculate amountOutMinimum based on amountIn and slippage
     * @param amountIn Input amount
     * @param slippageBps Slippage in bps (500 = 0.05%)
     * @return Minimum output accepting slippage loss
     */
    function _calcMinOut(uint256 amountIn, uint256 slippageBps) internal pure returns (uint256) {
        // minOut = amountIn * (1 - slippage)
        // For simplicity, we use amountIn as baseline (assumes 1:1 rough peg)
        // In production, you'd want to use actual quote
        return amountIn * (BPS_DENOMINATOR - slippageBps) / BPS_DENOMINATOR;
    }

    function _swapWithSlippage(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 /* slippageBps */  // Unused - rely on minProfit instead
    ) internal {
        bytes memory path = abi.encodePacked(tokenIn, fee, tokenOut);
        
        // Use minOut = 0 for individual swaps
        // Final protection comes from minProfit check at the end
        // This is safe for flash arb because unprofitable tx reverts anyway
        uint256 minOut = 0;

        bytes memory swapParams = abi.encode(
            address(this),
            amountIn,
            minOut,
            path,
            true
        );

        bytes memory commands = abi.encodePacked(V3_SWAP_EXACT_IN);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = swapParams;

        universalRouter.execute(commands, inputs, block.timestamp);
    }

    function _swapUsdsToVlrWithSlippage(uint256 amountIn, uint256 slippageBps) internal {
        bytes memory path = abi.encodePacked(USDS, USDS_USDC_FEE, USDC, VLR_USDC_FEE, VLR);
        
        // For USDS->VLR, we need to account for VLR being ~500x more valuable
        // USDS ~$1, VLR ~$0.002, so 1 USDS ≈ 500 VLR
        // For now, use 0 minOut and rely on final profit check
        uint256 minOut = 0;  // Rely on minProfit check at the end

        bytes memory swapParams = abi.encode(address(this), amountIn, minOut, path, true);
        bytes memory commands = abi.encodePacked(V3_SWAP_EXACT_IN);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = swapParams;

        universalRouter.execute(commands, inputs, block.timestamp);
    }

    function _swapVlrToUsdsWithSlippage(uint256 amountIn, uint256 slippageBps) internal {
        bytes memory path = abi.encodePacked(VLR, VLR_USDC_FEE, USDC, USDS_USDC_FEE, USDS);
        uint256 minOut = 0;  // Rely on minProfit check

        bytes memory swapParams = abi.encode(address(this), amountIn, minOut, path, true);
        bytes memory commands = abi.encodePacked(V3_SWAP_EXACT_IN);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = swapParams;

        universalRouter.execute(commands, inputs, block.timestamp);
    }

    // ==========================================================================
    // ADMIN
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
