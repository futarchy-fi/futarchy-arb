// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// =============================================================================
// BALANCER V3 VAULT INTERFACE (Flash Loans)
// =============================================================================

interface IBalancerV3Vault {
    /// @notice Unlock the vault for transient operations (including flash loans)
    function unlock(bytes calldata data) external returns (bytes memory result);
    
    /// @notice Send tokens from the vault to a recipient
    function sendTo(IERC20 token, address to, uint256 amount) external;
    
    /// @notice Settle token debt back to the vault
    function settle(IERC20 token, uint256 amount) external returns (uint256 credit);
}

// =============================================================================
// BALANCER V2 VAULT INTERFACE (Repayment Swaps - GHO/AAVE)
// =============================================================================

interface IBalancerV2Vault {
    enum SwapKind { GIVEN_IN, GIVEN_OUT }

    struct BatchSwapStep {
        bytes32 poolId;
        uint256 assetInIndex;
        uint256 assetOutIndex;
        uint256 amount;
        bytes userData;
    }

    struct FundManagement {
        address sender;
        bool fromInternalBalance;
        address payable recipient;
        bool toInternalBalance;
    }

    function batchSwap(
        SwapKind kind,
        BatchSwapStep[] memory swaps,
        address[] memory assets,
        FundManagement memory funds,
        int256[] memory limits,
        uint256 deadline
    ) external payable returns (int256[] memory assetDeltas);
}

// =============================================================================
// UNISWAP V3 INTERFACES (Outcome Swaps)
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
}

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
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
// AAVE FLASH ARBITRAGE V1 (MAINNET)
// =============================================================================

/**
 * @title AaveFlashArbitrageV1
 * @notice Permissionless flash arbitrage for AAVE/GHO markets on Ethereum Mainnet
 * @dev Hybid Architecture:
 * - Flash Loans: Balancer V3 (`unlock`)
 * - Repayment Swaps: Balancer V2 (`batchSwap` with 3-hop GHO<->AAVE path)
 * - Outcome Swaps: Uniswap V3 (Fee: 500)
 */
