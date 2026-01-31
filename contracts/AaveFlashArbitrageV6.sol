// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// =============================================================================
// AAVE FLASH ARBITRAGE V6 - DYNAMIC & UNIVERSAL ROUTER
// =============================================================================
//
// Features:
// 1. Dynamic Proposal Loading (not hardcoded)
// 2. Universal Router + Permit2 (V5 architecture)
// 3. Correct 0.05% Fee Tier for USDC/GHO (V6 fix)
// 4. Dynamic Token Approvals (safe & gas optimized)
// =============================================================================

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

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
    function allowance(address user, address token, address spender) external view returns (uint160 amount, uint48 expiration, uint48 nonce);
}

interface IFutarchyRouter {
    function splitPosition(address proposal, address collateralToken, uint256 amount) external;
    function mergePositions(address proposal, address collateralToken, uint256 amount) external;
    function proposals(address proposal) external view returns (address, address, uint256, uint256, address);
    function wrappedOutcome(address proposal, address collateralToken) external view returns (address);
}

interface IFutarchyProposal {
    function collateralToken1() external view returns (address);
    function collateralToken2() external view returns (address);
    function wrappedOutcome(uint256 index) external view returns (IERC20, bytes memory);
}

// =============================================================================
// CONTRACT
// =============================================================================

