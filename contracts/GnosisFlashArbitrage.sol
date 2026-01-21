// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// =============================================================================
// INTERFACE DEFINITIONS
// =============================================================================

/**
 * @dev Balancer V3 Vault Interface for swaps and flash loans
 */
interface IBalancerVault {
    enum SwapKind { GIVEN_IN, GIVEN_OUT }
    
    struct SingleSwap {
        bytes32 poolId;
        SwapKind kind;
        address assetIn;
        address assetOut;
        uint256 amount;
        bytes userData;
    }
    
    struct FundManagement {
        address sender;
        bool fromInternalBalance;
        address payable recipient;
        bool toInternalBalance;
    }
    
    function swap(
        SingleSwap memory singleSwap,
        FundManagement memory funds,
        uint256 limit,
        uint256 deadline
    ) external payable returns (uint256);
    
    function flashLoan(
        address recipient,
        IERC20[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
    
    function getPoolTokens(bytes32 poolId) external view returns (
        address[] memory tokens,
        uint256[] memory balances,
        uint256 lastChangeBlock
    );
}

/**
 * @dev Balancer Flash Loan Recipient Interface
 */
interface IFlashLoanRecipient {
    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external;
}

/**
 * @dev Swapr Algebra V3 Router Interface
 */
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
    
    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 limitSqrtPrice;
    }
    
    function exactInputSingle(ExactInputSingleParams calldata params) 
        external payable returns (uint256 amountOut);
    
    function exactOutputSingle(ExactOutputSingleParams calldata params) 
        external payable returns (uint256 amountIn);
    
    function WNativeToken() external view returns (address);
}

/**
 * @dev Futarchy Router Interface for split/merge operations
 */
interface IFutarchyRouter {
    function splitPosition(
        address proposal,
        address collateralToken,
        uint256 amount
    ) external;
    
    function mergePositions(
        address proposal,
        address collateralToken,
        uint256 amount
    ) external;
    
    function redeemPositions(
        address proposal,
        address collateralToken,
        uint256 amount
    ) external;
}

/**
 * @dev Wrapped Native Token Interface (WAGNO/WETH style)
 */
interface IWETH {
    function deposit() external payable;
    function withdraw(uint256 wad) external;
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
}

/**
 * @dev Static aToken Interface (for WAGNO wrapping)
 */
interface IStaticAToken {
    function deposit(address recipient, uint256 amount, uint16 referralCode, bool fromUnderlying) 
        external returns (uint256);
    function redeem(address recipient, uint256 shares, bool toUnderlying) 
        external returns (uint256, uint256);
    function staticToDynamicAmount(uint256 amount) external view returns (uint256);
    function dynamicToStaticAmount(uint256 amount) external view returns (uint256);
}

// =============================================================================
// FLASH ARBITRAGE CONTRACT
// =============================================================================

/**
 * @title GnosisFlashArbitrage
 * @notice Flash loan arbitrage between Balancer V3, Swapr Algebra V3, and Futarchy on Gnosis Chain
 * @dev Implements IFlashLoanRecipient for Balancer V3 flash loans
 */
