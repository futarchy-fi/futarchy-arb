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
// UNISWAP UNIVERSAL ROUTER + PERMIT2 INTERFACES (Modern Approach)
// =============================================================================

interface IPermit2 {
    /// @notice Approves a spender to use a token for transfer
    function approve(
        address token,
        address spender,
        uint160 amount,
        uint48 expiration
    ) external;

    /// @notice Returns the allowance details for a token
    function allowance(
        address owner,
        address token,
        address spender
    ) external view returns (uint160 amount, uint48 expiration, uint48 nonce);
}

interface IUniversalRouter {
    /// @notice Executes encoded commands along with provided inputs
    function execute(
        bytes calldata commands,
        bytes[] calldata inputs,
        uint256 deadline
    ) external payable;
}

// =============================================================================
// FUTARCHY INTERFACES
// =============================================================================

interface IFutarchyRouter {
    function splitPosition(address proposal, address collateralToken, uint256 amount) external;
    function mergePositions(address proposal, address collateralToken, uint256 amount) external;
}

// =============================================================================
// VLR FLASH ARBITRAGE V2 - UNIVERSAL ROUTER + PERMIT2
// =============================================================================

/**
 * @title VLRFlashArbitrageV2
 * @notice Flash arbitrage for VLR/USDS using Universal Router + Permit2
 * @dev Based on verified working manual test achieving 1.93% profit
 * 
 * Key Differences from V1:
 * - Uses Universal Router (0x66a9893cc07d91d95644aedd05d03f95e1dba8af) instead of SwapRouter
 * - Uses Permit2 (0x000000000022D473030F116dDEE9F6B43aC78BA3) for approvals
 * - Sends swap output directly to contract (no SWEEP command)
 * 
 * Strategy SPOT_SPLIT:
 *   1. Flash borrow VLR from Balancer V2 (FREE!)
 *   2. Split VLR -> YES_VLR + NO_VLR
 *   3. Approve YES_VLR to Permit2, then Permit2 to Router
 *   4. Swap YES_VLR -> YES_USDS (Universal Router)
 *   5. Swap NO_VLR -> NO_USDS (Universal Router)
 *   6. Merge MIN(YES_USDS, NO_USDS) -> USDS
 *   7. Swap USDS -> USDC -> VLR (multi-hop)
 *   8. Repay flash loan + keep profit
 */
