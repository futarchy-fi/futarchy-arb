// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// =============================================================================
// BALANCER V3 VAULT INTERFACE (Flash Loans)
// =============================================================================

interface IBalancerV3Vault {
    function unlock(bytes calldata data) external returns (bytes memory result);
    function sendTo(IERC20 token, address to, uint256 amount) external;
    function settle(IERC20 token, uint256 amount) external returns (uint256 credit);
}

// =============================================================================
// BALANCER V2 VAULT INTERFACE (Repayment Swaps)
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
// AAVE FLASH ARBITRAGE V2 (MAINNET) - CORRECTED OUTCOME SWAPS
// =============================================================================

/**
 * @title AaveFlashArbitrageV2
 * @notice Permissionless flash arbitrage for AAVE/GHO markets on Ethereum Mainnet
 * @dev V2 FIX: Swaps outcomes against each other (YES_AAVE <-> YES_GHO, NO_AAVE <-> NO_GHO)
 *      instead of outcomes against collateral (which has no liquidity).
 * 
 * Architecture:
 * - Flash Loans: Balancer V3 (`unlock`)
 * - Outcome Swaps: Uniswap V3 (YES_AAVE/YES_GHO & NO_AAVE/NO_GHO pools, Fee: 500)
 * - Repayment Swaps: Balancer V2 (`batchSwap` with 3-hop GHO<->AAVE path)
 * 
 * Strategy SPOT_SPLIT (Borrow AAVE):
 *   1. Flash borrow AAVE
 *   2. Split AAVE -> YES_AAVE + NO_AAVE
 *   3. Swap YES_AAVE -> YES_GHO (Uniswap V3)
 *   4. Swap NO_AAVE -> NO_GHO (Uniswap V3)
 *   5. Merge YES_GHO + NO_GHO -> GHO
 *   6. Swap GHO -> AAVE (Balancer V2)
 *   7. Repay flash loan + keep profit
 */