contract GnosisFlashArbitrage is IFlashLoanRecipient, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    
    // ==========================================================================
    // STATE VARIABLES
    // ==========================================================================
    
    // Core protocol contracts
    IBalancerVault public balancerVault;
    IAlgebraSwapRouter public swaprRouter;
    IFutarchyRouter public futarchyRouter;
    
    // Token addresses
    address public gnoToken;
    address public sdaiToken;
    address public wagnoToken;
    
    // Pool configuration
    bytes32 public balancerPoolId;
    
    // Active arbitrage state (used during flash loan callback)
    ArbitrageParams private activeArbitrage;
    
    // ==========================================================================
    // STRUCTS
    // ==========================================================================
    
    struct ArbitrageParams {
        ArbitrageType arbType;
        address proposal;           // Futarchy proposal address
        uint256 amountIn;
        uint256 minProfit;
        address[] tokensPath;       // For multi-hop swaps
    }
    
    enum ArbitrageType {
        BALANCER_TO_SWAPR,      // Swap on Balancer, reverse on Swapr
        SWAPR_TO_BALANCER,      // Swap on Swapr, reverse on Balancer
        FUTARCHY_MERGE,          // Buy YES+NO, merge to collateral, sell
        FUTARCHY_SPLIT,          // Buy collateral, split to YES+NO, sell
        CUSTOM                   // Custom sequence
    }
    
    // ==========================================================================
    // EVENTS
    // ==========================================================================
    
    event ArbitrageExecuted(
        ArbitrageType indexed arbType,
        address indexed borrowedToken,
        uint256 borrowedAmount,
        uint256 profit
    );
    
    event ConfigUpdated(string configName, address newValue);
    event PoolIdUpdated(bytes32 newPoolId);
    event TokensRecovered(address token, uint256 amount);
    
    // ==========================================================================
    // CONSTRUCTOR
    // ==========================================================================
    
    constructor(
        address _balancerVault,
        address _swaprRouter,
        address _futarchyRouter,
        address _gnoToken,
        address _sdaiToken,
        address _wagnoToken,
        bytes32 _balancerPoolId
    ) Ownable(msg.sender) {
        balancerVault = IBalancerVault(_balancerVault);
        swaprRouter = IAlgebraSwapRouter(_swaprRouter);
        futarchyRouter = IFutarchyRouter(_futarchyRouter);
        
        gnoToken = _gnoToken;
        sdaiToken = _sdaiToken;
        wagnoToken = _wagnoToken;
        
        balancerPoolId = _balancerPoolId;
        
        // Pre-approve tokens to protocols for gas efficiency
        _setupApprovals();
    }
    
    // ==========================================================================
    // MAIN ARBITRAGE FUNCTIONS
    // ==========================================================================
    
    /**
     * @notice Execute a flash loan arbitrage
     * @dev Profits are automatically sent back to the caller (msg.sender) after execution
     * @param borrowToken Token to borrow from Balancer
     * @param borrowAmount Amount to borrow
     * @param arbType Type of arbitrage to execute
     * @param proposal Futarchy proposal address (if applicable)
     * @param minProfit Minimum profit required (reverts if not met)
     */
    function executeArbitrage(
        address borrowToken,
        uint256 borrowAmount,
        ArbitrageType arbType,
        address proposal,
        uint256 minProfit
    ) external onlyOwner nonReentrant {
        // Record balance before flash loan
        uint256 balanceBefore = IERC20(borrowToken).balanceOf(address(this));
        
        // Store arbitrage params for callback
        activeArbitrage = ArbitrageParams({
            arbType: arbType,
            proposal: proposal,
            amountIn: borrowAmount,
            minProfit: minProfit,
            tokensPath: new address[](0)
        });
        
        // Prepare flash loan request
        IERC20[] memory tokens = new IERC20[](1);
        tokens[0] = IERC20(borrowToken);
        
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = borrowAmount;
        
        // Initiate flash loan - callback will execute arbitrage
        balancerVault.flashLoan(
            address(this),
            tokens,
            amounts,
            abi.encode(arbType, proposal)
        );
        
        // After flash loan callback completes, profits remain in contract
        // Transfer ALL profits back to the caller (msg.sender)
        uint256 balanceAfter = IERC20(borrowToken).balanceOf(address(this));
        uint256 profit = balanceAfter - balanceBefore;
        
        if (profit > 0) {
            IERC20(borrowToken).safeTransfer(msg.sender, profit);
        }
    }
    
    /**
     * @notice Flash loan callback from Balancer Vault
     * @dev MUST repay borrowed tokens before returning
     */
    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external override {
        require(msg.sender == address(balancerVault), "Only Balancer Vault");
        
        // Decode arbitrage parameters
        (ArbitrageType arbType, address proposal) = abi.decode(userData, (ArbitrageType, address));
        
        address borrowedToken = address(tokens[0]);
        uint256 borrowedAmount = amounts[0];
        uint256 fee = feeAmounts[0];
        uint256 repayAmount = borrowedAmount + fee;
        
        // Record initial balance to calculate profit
        uint256 initialBalance = IERC20(borrowedToken).balanceOf(address(this));
        
        // Execute the arbitrage strategy based on type
        if (arbType == ArbitrageType.BALANCER_TO_SWAPR) {
            _executeBalancerToSwapr(borrowedToken, borrowedAmount);
        } else if (arbType == ArbitrageType.SWAPR_TO_BALANCER) {
            _executeSwaprToBalancer(borrowedToken, borrowedAmount);
        } else if (arbType == ArbitrageType.FUTARCHY_MERGE) {
            _executeFutarchyMerge(borrowedToken, borrowedAmount, proposal);
        } else if (arbType == ArbitrageType.FUTARCHY_SPLIT) {
            _executeFutarchySplit(borrowedToken, borrowedAmount, proposal);
        }
        
        // Ensure we have enough to repay
        uint256 finalBalance = IERC20(borrowedToken).balanceOf(address(this));
        require(finalBalance >= repayAmount, "Insufficient balance to repay");
        
        // Calculate profit
        uint256 profit = finalBalance - repayAmount;
        require(profit >= activeArbitrage.minProfit, "Profit below minimum");
        
        // Repay flash loan (Balancer pulls the tokens automatically)
        IERC20(borrowedToken).safeTransfer(address(balancerVault), repayAmount);
        
        emit ArbitrageExecuted(arbType, borrowedToken, borrowedAmount, profit);
    }
    
    // ==========================================================================
    // ARBITRAGE STRATEGIES
    // ==========================================================================
    
    /**
     * @dev Buy on Balancer (cheaper), sell on Swapr (higher)
     */
    function _executeBalancerToSwapr(address tokenIn, uint256 amountIn) internal {
        // Determine token pair
        address tokenOut = tokenIn == sdaiToken ? wagnoToken : sdaiToken;
        
        // Step 1: Swap on Balancer (buy tokenOut)
        uint256 tokenOutAmount = _swapOnBalancer(tokenIn, tokenOut, amountIn);
        
        // Step 2: Swap back on Swapr (sell tokenOut for tokenIn)
        _swapOnSwapr(tokenOut, tokenIn, tokenOutAmount, 0);
    }
    
    /**
     * @dev Buy on Swapr (cheaper), sell on Balancer (higher)
     */
    function _executeSwaprToBalancer(address tokenIn, uint256 amountIn) internal {
        // Determine token pair
        address tokenOut = tokenIn == sdaiToken ? wagnoToken : sdaiToken;
        
        // Step 1: Swap on Swapr (buy tokenOut)
        uint256 tokenOutAmount = _swapOnSwapr(tokenIn, tokenOut, amountIn, 0);
        
        // Step 2: Swap back on Balancer (sell tokenOut for tokenIn)
        _swapOnBalancer(tokenOut, tokenIn, tokenOutAmount);
    }
    
    /**
     * @dev Buy YES+NO outcome tokens (underpriced), merge to collateral, sell
     * @notice Requires YES and NO token pools to exist on Swapr
     */
    function _executeFutarchyMerge(
        address borrowedToken,
        uint256 amount,
        address proposal
    ) internal {
        // This is a simplified version - in production you'd need:
        // 1. Know the YES/NO token addresses for the proposal
        // 2. Buy equal amounts of YES and NO tokens
        // 3. Merge them via FutarchyRouter to get back collateral (GNO or sDAI)
        // 4. Swap back to borrowedToken if needed
        
        // Example flow for GNO collateral:
        // borrowedToken (sDAI) -> buy YES-GNO + NO-GNO -> merge -> GNO -> sDAI
        
        revert("Futarchy merge not yet implemented - needs YES/NO token addresses");
    }
    
    /**
     * @dev Buy collateral (underpriced), split to YES+NO, sell YES and NO separately
     */
    function _executeFutarchySplit(
        address borrowedToken,
        uint256 amount,
        address proposal
    ) internal {
        // This is a simplified version - in production you'd need:
        // 1. Convert borrowedToken to collateral (GNO) if needed
        // 2. Split via FutarchyRouter to get YES+NO tokens
        // 3. Sell YES and NO tokens on their respective pools
        // 4. Convert back to borrowedToken
        
        revert("Futarchy split not yet implemented - needs YES/NO token addresses");
    }
    
    // ==========================================================================
    // DEX SWAP FUNCTIONS
    // ==========================================================================
    
    /**
     * @dev Execute a swap on Balancer V3
     */
    function _swapOnBalancer(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) internal returns (uint256 amountOut) {
        // Approve if needed
        IERC20(tokenIn).safeIncreaseAllowance(address(balancerVault), amountIn);
        
        IBalancerVault.SingleSwap memory singleSwap = IBalancerVault.SingleSwap({
            poolId: balancerPoolId,
            kind: IBalancerVault.SwapKind.GIVEN_IN,
            assetIn: tokenIn,
            assetOut: tokenOut,
            amount: amountIn,
            userData: ""
        });
        
        IBalancerVault.FundManagement memory funds = IBalancerVault.FundManagement({
            sender: address(this),
            fromInternalBalance: false,
            recipient: payable(address(this)),
            toInternalBalance: false
        });
        
        amountOut = balancerVault.swap(
            singleSwap,
            funds,
            0, // No minimum (handled at profit check)
            block.timestamp
        );
    }
    
    /**
     * @dev Execute a swap on Swapr Algebra V3
     */
    function _swapOnSwapr(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMinimum
    ) internal returns (uint256 amountOut) {
        // Approve if needed
        IERC20(tokenIn).safeIncreaseAllowance(address(swaprRouter), amountIn);
        
        IAlgebraSwapRouter.ExactInputSingleParams memory params = 
            IAlgebraSwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: amountIn,
                amountOutMinimum: amountOutMinimum,
                limitSqrtPrice: 0 // No price limit
            });
        
        amountOut = swaprRouter.exactInputSingle(params);
    }
    
    // ==========================================================================
    // CONFIGURATION FUNCTIONS
    // ==========================================================================
    
    function setBalancerVault(address _vault) external onlyOwner {
        balancerVault = IBalancerVault(_vault);
        emit ConfigUpdated("balancerVault", _vault);
    }
    
    function setSwaprRouter(address _router) external onlyOwner {
        swaprRouter = IAlgebraSwapRouter(_router);
        emit ConfigUpdated("swaprRouter", _router);
    }
    
    function setFutarchyRouter(address _router) external onlyOwner {
        futarchyRouter = IFutarchyRouter(_router);
        emit ConfigUpdated("futarchyRouter", _router);
    }
    
    function setBalancerPoolId(bytes32 _poolId) external onlyOwner {
        balancerPoolId = _poolId;
        emit PoolIdUpdated(_poolId);
    }
    
    function setTokens(
        address _gno,
        address _sdai,
        address _wagno
    ) external onlyOwner {
        gnoToken = _gno;
        sdaiToken = _sdai;
        wagnoToken = _wagno;
    }
    
    // ==========================================================================
    // UTILITY FUNCTIONS
    // ==========================================================================
    
    /**
     * @dev Pre-approve tokens to protocols for gas efficiency
     */
    function _setupApprovals() internal {
        // Approve Balancer Vault
        if (sdaiToken != address(0)) {
            IERC20(sdaiToken).approve(address(balancerVault), type(uint256).max);
            IERC20(sdaiToken).approve(address(swaprRouter), type(uint256).max);
        }
        if (wagnoToken != address(0)) {
            IERC20(wagnoToken).approve(address(balancerVault), type(uint256).max);
            IERC20(wagnoToken).approve(address(swaprRouter), type(uint256).max);
        }
        if (gnoToken != address(0)) {
            IERC20(gnoToken).approve(address(futarchyRouter), type(uint256).max);
        }
    }
    
    /**
     * @notice Refresh approvals (call if tokens are updated)
     */
    function refreshApprovals() external onlyOwner {
        _setupApprovals();
    }
    
    /**
     * @notice Recover stuck tokens (emergency function)
     */
    function recoverTokens(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(msg.sender, amount);
        emit TokensRecovered(token, amount);
    }
    
    /**
     * @notice Withdraw all profits to owner
     */
    function withdrawProfits(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            IERC20(token).safeTransfer(msg.sender, balance);
        }
    }
    
    /**
     * @notice Get optimal flash loan amount based on pool liquidity
     */
    function getPoolLiquidity() external view returns (
        address[] memory tokens,
        uint256[] memory balances
    ) {
        (tokens, balances, ) = balancerVault.getPoolTokens(balancerPoolId);
    }
    
    // Allow receiving native tokens (xDAI on Gnosis)
    receive() external payable {}
}