contract VLRFlashArbitrageV2 is ReentrancyGuard {
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

    // Universal Router + Permit2 (Modern Uniswap)
    IPermit2 public constant permit2 = IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    IUniversalRouter public constant universalRouter = IUniversalRouter(0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af);
    IFutarchyRouter public constant futarchyRouter = IFutarchyRouter(0xAc9Bf8EbA6Bd31f8E8c76f8E8B2AAd0BD93f98Dc);

    // Fee tiers
    uint24 public constant OUTCOME_FEE = 500;      // 0.05% for outcome pools
    uint24 public constant USDS_USDC_FEE = 500;    // 0.05% for USDS/USDC
    uint24 public constant VLR_USDC_FEE = 3000;    // 0.3% for VLR/USDC

    // Universal Router command
    bytes1 public constant V3_SWAP_EXACT_IN = 0x00;

    // Permit2 defaults
    uint160 private constant MAX_UINT160 = type(uint160).max;
    uint48 private constant MAX_UINT48 = type(uint48).max;

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
        
        // Pre-approve ALL tokens to Permit2 (one-time MAX approval)
        IERC20(VLR).approve(address(permit2), type(uint256).max);
        IERC20(USDS).approve(address(permit2), type(uint256).max);
        IERC20(USDC).approve(address(permit2), type(uint256).max);
        IERC20(YES_VLR).approve(address(permit2), type(uint256).max);
        IERC20(NO_VLR).approve(address(permit2), type(uint256).max);
        IERC20(YES_USDS).approve(address(permit2), type(uint256).max);
        IERC20(NO_USDS).approve(address(permit2), type(uint256).max);
        
        // Pre-approve Permit2 -> Universal Router for all tokens
        permit2.approve(VLR, address(universalRouter), MAX_UINT160, MAX_UINT48);
        permit2.approve(USDS, address(universalRouter), MAX_UINT160, MAX_UINT48);
        permit2.approve(USDC, address(universalRouter), MAX_UINT160, MAX_UINT48);
        permit2.approve(YES_VLR, address(universalRouter), MAX_UINT160, MAX_UINT48);
        permit2.approve(NO_VLR, address(universalRouter), MAX_UINT160, MAX_UINT48);
        permit2.approve(YES_USDS, address(universalRouter), MAX_UINT160, MAX_UINT48);
        permit2.approve(NO_USDS, address(universalRouter), MAX_UINT160, MAX_UINT48);
        
        // Pre-approve outcome tokens to FutarchyRouter for merge
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

    function receiveFlashLoan(
        IERC20[] memory,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external {
        require(msg.sender == address(balancerVault), "Only Balancer Vault");

        (uint256 borrowAmount, ArbitrageDirection direction) = abi.decode(userData, (uint256, ArbitrageDirection));
        uint256 repayAmount = amounts[0] + feeAmounts[0];

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
    // STRATEGY: SPOT_SPLIT (Verified Working!)
    // ==========================================================================

    function _executeSpotSplit(uint256 amount) internal {
        // 1. Split VLR -> YES_VLR + NO_VLR
        futarchyRouter.splitPosition(PROPOSAL, VLR, amount);

        // 2. Swap YES_VLR -> YES_USDS (Universal Router)
        uint256 yesVlrBal = IERC20(YES_VLR).balanceOf(address(this));
        if (yesVlrBal > 0) {
            _swapExactInputUniversal(YES_VLR, YES_USDS, OUTCOME_FEE, yesVlrBal);
        }

        // 3. Swap NO_VLR -> NO_USDS (Universal Router)
        uint256 noVlrBal = IERC20(NO_VLR).balanceOf(address(this));
        if (noVlrBal > 0) {
            _swapExactInputUniversal(NO_VLR, NO_USDS, OUTCOME_FEE, noVlrBal);
        }

        // 4. Merge YES_USDS + NO_USDS -> USDS (merge MIN of both)
        uint256 yesUsdsBal = IERC20(YES_USDS).balanceOf(address(this));
        uint256 noUsdsBal = IERC20(NO_USDS).balanceOf(address(this));
        uint256 mergeAmount = yesUsdsBal < noUsdsBal ? yesUsdsBal : noUsdsBal;

        if (mergeAmount > 0) {
            futarchyRouter.mergePositions(PROPOSAL, USDS, mergeAmount);
        }

        // 5. Swap USDS -> USDC -> VLR (multi-hop)
        uint256 usdsBal = IERC20(USDS).balanceOf(address(this));
        if (usdsBal > 0) {
            _swapUsdsToVlrUniversal(usdsBal);
        }
    }

    // ==========================================================================
    // STRATEGY: MERGE_SPOT
    // ==========================================================================

    function _executeMergeSpot(uint256 amount) internal {
        // 1. Swap VLR -> USDC -> USDS (multi-hop)
        _swapVlrToUsdsUniversal(amount);

        // 2. Split USDS -> YES_USDS + NO_USDS
        uint256 usdsBal = IERC20(USDS).balanceOf(address(this));
        futarchyRouter.splitPosition(PROPOSAL, USDS, usdsBal);

        // 3. Swap YES_USDS -> YES_VLR
        uint256 yesUsdsBal = IERC20(YES_USDS).balanceOf(address(this));
        if (yesUsdsBal > 0) {
            _swapExactInputUniversal(YES_USDS, YES_VLR, OUTCOME_FEE, yesUsdsBal);
        }

        // 4. Swap NO_USDS -> NO_VLR
        uint256 noUsdsBal = IERC20(NO_USDS).balanceOf(address(this));
        if (noUsdsBal > 0) {
            _swapExactInputUniversal(NO_USDS, NO_VLR, OUTCOME_FEE, noUsdsBal);
        }

        // 5. Merge YES_VLR + NO_VLR -> VLR (merge MIN of both)
        uint256 yesVlrBal = IERC20(YES_VLR).balanceOf(address(this));
        uint256 noVlrBal = IERC20(NO_VLR).balanceOf(address(this));
        uint256 mergeAmount = yesVlrBal < noVlrBal ? yesVlrBal : noVlrBal;

        if (mergeAmount > 0) {
            futarchyRouter.mergePositions(PROPOSAL, VLR, mergeAmount);
        }
    }

    // ==========================================================================
    // UNIVERSAL ROUTER SWAP HELPERS
    // ==========================================================================

    /**
     * @dev Execute single-hop swap via Universal Router
     * @notice Sends output directly to this contract (no SWEEP command!)
     */
    function _swapExactInputUniversal(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn
    ) internal {
        // Build path: tokenIn -> fee -> tokenOut
        bytes memory path = abi.encodePacked(tokenIn, fee, tokenOut);

        // V3_SWAP_EXACT_IN params: recipient, amountIn, amountOutMinimum, path, payerIsUser
        // payerIsUser = true: router pulls from msg.sender (our contract) via Permit2
        bytes memory swapParams = abi.encode(
            address(this),  // recipient - DIRECT to contract, not router
            amountIn,
            0,              // amountOutMinimum (0 for flash arb, reverts at end if unprofitable)
            path,
            true            // payerIsUser = true (router pulls from this contract via Permit2)
        );

        bytes memory commands = abi.encodePacked(V3_SWAP_EXACT_IN);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = swapParams;

        universalRouter.execute(commands, inputs, block.timestamp);
    }

    /**
     * @dev Multi-hop swap: USDS -> USDC -> VLR
     */
    function _swapUsdsToVlrUniversal(uint256 amountIn) internal {
        // Path: USDS -> USDC (500) -> VLR (3000)
        bytes memory path = abi.encodePacked(
            USDS,
            USDS_USDC_FEE,
            USDC,
            VLR_USDC_FEE,
            VLR
        );

        bytes memory swapParams = abi.encode(
            address(this),
            amountIn,
            0,
            path,
            true
        );

        bytes memory commands = abi.encodePacked(V3_SWAP_EXACT_IN);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = swapParams;

        universalRouter.execute(commands, inputs, block.timestamp);
    }

    /**
     * @dev Multi-hop swap: VLR -> USDC -> USDS
     */
    function _swapVlrToUsdsUniversal(uint256 amountIn) internal {
        // Path: VLR -> USDC (3000) -> USDS (500)
        bytes memory path = abi.encodePacked(
            VLR,
            VLR_USDC_FEE,
            USDC,
            USDS_USDC_FEE,
            USDS
        );

        bytes memory swapParams = abi.encode(
            address(this),
            amountIn,
            0,
            path,
            true
        );

        bytes memory commands = abi.encodePacked(V3_SWAP_EXACT_IN);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = swapParams;

        universalRouter.execute(commands, inputs, block.timestamp);
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