contract AaveFlashArbitrageV6 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ==========================================================================
    // CONSTANTS (Verified Mainnet Addresses)
    // ==========================================================================

    // Collateral tokens
    address public constant AAVE = 0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9;
    address public constant GHO  = 0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f;
    address public constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address public constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    // Infrastructure
    IBalancerV2Vault public constant balancerVault = IBalancerV2Vault(0xBA12222222228d8Ba445958a75a0704d566BF2C8);
    IPermit2 public constant permit2 = IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    IUniversalRouter public constant universalRouter = IUniversalRouter(0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af);
    IFutarchyRouter public constant futarchyRouter = IFutarchyRouter(0xAc9Bf8EbA6Bd31f8E8c76f8E8B2AAd0BD93f98Dc);

    // Fee tiers
    uint24 public constant OUTCOME_FEE = 500;      // 0.05% for outcome pools
    uint24 public constant GHO_USDC_FEE = 500;     // 0.05% for GHO/USDC (Fixed in V6!)
    uint24 public constant USDC_WETH_FEE = 500;    // 0.05% for USDC/WETH
    uint24 public constant WETH_AAVE_FEE = 3000;   // 0.3% for WETH/AAVE

    // Constants
    bytes1 public constant V3_SWAP_EXACT_IN = 0x00;
    uint160 private constant MAX_UINT160 = type(uint160).max;
    uint48 private constant MAX_UINT48 = type(uint48).max;

    address public admin;

    // ==========================================================================
    // STRUCTS
    // ==========================================================================

    enum ArbitrageDirection { SPOT_SPLIT, MERGE_SPOT }

    struct ArbitrageParams {
        address proposal;
        ArbitrageDirection direction;
        uint256 minProfit;
    }

    struct ProposalInfo {
        address proposal;
        address yesAave;
        address noAave;
        address yesGho;
        address noGho;
    }

    struct ArbitrageResult {
        bool success;
        uint256 profit;
        uint256 borrowAmount;
        uint256 gasUsed;
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
        address indexed proposal,
        ArbitrageDirection direction,
        uint256 borrowAmount,
        uint256 profit,
        uint256 gasUsed
    );

    error ArbitrageFailed(uint256 balanceAfter, uint256 required, string reason);
    error InvalidProposal(address proposal);

    // ==========================================================================
    // CONSTRUCTOR
    // ==========================================================================

    constructor() {
        admin = msg.sender;
        
        // 1. Approve Static Tokens to Permit2
        IERC20(AAVE).approve(address(permit2), type(uint256).max);
        IERC20(GHO).approve(address(permit2), type(uint256).max);
        IERC20(USDC).approve(address(permit2), type(uint256).max);
        IERC20(WETH).approve(address(permit2), type(uint256).max);
        
        // 2. Approve Permit2 -> Universal Router for Static Tokens
        permit2.approve(AAVE, address(universalRouter), MAX_UINT160, MAX_UINT48);
        permit2.approve(GHO, address(universalRouter), MAX_UINT160, MAX_UINT48);
        permit2.approve(USDC, address(universalRouter), MAX_UINT160, MAX_UINT48);
        permit2.approve(WETH, address(universalRouter), MAX_UINT160, MAX_UINT48);
        
        // 3. Approve Static Tokens to FutarchyRouter
        IERC20(AAVE).approve(address(futarchyRouter), type(uint256).max);
        IERC20(GHO).approve(address(futarchyRouter), type(uint256).max);
    }

    // ==========================================================================
    // EXTERNAL: EXECUTE ARBITRAGE
    // ==========================================================================

    function executeArbitrage(
        address proposalAddress,
        uint256 borrowAmount,
        ArbitrageDirection direction,
        uint256 minProfit
    ) external nonReentrant returns (ArbitrageResult memory result) {
        uint256 gasStart = gasleft();

        _params = ArbitrageParams({
            proposal: proposalAddress,
            direction: direction,
            minProfit: minProfit
        });
        _profitRecipient = msg.sender;

        // Flash Loan via Balancer V2 (0% fee!)
        IERC20[] memory tokens = new IERC20[](1);
        tokens[0] = IERC20(AAVE);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = borrowAmount;

        balancerVault.flashLoan(address(this), tokens, amounts, abi.encode(_params));

        result = _lastResult;
        result.gasUsed = gasStart - gasleft();

        emit ArbitrageExecuted(msg.sender, proposalAddress, direction, borrowAmount, result.profit, result.gasUsed);

        return result;
    }

    // ==========================================================================
    // BALANCER V2 CALLBACK
    // ==========================================================================

    function receiveFlashLoan(
        IERC20[] memory,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external {
        require(msg.sender == address(balancerVault), "Only Balancer Vault");

        ArbitrageParams memory params = abi.decode(userData, (ArbitrageParams));
        uint256 borrowAmount = amounts[0];
        uint256 repayAmount = borrowAmount + feeAmounts[0]; 

        // 1. Load Proposal Tokens
        ProposalInfo memory info = _loadProposal(params.proposal);
        
        // 2. Setup Dynamic Approvals
        _setupOutcomeApprovals(info);

        // 3. Execute Strategy
        if (params.direction == ArbitrageDirection.SPOT_SPLIT) {
            _executeSpotSplit(info, borrowAmount);
        } else {
            _executeMergeSpot(info, borrowAmount);
        }

        // 4. Verify & Repay
        uint256 aaveBalance = IERC20(AAVE).balanceOf(address(this));
        if (aaveBalance < repayAmount) {
            revert ArbitrageFailed(aaveBalance, repayAmount, "Insufficient to repay");
        }

        uint256 profit = aaveBalance - repayAmount;
        if (profit < params.minProfit) {
            revert ArbitrageFailed(aaveBalance, repayAmount, "Profit below minimum");
        }

        IERC20(AAVE).transfer(address(balancerVault), repayAmount);

        if (profit > 0) {
            IERC20(AAVE).safeTransfer(_profitRecipient, profit);
        }

        _lastResult = ArbitrageResult({
            success: true,
            profit: profit,
            borrowAmount: borrowAmount,
            gasUsed: 0
        });
    }

    // ==========================================================================
    // DYNAMIC LOADING & APPROVALS
    // ==========================================================================

    function _loadProposal(address proposalAddress) internal view returns (ProposalInfo memory info) {
        IFutarchyProposal proposal = IFutarchyProposal(proposalAddress);
        info.proposal = proposalAddress;

        address col1 = proposal.collateralToken1();
        address col2 = proposal.collateralToken2();

        // AAVE Outcomes
        if (col1 == AAVE) {
            (IERC20 yes, ) = proposal.wrappedOutcome(0);
            (IERC20 no, ) = proposal.wrappedOutcome(1);
            info.yesAave = address(yes);
            info.noAave = address(no);
        } else if (col2 == AAVE) {
            (IERC20 yes, ) = proposal.wrappedOutcome(2);
            (IERC20 no, ) = proposal.wrappedOutcome(3);
            info.yesAave = address(yes);
            info.noAave = address(no);
        } else {
            revert("AAVE not collateral");
        }

        // GHO Outcomes
        if (col1 == GHO) {
            (IERC20 yes, ) = proposal.wrappedOutcome(0);
            (IERC20 no, ) = proposal.wrappedOutcome(1);
            info.yesGho = address(yes);
            info.noGho = address(no);
        } else if (col2 == GHO) {
            (IERC20 yes, ) = proposal.wrappedOutcome(2);
            (IERC20 no, ) = proposal.wrappedOutcome(3);
            info.yesGho = address(yes);
            info.noGho = address(no);
        } else {
            revert("GHO not collateral");
        }
    }

    function _setupOutcomeApprovals(ProposalInfo memory info) internal {
        _approveIfNecessary(info.yesAave);
        _approveIfNecessary(info.noAave);
        _approveIfNecessary(info.yesGho);
        _approveIfNecessary(info.noGho);
    }

    function _approveIfNecessary(address token) internal {
        // 1. Approve to Permit2
        if (IERC20(token).allowance(address(this), address(permit2)) == 0) {
            IERC20(token).approve(address(permit2), type(uint256).max);
        }
        // 2. Approve Permit2 -> Universal Router (Requires Permit2 call)
        (uint160 amount, , ) = permit2.allowance(address(this), token, address(universalRouter));
        if (amount == 0) {
            permit2.approve(token, address(universalRouter), MAX_UINT160, MAX_UINT48);
        }
        // 3. Approve to FutarchyRouter
        if (IERC20(token).allowance(address(this), address(futarchyRouter)) == 0) {
            IERC20(token).approve(address(futarchyRouter), type(uint256).max);
        }
    }

    // ==========================================================================
    // STRATEGIES
    // ==========================================================================

    function _executeSpotSplit(ProposalInfo memory info, uint256 amount) internal {
        // 1. Split AAVE -> YES_AAVE + NO_AAVE
        futarchyRouter.splitPosition(info.proposal, AAVE, amount);

        // 2. Swap YES_AAVE -> YES_GHO
        uint256 yesAaveBal = IERC20(info.yesAave).balanceOf(address(this));
        if (yesAaveBal > 0) {
            _swap(info.yesAave, info.yesGho, OUTCOME_FEE, yesAaveBal);
        }

        // 3. Swap NO_AAVE -> NO_GHO
        uint256 noAaveBal = IERC20(info.noAave).balanceOf(address(this));
        if (noAaveBal > 0) {
            _swap(info.noAave, info.noGho, OUTCOME_FEE, noAaveBal);
        }

        // 4. Merge YES_GHO + NO_GHO -> GHO
        uint256 yesGhoBal = IERC20(info.yesGho).balanceOf(address(this));
        uint256 noGhoBal = IERC20(info.noGho).balanceOf(address(this));
        uint256 mergeAmount = yesGhoBal < noGhoBal ? yesGhoBal : noGhoBal;
        if (mergeAmount > 0) {
            futarchyRouter.mergePositions(info.proposal, GHO, mergeAmount);
        }

        // 5. Swap GHO -> AAVE (multi-hop via USDC -> WETH)
        uint256 ghoBal = IERC20(GHO).balanceOf(address(this));
        if (ghoBal > 0) {
            _swapGhoToAave(ghoBal);
        }
    }

    function _executeMergeSpot(ProposalInfo memory info, uint256 amount) internal {
        // 1. Swap AAVE -> GHO
        _swapAaveToGho(amount);

        uint256 ghoBal = IERC20(GHO).balanceOf(address(this));

        // 2. Split GHO -> YES_GHO + NO_GHO
        futarchyRouter.splitPosition(info.proposal, GHO, ghoBal);

        // 3. Swap YES_GHO -> YES_AAVE
        uint256 yesGhoBal = IERC20(info.yesGho).balanceOf(address(this));
        if (yesGhoBal > 0) {
            _swap(info.yesGho, info.yesAave, OUTCOME_FEE, yesGhoBal);
        }

        // 4. Swap NO_GHO -> NO_AAVE
        uint256 noGhoBal = IERC20(info.noGho).balanceOf(address(this));
        if (noGhoBal > 0) {
            _swap(info.noGho, info.noAave, OUTCOME_FEE, noGhoBal);
        }

        // 5. Merge YES_AAVE + NO_AAVE -> AAVE
        uint256 yesAaveBal = IERC20(info.yesAave).balanceOf(address(this));
        uint256 noAaveBal = IERC20(info.noAave).balanceOf(address(this));
        uint256 mergeAmount = yesAaveBal < noAaveBal ? yesAaveBal : noAaveBal;
        if (mergeAmount > 0) {
            futarchyRouter.mergePositions(info.proposal, AAVE, mergeAmount);
        }
    }

    // ==========================================================================
    // SWAP HELPERS
    // ==========================================================================

    function _swap(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn) internal {
        bytes memory path = abi.encodePacked(tokenIn, fee, tokenOut);
        
        bytes memory swapParams = abi.encode(
            address(this),
            amountIn,
            0,
            path,
            true  // payerIsUser (Permit2 pull)
        );

        bytes memory commands = abi.encodePacked(V3_SWAP_EXACT_IN);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = swapParams;

        universalRouter.execute(commands, inputs, block.timestamp);
    }

    function _swapGhoToAave(uint256 amountIn) internal {
        // GHO -> USDC (0.05%!) -> WETH (0.05%) -> AAVE (0.3%)
        bytes memory path = abi.encodePacked(
            GHO, GHO_USDC_FEE,    // 500
            USDC, USDC_WETH_FEE,  // 500
            WETH, WETH_AAVE_FEE,  // 3000
            AAVE
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

    function _swapAaveToGho(uint256 amountIn) internal {
        // AAVE -> WETH (0.3%) -> USDC (0.05%) -> GHO (0.05%!)
        bytes memory path = abi.encodePacked(
            AAVE, WETH_AAVE_FEE,  // 3000
            WETH, USDC_WETH_FEE,  // 500
            USDC, GHO_USDC_FEE,   // 500
            GHO
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
    // ADMIN
    // ==========================================================================

    function recoverTokens(address token, uint256 amount) external {
        require(msg.sender == admin, "Admin only");
        IERC20(token).safeTransfer(admin, amount);
    }
}