contract AaveFlashArbitrageV2 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ==========================================================================
    // IMMUTABLES
    // ==========================================================================

    IBalancerV3Vault public immutable balancerVault;       // V3: 0xbA1333...
    IBalancerV2Vault public immutable balancerV2Vault;     // V2: 0xBA1222...
    ISwapRouter public immutable uniswapRouter;            // V3: 0xE59242...
    IUniswapV3Factory public immutable uniswapFactory;     // V3: 0x1F9843...
    IFutarchyRouter public immutable futarchyRouter;       // Futarchy: 0xAc9B...
    
    // Tokens (Mainnet)
    address public constant AAVE = 0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9;
    address public constant GHO = 0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f;
    address public constant GYD = 0xe07F9D810a48ab5c3c914BA3cA53AF14E4491e8A;
    address public constant wstETH = 0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0;

    // Admin (Emergency Only)
    address public admin;

    // ==========================================================================
    // POOL IDs (BALANCER V2 - 3-hop GHO<->AAVE)
    // ==========================================================================
    
    bytes32 private constant GHO_GYD_POOL = 0xaa7a70070e7495fe86c67225329dbd39baa2f63b000200000000000000000663;
    bytes32 private constant GYD_WSTETH_POOL = 0xc8cf54b0b70899ea846b70361e62f3f5b22b1f4b0002000000000000000006c7;
    bytes32 private constant WSTETH_AAVE_POOL = 0x3de27efa2f1aa663ae5d458857e731c129069f29000200000000000000000588;

    // ==========================================================================
    // STRUCTS & STATE
    // ==========================================================================

    enum ArbitrageDirection {
        SPOT_SPLIT,   // Borrow Token -> Split -> Swap Outcomes -> Merge Other -> Swap to Borrow -> Repay
        MERGE_SPOT    // Borrow Token -> Swap to Other -> Split Other -> Swap to Borrow Outcomes -> Merge -> Repay
    }

    struct ProposalInfo {
        address proposal;
        address collateralToken1;
        address collateralToken2;
        // Outcomes for collateral 1 (AAVE)
        address yesAave;  // wrappedOutcome(0)
        address noAave;   // wrappedOutcome(1)
        // Outcomes for collateral 2 (GHO)
        address yesGho;   // wrappedOutcome(2)
        address noGho;    // wrappedOutcome(3)
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
    address private _borrowToken;
    ArbitrageResult private _lastResult;

    error ArbitrageFailed(uint256 balanceAfter, uint256 required, string reason);
    event ArbitrageExecuted(address indexed caller, address indexed proposal, uint256 profit, address token);

    // ==========================================================================
    // CONSTRUCTOR
    // ==========================================================================

    constructor(
        address _balancerVault,
        address _balancerV2Vault,
        address _uniswapRouter,
        address _uniswapFactory,
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
        require(borrowToken == AAVE || borrowToken == GHO, "Invalid borrow token");

        // Setup transient state
        _activeProposal = proposalAddress;
        _activeDirection = direction;
        _minProfit = minProfit;
        _profitRecipient = msg.sender;
        _borrowToken = borrowToken;

        // Flash Loan via V3 Unlock
        bytes memory callbackData = abi.encodeWithSelector(
            this.onUnlock.selector,
            borrowToken,
            borrowAmount
        );
        balancerVault.unlock(callbackData);

        result = _lastResult;
        _activeProposal = address(0);
        
        return result;
    }

    /// @notice Balancer V3 Callback
    function onUnlock(address borrowToken, uint256 borrowAmount) external returns (bytes memory) {
        require(msg.sender == address(balancerVault), "Only Balancer Vault");

        // 1. Receive Flash Loan
        balancerVault.sendTo(IERC20(borrowToken), address(this), borrowAmount);

        // 2. Load Proposal Info (all 4 outcome tokens)
        ProposalInfo memory info = _loadProposal(_activeProposal);
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
        
        _lastResult = ArbitrageResult({
            success: true,
            profit: profit,
            borrowAmount: borrowAmount
        });

        return abi.encode(_lastResult);
    }

    // ==========================================================================
    // STRATEGY: SPOT_SPLIT
    // ==========================================================================
    
    /**
     * @dev SPOT_SPLIT Strategy (Borrow AAVE example):
     *   1. Split AAVE -> YES_AAVE + NO_AAVE
     *   2. Swap YES_AAVE -> YES_GHO (Uniswap V3 pool exists!)
     *   3. Swap NO_AAVE -> NO_GHO (Uniswap V3 pool exists!)
     *   4. Merge YES_GHO + NO_GHO -> GHO
     *   5. Swap GHO -> AAVE (Balancer V2 3-hop)
     *   6. Repay AAVE loan
     */
    function _executeSpotSplit(ProposalInfo memory info, address borrowToken, uint256 amount) internal {
        // Determine which token we're borrowing
        bool borrowingAave = (borrowToken == AAVE);
        
        // 1. Split the borrowed token into YES + NO outcomes
        _safeApprove(IERC20(borrowToken), address(futarchyRouter), amount);
        futarchyRouter.splitPosition(info.proposal, borrowToken, amount);

        if (borrowingAave) {
            // We have YES_AAVE and NO_AAVE
            uint256 yesAaveBal = IERC20(info.yesAave).balanceOf(address(this));
            uint256 noAaveBal = IERC20(info.noAave).balanceOf(address(this));

            // 2. Swap YES_AAVE -> YES_GHO
            if (yesAaveBal > 0) {
                _swapUniswapV3(info.yesAave, info.yesGho, yesAaveBal);
            }
            
            // 3. Swap NO_AAVE -> NO_GHO
            if (noAaveBal > 0) {
                _swapUniswapV3(info.noAave, info.noGho, noAaveBal);
            }

            // 4. Merge YES_GHO + NO_GHO -> GHO
            uint256 yesGhoBal = IERC20(info.yesGho).balanceOf(address(this));
            uint256 noGhoBal = IERC20(info.noGho).balanceOf(address(this));
            uint256 mergeAmount = yesGhoBal < noGhoBal ? yesGhoBal : noGhoBal;
            
            if (mergeAmount > 0) {
                _safeApprove(IERC20(info.yesGho), address(futarchyRouter), mergeAmount);
                _safeApprove(IERC20(info.noGho), address(futarchyRouter), mergeAmount);
                futarchyRouter.mergePositions(info.proposal, GHO, mergeAmount);
            }

            // 5. Swap GHO -> AAVE (via Balancer V2)
            uint256 ghoBal = IERC20(GHO).balanceOf(address(this));
            if (ghoBal > 0) {
                _swapGhoToAaveV2(ghoBal);
            }
        } else {
            // Borrowing GHO - mirror logic
            uint256 yesGhoBal = IERC20(info.yesGho).balanceOf(address(this));
            uint256 noGhoBal = IERC20(info.noGho).balanceOf(address(this));

            // Swap YES_GHO -> YES_AAVE
            if (yesGhoBal > 0) {
                _swapUniswapV3(info.yesGho, info.yesAave, yesGhoBal);
            }
            
            // Swap NO_GHO -> NO_AAVE
            if (noGhoBal > 0) {
                _swapUniswapV3(info.noGho, info.noAave, noGhoBal);
            }

            // Merge YES_AAVE + NO_AAVE -> AAVE
            uint256 yesAaveBal = IERC20(info.yesAave).balanceOf(address(this));
            uint256 noAaveBal = IERC20(info.noAave).balanceOf(address(this));
            uint256 mergeAmount = yesAaveBal < noAaveBal ? yesAaveBal : noAaveBal;
            
            if (mergeAmount > 0) {
                _safeApprove(IERC20(info.yesAave), address(futarchyRouter), mergeAmount);
                _safeApprove(IERC20(info.noAave), address(futarchyRouter), mergeAmount);
                futarchyRouter.mergePositions(info.proposal, AAVE, mergeAmount);
            }

            // Swap AAVE -> GHO (via Balancer V2)
            uint256 aaveBal = IERC20(AAVE).balanceOf(address(this));
            if (aaveBal > 0) {
                _swapAaveToGhoV2(aaveBal);
            }
        }
    }

    // ==========================================================================
    // STRATEGY: MERGE_SPOT
    // ==========================================================================
    
    /**
     * @dev MERGE_SPOT Strategy (Borrow AAVE example):
     *   1. Swap AAVE -> GHO (Balancer V2)
     *   2. Split GHO -> YES_GHO + NO_GHO
     *   3. Swap YES_GHO -> YES_AAVE
     *   4. Swap NO_GHO -> NO_AAVE
     *   5. Merge YES_AAVE + NO_AAVE -> AAVE
     *   6. Repay AAVE loan
     */
    function _executeMergeSpot(ProposalInfo memory info, address borrowToken, uint256 amount) internal {
        bool borrowingAave = (borrowToken == AAVE);
        
        if (borrowingAave) {
            // 1. Swap AAVE -> GHO
            _swapAaveToGhoV2(amount);
            
            uint256 ghoBal = IERC20(GHO).balanceOf(address(this));
            
            // 2. Split GHO -> YES_GHO + NO_GHO
            _safeApprove(IERC20(GHO), address(futarchyRouter), ghoBal);
            futarchyRouter.splitPosition(info.proposal, GHO, ghoBal);
            
            // 3. Swap YES_GHO -> YES_AAVE
            uint256 yesGhoBal = IERC20(info.yesGho).balanceOf(address(this));
            if (yesGhoBal > 0) {
                _swapUniswapV3(info.yesGho, info.yesAave, yesGhoBal);
            }
            
            // 4. Swap NO_GHO -> NO_AAVE
            uint256 noGhoBal = IERC20(info.noGho).balanceOf(address(this));
            if (noGhoBal > 0) {
                _swapUniswapV3(info.noGho, info.noAave, noGhoBal);
            }
            
            // 5. Merge YES_AAVE + NO_AAVE -> AAVE
            uint256 yesAaveBal = IERC20(info.yesAave).balanceOf(address(this));
            uint256 noAaveBal = IERC20(info.noAave).balanceOf(address(this));
            uint256 mergeAmount = yesAaveBal < noAaveBal ? yesAaveBal : noAaveBal;
            
            if (mergeAmount > 0) {
                _safeApprove(IERC20(info.yesAave), address(futarchyRouter), mergeAmount);
                _safeApprove(IERC20(info.noAave), address(futarchyRouter), mergeAmount);
                futarchyRouter.mergePositions(info.proposal, AAVE, mergeAmount);
            }
        } else {
            // Borrowing GHO - mirror logic
            // 1. Swap GHO -> AAVE
            _swapGhoToAaveV2(amount);
            
            uint256 aaveBal = IERC20(AAVE).balanceOf(address(this));
            
            // 2. Split AAVE -> YES_AAVE + NO_AAVE
            _safeApprove(IERC20(AAVE), address(futarchyRouter), aaveBal);
            futarchyRouter.splitPosition(info.proposal, AAVE, aaveBal);
            
            // 3. Swap YES_AAVE -> YES_GHO
            uint256 yesAaveBal = IERC20(info.yesAave).balanceOf(address(this));
            if (yesAaveBal > 0) {
                _swapUniswapV3(info.yesAave, info.yesGho, yesAaveBal);
            }
            
            // 4. Swap NO_AAVE -> NO_GHO
            uint256 noAaveBal = IERC20(info.noAave).balanceOf(address(this));
            if (noAaveBal > 0) {
                _swapUniswapV3(info.noAave, info.noGho, noAaveBal);
            }
            
            // 5. Merge YES_GHO + NO_GHO -> GHO
            uint256 yesGhoBal = IERC20(info.yesGho).balanceOf(address(this));
            uint256 noGhoBal = IERC20(info.noGho).balanceOf(address(this));
            uint256 mergeAmount = yesGhoBal < noGhoBal ? yesGhoBal : noGhoBal;
            
            if (mergeAmount > 0) {
                _safeApprove(IERC20(info.yesGho), address(futarchyRouter), mergeAmount);
                _safeApprove(IERC20(info.noGho), address(futarchyRouter), mergeAmount);
                futarchyRouter.mergePositions(info.proposal, GHO, mergeAmount);
            }
        }
    }

    // ==========================================================================
    // BALANCER V2 REPAYMENT SWAPS (3-HOP)
    // ==========================================================================

    function _swapGhoToAaveV2(uint256 amount) internal {
        address[] memory assets = new address[](4);
        assets[0] = GHO;
        assets[1] = GYD;
        assets[2] = wstETH;
        assets[3] = AAVE;

        IBalancerV2Vault.BatchSwapStep[] memory swaps = new IBalancerV2Vault.BatchSwapStep[](3);
        swaps[0] = IBalancerV2Vault.BatchSwapStep({
            poolId: GHO_GYD_POOL, assetInIndex: 0, assetOutIndex: 1, amount: amount, userData: ""
        });
        swaps[1] = IBalancerV2Vault.BatchSwapStep({
            poolId: GYD_WSTETH_POOL, assetInIndex: 1, assetOutIndex: 2, amount: 0, userData: ""
        });
        swaps[2] = IBalancerV2Vault.BatchSwapStep({
            poolId: WSTETH_AAVE_POOL, assetInIndex: 2, assetOutIndex: 3, amount: 0, userData: ""
        });

        _executeBatchSwap(assets, swaps, amount);
    }

    function _swapAaveToGhoV2(uint256 amount) internal {
        address[] memory assets = new address[](4);
        assets[0] = AAVE;
        assets[1] = wstETH;
        assets[2] = GYD;
        assets[3] = GHO;

        IBalancerV2Vault.BatchSwapStep[] memory swaps = new IBalancerV2Vault.BatchSwapStep[](3);
        swaps[0] = IBalancerV2Vault.BatchSwapStep({
            poolId: WSTETH_AAVE_POOL, assetInIndex: 0, assetOutIndex: 1, amount: amount, userData: ""
        });
        swaps[1] = IBalancerV2Vault.BatchSwapStep({
            poolId: GYD_WSTETH_POOL, assetInIndex: 1, assetOutIndex: 2, amount: 0, userData: ""
        });
        swaps[2] = IBalancerV2Vault.BatchSwapStep({
            poolId: GHO_GYD_POOL, assetInIndex: 2, assetOutIndex: 3, amount: 0, userData: ""
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
        limits[3] = type(int256).max;

        _safeApprove(IERC20(assets[0]), address(balancerV2Vault), amount);

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
        _safeApprove(IERC20(tokenIn), address(uniswapRouter), amountIn);
        
        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: 500, // 0.05% fee tier
            recipient: address(this),
            deadline: block.timestamp,
            amountIn: amountIn,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0
        });

        return uniswapRouter.exactInputSingle(params);
    }

    // ==========================================================================
    // APPROVAL HELPER
    // ==========================================================================

    function _safeApprove(IERC20 token, address spender, uint256 amount) internal {
        uint256 currentAllowance = token.allowance(address(this), spender);
        if (currentAllowance < amount) {
            token.approve(spender, type(uint256).max);
        }
    }

    // ==========================================================================
    // UTILS
    // ==========================================================================

    function _loadProposal(address proposalAddr) internal view returns (ProposalInfo memory info) {
        IFutarchyProposal proposal = IFutarchyProposal(proposalAddr);
        info.proposal = proposalAddr;
        info.collateralToken1 = address(proposal.collateralToken1());
        info.collateralToken2 = address(proposal.collateralToken2());

        // Validate this is an AAVE/GHO market
        bool validPair = (info.collateralToken1 == AAVE && info.collateralToken2 == GHO) || 
                         (info.collateralToken1 == GHO && info.collateralToken2 == AAVE);
        
        if (!validPair) {
            return info; // isValid stays false
        }
        
        info.isValid = true;

        // Load all 4 outcome tokens
        // Index 0,1 = outcomes for collateralToken1
        // Index 2,3 = outcomes for collateralToken2
        (IERC20 y0, ) = proposal.wrappedOutcome(0);
        (IERC20 n0, ) = proposal.wrappedOutcome(1);
        (IERC20 y1, ) = proposal.wrappedOutcome(2);
        (IERC20 n1, ) = proposal.wrappedOutcome(3);
        
        // Assign based on which token is collateralToken1
        if (info.collateralToken1 == AAVE) {
            info.yesAave = address(y0);
            info.noAave = address(n0);
            info.yesGho = address(y1);
            info.noGho = address(n1);
        } else {
            info.yesGho = address(y0);
            info.noGho = address(n0);
            info.yesAave = address(y1);
            info.noAave = address(n1);
        }
    }

    // Admin Recovery
    function rescueTokens(address token, uint256 amount) external {
        require(msg.sender == admin, "Admin only");
        IERC20(token).safeTransfer(admin, amount);
    }
}