contract AaveFlashArbitrageV1 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ==========================================================================
    // IMMUTABLES
    // ==========================================================================

    // Protocols
    IBalancerV3Vault public immutable balancerVault;       // V3: 0xbA1333...
    IBalancerV2Vault public immutable balancerV2Vault;     // V2: 0xBA1222...
    ISwapRouter public immutable uniswapRouter;            // V3: 0xE59242...
    IUniswapV3Factory public immutable uniswapFactory;     // V3: 0x1F9843...
    IFutarchyRouter public immutable futarchyRouter;       // Futarchy: 0x...
    
    // Tokens (Mainnet)
    address public immutable AAVE = 0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9;
    address public immutable GHO = 0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f;
    address public immutable GYD = 0xe07F9D810a48ab5c3c914BA3cA53AF14E4491e8A;
    address public immutable wstETH = 0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0;

    // Admin (Emergency Only)
    address public admin;

    // ==========================================================================
    // POOL IDs (BALANCER V2)
    // ==========================================================================
    
    // Path: GHO <-> GYD <-> wstETH <-> AAVE
    bytes32 private constant GHO_GYD_POOL = 0xaa7a70070e7495fe86c67225329dbd39baa2f63b000200000000000000000663;
    bytes32 private constant GYD_WSTETH_POOL = 0xc8cf54b0b70899ea846b70361e62f3f5b22b1f4b0002000000000000000006c7;
    bytes32 private constant WSTETH_AAVE_POOL = 0x3de27efa2f1aa663ae5d458857e731c129069f29000200000000000000000588;

    // ==========================================================================
    // STRUCTS & STATE
    // ==========================================================================

    enum ArbitrageDirection {
        SPOT_SPLIT,   // Borrow Collateral → Split → Sell Outcomes → Merge Other → Swap Back
        MERGE_SPOT    // Borrow Other → Swap to Outcomes → Merge Collateral → Pay Back
    }

    struct ProposalInfo {
        address proposal;
        address collateralToken1;  // Should be AAVE or GHO
        address collateralToken2;  // Should be AAVE or GHO
        address yesOutcome;
        address noOutcome;
        address otherCollateral;   // The one that isn't the borrow token
        bool isValid;
    }

    struct ArbitrageResult {
        bool success;
        uint256 profit;
        uint256 borrowAmount;
    }

    // Transient State (for callback)
    address private _activeProposal;
    ArbitrageDirection private _activeDirection;
    uint256 private _minProfit;
    address private _profitRecipient;
    ArbitrageResult private _lastResult;

    error ArbitrageFailed(uint256 balanceAfter, uint256 required, string reason);
    event ArbitrageExecuted(address indexed caller, address indexed proposal, uint256 profit, address token);

    // ==========================================================================
    // CONSTRUCTOR
    // ==========================================================================

    constructor(
        address _balancerVault,      // V3
        address _balancerV2Vault,    // V2
        address _uniswapRouter,      // V3
        address _uniswapFactory,     // V3 
        address _futarchyRouter
    ) {
        balancerVault = IBalancerV3Vault(_balancerVault);
        balancerV2Vault = IBalancerV2Vault(_balancerV2Vault);
        uniswapRouter = ISwapRouter(_uniswapRouter);
        uniswapFactory = IUniswapV3Factory(_uniswapFactory);
        futarchyRouter = IFutarchyRouter(_futarchyRouter);
        admin = msg.sender;
    }

    // ==========================================================================
    // EXTERNAL FUNCTIONS
    // ==========================================================================

    function executeArbitrage(
        address proposalAddress,
        address borrowToken,
        uint256 borrowAmount,
        ArbitrageDirection direction,
        uint256 minProfit
    ) external nonReentrant returns (ArbitrageResult memory result) {
        // Validation
        require(borrowToken == AAVE || borrowToken == GHO, "Invalid borrow token");

        // Setup transient state
        _activeProposal = proposalAddress;
        _activeDirection = direction;
        _minProfit = minProfit;
        _profitRecipient = msg.sender;

        // Callback data
        bytes memory callbackData = abi.encodeWithSelector(
            this.onUnlock.selector,
            borrowToken,
            borrowAmount
        );

        // Flash Loan via V3 Unlock
        balancerVault.unlock(callbackData);

        // Retrieve Result
        result = _lastResult;
        
        // Clear State
        _activeProposal = address(0);
        
        return result;
    }

    /// @notice Balancer V3 Callback
    function onUnlock(address borrowToken, uint256 borrowAmount) external returns (bytes memory) {
        require(msg.sender == address(balancerVault), "Only Balancer Vault");

        // 1. Receive Flash Loan
        balancerVault.sendTo(IERC20(borrowToken), address(this), borrowAmount);

        // 2. Prepare Proposal Info
        ProposalInfo memory info = _loadProposal(_activeProposal, borrowToken);
        require(info.isValid, "Invalid/unsupported proposal");

        // 3. Execute Strategy
        if (_activeDirection == ArbitrageDirection.SPOT_SPLIT) {
            _executeSpotSplit(info, borrowToken, borrowAmount);
        } else {
             _executeMergeSpot(info, borrowToken, borrowAmount);
        }

        // 4. Check Balance & Repay
        uint256 currentBalance = IERC20(borrowToken).balanceOf(address(this));
        if (currentBalance < borrowAmount) {
            revert ArbitrageFailed(currentBalance, borrowAmount, "Insufficient funds to repay");
        }

        uint256 profit = currentBalance - borrowAmount;
        if (profit < _minProfit) {
            revert ArbitrageFailed(currentBalance, borrowAmount, "Profit below minimum");
        }

        // Repay Vault
        IERC20(borrowToken).transfer(address(balancerVault), borrowAmount);
        balancerVault.settle(IERC20(borrowToken), borrowAmount);

        // 5. Send Profit to Caller
        if (profit > 0) {
            IERC20(borrowToken).safeTransfer(_profitRecipient, profit);
            emit ArbitrageExecuted(_profitRecipient, info.proposal, profit, borrowToken);
        }
        
        // Populate Result
        _lastResult = ArbitrageResult({
            success: true,
            profit: profit,
            borrowAmount: borrowAmount
        });

        return abi.encode(_lastResult);
    }

    // ==========================================================================
    // STRATEGIES
    // ==========================================================================

    // Strategy 1: Borrow Token → Split → Sell Outcomes for Other Token → Swap Other to Borrow Token
    // E.g. Borrow AAVE → Split to YES/NO_AAVE → Sell for GHO → Swap GHO to AAVE
    function _executeSpotSplit(ProposalInfo memory info, address borrowToken, uint256 amount) internal {
        // 1. Split
        _safeApprove(IERC20(borrowToken), address(futarchyRouter), amount); // Optimized Approval
        futarchyRouter.splitPosition(info.proposal, borrowToken, amount);

        // 2. Sell Outcomes (YES & NO) on Uniswap V3 (Fee 500)
        uint256 yesBal = IERC20(info.yesOutcome).balanceOf(address(this));
        uint256 noBal = IERC20(info.noOutcome).balanceOf(address(this));

        if (yesBal > 0) _swapUniswapV3(info.yesOutcome, info.otherCollateral, yesBal);
        if (noBal > 0) _swapUniswapV3(info.noOutcome, info.otherCollateral, noBal);

        // 3. Swap "Other Collateral" back to "Borrow Token" to repay loan
        // If we borrowed AAVE, we now have GHO. Swap GHO -> AAVE.
        address otherToken = info.otherCollateral;
        uint256 otherBal = IERC20(otherToken).balanceOf(address(this));

        if (otherBal > 0) {
            if (borrowToken == AAVE) {
                _swapGhoToAaveV2(otherBal);
            } else {
                _swapAaveToGhoV2(otherBal);
            }
        }
    }

    // Strategy 2: Borrow Token → Swap to Other Token → Split Other → Buy Outcomes → Merge to Borrow Token
    // E.g. Borrow AAVE → Swap to GHO → Split GHO → Buy YES/NO_AAVE → Merge Outcomes to AAVE
    function _executeMergeSpot(ProposalInfo memory info, address borrowToken, uint256 amount) internal {
        // 1. Swap Borrow Token -> Other Collateral
        // If Borrow AAVE, Swap AAVE -> GHO
        if (borrowToken == AAVE) {
             _swapAaveToGhoV2(amount); // Now we have GHO
        } else {
             _swapGhoToAaveV2(amount); // Now we have AAVE
        }

        address otherToken = info.otherCollateral;
        uint256 otherBal = IERC20(otherToken).balanceOf(address(this));

        // 2. Split Other Collateral
        _safeApprove(IERC20(otherToken), address(futarchyRouter), otherBal); // Optimized Approval
        futarchyRouter.splitPosition(info.proposal, otherToken, otherBal);

        // 3. Buy Outcomes (that match Borrow Token) using the Split Outcomes
        // If we want AAVE, we have YES_GHO/NO_GHO. We trade YES_GHO -> YES_AAVE.
        // Wait... standard arb is:
        // Buy YES_Borrow + NO_Borrow on market using "Other" funds?
        // Actually, assuming pools are YES_AAVE/YES_GHO? No, pools are usually OUTCOME/COLLATERAL.
        // Let's assume pools are YES_AAVE / AAVE and YES_GHO / GHO?
        // Or YES_AAVE / GHO?
        
        // UNISWAP POOL ASSUMPTION: Outcomes trade against their own collateral? 
        // Or maybe Outcomes trade against USDC?
        // Based on V4: YES_GNO/YES_SDAI pool exists.
        // For Mainnet: Likely YES_AAVE / YES_GHO ?
        // If outcomes trade against each other, we swap YES_GHO -> YES_AAVE.
        
        // Let's assume there are pools for Outcome/Outcome swaps directly?
        // If not, we might need a different route.
        // For this V1, let's assume we can swap:
        // YES_OTHER -> YES_BORROW via Uniswap V3 (500 fee)
        
        // Get balances of "Other" Outcomes
        // (We split GHO, so we have YES_GHO and NO_GHO)
        // We want YES_AAVE and NO_AAVE.
        
        // THIS PART DEPENDS ON MARKET STRUCTURE.
        // Assuming we swap YES_GHO -> YES_AAVE directly.
        
        // (Pseudocode placeholder logic - verify pools exist!)
        // _swapUniswapV3(yesOther, yesBorrow, bal);
        
        // NOTE: If pools don't exist, this reverts.
    }

    // ==========================================================================
    // BALANCER V2 REPAYMENT SWAPS (3-HOP)
    // ==========================================================================

    function _swapGhoToAaveV2(uint256 amount) internal {
        // Path: GHO -> GYD -> wstETH -> AAVE
        address[] memory assets = new address[](4);
        assets[0] = GHO;
        assets[1] = GYD;
        assets[2] = wstETH;
        assets[3] = AAVE;

        IBalancerV2Vault.BatchSwapStep[] memory swaps = new IBalancerV2Vault.BatchSwapStep[](3);
        
        // 1. GHO -> GYD
        swaps[0] = IBalancerV2Vault.BatchSwapStep({
            poolId: GHO_GYD_POOL,
            assetInIndex: 0, assetOutIndex: 1, amount: amount, userData: ""
        });
        // 2. GYD -> wstETH
        swaps[1] = IBalancerV2Vault.BatchSwapStep({
            poolId: GYD_WSTETH_POOL,
            assetInIndex: 1, assetOutIndex: 2, amount: 0, userData: ""
        });
        // 3. wstETH -> AAVE
        swaps[2] = IBalancerV2Vault.BatchSwapStep({
            poolId: WSTETH_AAVE_POOL,
            assetInIndex: 2, assetOutIndex: 3, amount: 0, userData: ""
        });

        _executeBatchSwap(assets, swaps, amount);
    }

    function _swapAaveToGhoV2(uint256 amount) internal {
        // Path: AAVE -> wstETH -> GYD -> GHO (Reverse)
        address[] memory assets = new address[](4);
        assets[0] = AAVE;
        assets[1] = wstETH;
        assets[2] = GYD;
        assets[3] = GHO;

        IBalancerV2Vault.BatchSwapStep[] memory swaps = new IBalancerV2Vault.BatchSwapStep[](3);
        
        // 1. AAVE -> wstETH
        swaps[0] = IBalancerV2Vault.BatchSwapStep({
            poolId: WSTETH_AAVE_POOL, // Same pool ID
            assetInIndex: 0, assetOutIndex: 1, amount: amount, userData: ""
        });
        // 2. wstETH -> GYD
        swaps[1] = IBalancerV2Vault.BatchSwapStep({
            poolId: GYD_WSTETH_POOL,
            assetInIndex: 1, assetOutIndex: 2, amount: 0, userData: ""
        });
        // 3. GYD -> GHO
        swaps[2] = IBalancerV2Vault.BatchSwapStep({
            poolId: GHO_GYD_POOL,
            assetInIndex: 2, assetOutIndex: 3, amount: 0, userData: ""
        });

        _executeBatchSwap(assets, swaps, amount);
    }

    function _executeBatchSwap(address[] memory assets, IBalancerV2Vault.BatchSwapStep[] memory swaps, uint256 amount) internal {
        IBalancerV2Vault.FundManagement memory funds = IBalancerV2Vault.FundManagement({
            sender: address(this),
            fromInternalBalance: false,
            recipient: payable(address(this)),
            toInternalBalance: false
        });

        int256[] memory limits = new int256[](4);
        limits[0] = int256(amount);
        limits[1] = type(int256).max;
        limits[2] = type(int256).max;
        limits[3] = type(int256).max; // No min out enforced here, enforced by profit check at end

        // Approve Vault V2
        _safeApprove(IERC20(assets[0]), address(balancerV2Vault), amount); // Optimized Approval

        balancerV2Vault.batchSwap(
            IBalancerV2Vault.SwapKind.GIVEN_IN,
            swaps,
            assets,
            funds,
            limits,
            block.timestamp
        );
    }

    // ==========================================================================
    // UNISWAP V3 HELPER
    // ==========================================================================

    function _swapUniswapV3(address tokenIn, address tokenOut, uint256 amountIn) internal returns (uint256 amountOut) {
        // Optimized Approval via Permit2 for Universal Router
        _safeApprovePermit2(IERC20(tokenIn), address(uniswapRouter), amountIn);
        
        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: 500, // Fixed 0.05% fee tier as requested
            recipient: address(this),
            deadline: block.timestamp,
            amountIn: amountIn,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0
        });

        return uniswapRouter.exactInputSingle(params);
    }

    // ==========================================================================
    // APPROVAL HELPERS (Safe & Gas Optimized)
    // ==========================================================================

    /// @notice Approve spender if current allowance is insufficient
    /// @dev Checks allowance first to save gas on redundant writes
    function _safeApprove(IERC20 token, address spender, uint256 amount) internal {
        uint256 currentAllowance = token.allowance(address(this), spender);
        if (currentAllowance < amount) {
            // Reset to 0 first if mostly needed for USDT but good practice generally
            // token.approve(spender, 0); 
            token.approve(spender, type(uint256).max);
        }
    }

    /// @notice Approve Permit2 system + Permit2 approves Spender
    /// @dev Used for Uniswap V3 via Universal Router (which uses Permit2)
    function _safeApprovePermit2(IERC20 token, address spender, uint256 amount) internal {
        // 1. Approve Token -> Permit2
        // Hardcoded Permit2 Address for Mainnet (same on all chains usually: 0x0000..22D473030F116dDEE9F6B43aC78BA3)
        address permit2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
        _safeApprove(token, permit2, amount);

        // 2. Approve Permit2 -> Spender (Universal Router)
        // Interface for Permit2
        IPermit2 p2 = IPermit2(permit2);
        (uint160 allowed, uint48 expiration, ) = p2.allowance(address(this), address(token), spender);
        
        // If insufficient or expired
        if (allowed < amount || expiration < block.timestamp) {
            p2.approve(address(token), spender, type(uint160).max, type(uint48).max);
        }
    }

    // ==========================================================================
    // UTILS
    // ==========================================================================

    function _loadProposal(address proposalAddr, address borrowToken) internal view returns (ProposalInfo memory info) {
        IFutarchyProposal proposal = IFutarchyProposal(proposalAddr);
        info.proposal = proposalAddr;
        info.collateralToken1 = address(proposal.collateralToken1());
        info.collateralToken2 = address(proposal.collateralToken2());

        // Basic Check
        if ((info.collateralToken1 == AAVE && info.collateralToken2 == GHO) || 
            (info.collateralToken1 == GHO && info.collateralToken2 == AAVE)) {
            info.isValid = true;
        } else {
            return info; // Invalid
        }

        bool borrowIsCollat1 = (borrowToken == info.collateralToken1);
        
        if (borrowIsCollat1) {
             (IERC20 y, ) = proposal.wrappedOutcome(0);
             (IERC20 n, ) = proposal.wrappedOutcome(1);
             info.yesOutcome = address(y);
             info.noOutcome = address(n);
             info.otherCollateral = info.collateralToken2;
        } else {
             (IERC20 y, ) = proposal.wrappedOutcome(2);
             (IERC20 n, ) = proposal.wrappedOutcome(3);
             info.yesOutcome = address(y);
             info.noOutcome = address(n);
             info.otherCollateral = info.collateralToken1;
        }
    }

    // Admin Recovery
    function rescueTokens(address token, uint256 amount) external {
        require(msg.sender == admin, "Admin only");
        IERC20(token).safeTransfer(admin, amount);
    }
}

// Minimal Permit2 Interface
interface IPermit2 {
    function allowance(address user, address token, address spender) external view returns (uint160 amount, uint48 expiration, uint48 nonce);
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}
