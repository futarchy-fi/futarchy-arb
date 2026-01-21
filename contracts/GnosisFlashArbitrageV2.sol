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
 * @dev Futarchy Proposal Interface - to read proposal data
 */
interface IFutarchyProposal {
    function collateralToken1() external view returns (IERC20);
    function collateralToken2() external view returns (IERC20);
    function conditionId() external view returns (bytes32);
    function wrappedOutcome(uint256 index) external view returns (IERC20 wrapped1155, bytes memory data);
    function numOutcomes() external view returns (uint256);
    function marketName() external view returns (string memory);
}

/**
 * @dev Algebra Factory Interface - to find pools
 */
interface IAlgebraFactory {
    function poolByPair(address tokenA, address tokenB) external view returns (address pool);
}

/**
 * @dev Algebra Pool Interface - to get price and liquidity
 */
interface IAlgebraPool {
    function globalState() external view returns (
        uint160 price,
        int24 tick,
        uint16 fee,
        uint16 timepointIndex,
        uint8 communityFeeToken0,
        uint8 communityFeeToken1,
        bool unlocked
    );
    function liquidity() external view returns (uint128);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/**
 * @dev Balancer V3 Vault Interface
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
}

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
}

/**
 * @dev Futarchy Router Interface for split/merge
 */
interface IFutarchyRouter {
    function splitPosition(address proposal, address collateralToken, uint256 amount) external;
    function mergePositions(address proposal, address collateralToken, uint256 amount) external;
}

// =============================================================================
// FLASH ARBITRAGE CONTRACT V2 - Dynamic Proposal Loading
// =============================================================================

/**
 * @title GnosisFlashArbitrageV2
 * @notice Flash loan arbitrage with dynamic proposal loading
 * @dev Pass only proposal address - contract auto-discovers tokens and pools
 * 
 * Outcome Token Mapping:
 * - wrappedOutcome(0) = YES_GNO
 * - wrappedOutcome(1) = NO_GNO  
 * - wrappedOutcome(2) = YES_SDAI
 * - wrappedOutcome(3) = NO_SDAI
 * 
 * Pool Pairs for Arbitrage:
 * - YES_GNO / YES_SDAI (outcome pool for YES)
 * - NO_GNO / NO_SDAI (outcome pool for NO)
 */
contract GnosisFlashArbitrageV2 is IFlashLoanRecipient, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    
    // ==========================================================================
    // STATE VARIABLES
    // ==========================================================================
    
    // Protocol contracts
    IBalancerVault public balancerVault;
    IAlgebraSwapRouter public swaprRouter;
    IFutarchyRouter public futarchyRouter;
    IAlgebraFactory public algebraFactory;
    
    // Expected collateral tokens (for validation)
    address public gnoToken;
    address public sdaiToken;
    
    // Active arbitrage state
    ArbitrageState private activeState;
    
    // ==========================================================================
    // STRUCTS
    // ==========================================================================
    
    struct ProposalInfo {
        address proposal;
        address collateralToken1;  // Should be GNO
        address collateralToken2;  // Should be sDAI
        address yesGno;            // wrappedOutcome(0)
        address noGno;             // wrappedOutcome(1)
        address yesSdai;           // wrappedOutcome(2)
        address noSdai;            // wrappedOutcome(3)
        address yesPool;           // YES_GNO / YES_SDAI pool
        address noPool;            // NO_GNO / NO_SDAI pool
        bool isValid;
    }
    
    struct PoolInfo {
        address pool;
        address token0;
        address token1;
        uint160 sqrtPriceX96;
        uint128 liquidity;
        bool exists;
    }
    
    struct ArbitrageState {
        address proposal;
        address borrowToken;
        uint256 borrowAmount;
        uint256 minProfit;
        ArbitrageDirection direction;
    }
    
    enum ArbitrageDirection {
        YES_TO_NO,   // Buy YES tokens, sell as NO tokens
        NO_TO_YES,   // Buy NO tokens, sell as YES tokens
        SPOT_SPLIT,  // Split collateral, sell outcome tokens
        MERGE_SPOT   // Buy outcome tokens, merge to collateral
    }
    
    // ==========================================================================
    // EVENTS
    // ==========================================================================
    
    event ProposalValidated(
        address indexed proposal,
        address yesGno,
        address noGno,
        address yesSdai,
        address noSdai,
        address yesPool,
        address noPool
    );
    
    event ArbitrageExecuted(
        address indexed proposal,
        ArbitrageDirection direction,
        address borrowToken,
        uint256 borrowAmount,
        uint256 profit,
        address profitRecipient
    );
    
    event PoolsDiscovered(
        address indexed proposal,
        address yesPool,
        uint128 yesLiquidity,
        address noPool,
        uint128 noLiquidity
    );
    
    // ==========================================================================
    // CONSTRUCTOR
    // ==========================================================================
    
    constructor(
        address _balancerVault,
        address _swaprRouter,
        address _futarchyRouter,
        address _algebraFactory,
        address _gnoToken,
        address _sdaiToken
    ) Ownable(msg.sender) {
        balancerVault = IBalancerVault(_balancerVault);
        swaprRouter = IAlgebraSwapRouter(_swaprRouter);
        futarchyRouter = IFutarchyRouter(_futarchyRouter);
        algebraFactory = IAlgebraFactory(_algebraFactory);
        gnoToken = _gnoToken;
        sdaiToken = _sdaiToken;
    }
    
    // ==========================================================================
    // PROPOSAL DISCOVERY FUNCTIONS (View)
    // ==========================================================================
    
    /**
     * @notice Load and validate a proposal, returning all token and pool addresses
     * @param proposalAddress The Futarchy proposal contract address
     * @return info Complete proposal info including tokens and pools
     */
    function loadProposal(address proposalAddress) public view returns (ProposalInfo memory info) {
        IFutarchyProposal proposal = IFutarchyProposal(proposalAddress);
        
        info.proposal = proposalAddress;
        
        // Get collateral tokens
        info.collateralToken1 = address(proposal.collateralToken1());
        info.collateralToken2 = address(proposal.collateralToken2());
        
        // Validate: collateralToken1 should be GNO, collateralToken2 should be sDAI
        info.isValid = (info.collateralToken1 == gnoToken && info.collateralToken2 == sdaiToken);
        
        if (!info.isValid) {
            return info;
        }
        
        // Get wrapped outcome tokens
        // wrappedOutcome returns (IERC20 wrapped1155, bytes memory data)
        (IERC20 yesGno,) = proposal.wrappedOutcome(0);
        (IERC20 noGno,) = proposal.wrappedOutcome(1);
        (IERC20 yesSdai,) = proposal.wrappedOutcome(2);
        (IERC20 noSdai,) = proposal.wrappedOutcome(3);
        
        info.yesGno = address(yesGno);
        info.noGno = address(noGno);
        info.yesSdai = address(yesSdai);
        info.noSdai = address(noSdai);
        
        // Find pools via Algebra Factory
        // YES pool: YES_GNO / YES_SDAI
        info.yesPool = algebraFactory.poolByPair(info.yesGno, info.yesSdai);
        
        // NO pool: NO_GNO / NO_SDAI
        info.noPool = algebraFactory.poolByPair(info.noGno, info.noSdai);
        
        return info;
    }
    
    /**
     * @notice Get pool information including price and liquidity
     * @param poolAddress The Algebra pool address
     * @return info Pool details
     */
    function getPoolInfo(address poolAddress) public view returns (PoolInfo memory info) {
        if (poolAddress == address(0)) {
            info.exists = false;
            return info;
        }
        
        IAlgebraPool pool = IAlgebraPool(poolAddress);
        
        info.pool = poolAddress;
        info.token0 = pool.token0();
        info.token1 = pool.token1();
        info.liquidity = pool.liquidity();
        
        (info.sqrtPriceX96,,,,,, ) = pool.globalState();
        
        info.exists = info.liquidity > 0;
        
        return info;
    }
    
    /**
     * @notice Get complete arbitrage opportunity analysis for a proposal
     * @param proposalAddress Proposal to analyze
     * @return proposalInfo Proposal tokens and pools
     * @return yesPoolInfo YES pool price and liquidity
     * @return noPoolInfo NO pool price and liquidity
     */
    function analyzeArbitrageOpportunity(address proposalAddress) external view returns (
        ProposalInfo memory proposalInfo,
        PoolInfo memory yesPoolInfo,
        PoolInfo memory noPoolInfo
    ) {
        proposalInfo = loadProposal(proposalAddress);
        
        if (proposalInfo.isValid) {
            yesPoolInfo = getPoolInfo(proposalInfo.yesPool);
            noPoolInfo = getPoolInfo(proposalInfo.noPool);
        }
    }
    
    // ==========================================================================
    // ARBITRAGE EXECUTION
    // ==========================================================================
    
    /**
     * @notice Execute arbitrage on a Futarchy proposal
     * @dev Only requires proposal address - all tokens/pools are discovered automatically
     * @param proposalAddress The Futarchy proposal to arbitrage
     * @param borrowToken Which token to flash loan (usually sDAI)
     * @param borrowAmount Amount to borrow (flash loan size limit)
     * @param direction Which arbitrage direction to execute
     * @param minProfit Minimum profit required (reverts if not met)
     */
    function executeProposalArbitrage(
        address proposalAddress,
        address borrowToken,
        uint256 borrowAmount,
        ArbitrageDirection direction,
        uint256 minProfit
    ) external onlyOwner nonReentrant {
        // Load and validate proposal
        ProposalInfo memory info = loadProposal(proposalAddress);
        require(info.isValid, "Invalid proposal: collateral tokens mismatch");
        
        // Check pools exist
        PoolInfo memory yesPoolInfo = getPoolInfo(info.yesPool);
        PoolInfo memory noPoolInfo = getPoolInfo(info.noPool);
        
        require(yesPoolInfo.exists || noPoolInfo.exists, "No pools found for arbitrage");
        
        emit PoolsDiscovered(
            proposalAddress,
            info.yesPool,
            yesPoolInfo.liquidity,
            info.noPool,
            noPoolInfo.liquidity
        );
        
        // Record balance before
        uint256 balanceBefore = IERC20(borrowToken).balanceOf(address(this));
        
        // Store state for callback
        activeState = ArbitrageState({
            proposal: proposalAddress,
            borrowToken: borrowToken,
            borrowAmount: borrowAmount,
            minProfit: minProfit,
            direction: direction
        });
        
        // Execute flash loan
        IERC20[] memory tokens = new IERC20[](1);
        tokens[0] = IERC20(borrowToken);
        
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = borrowAmount;
        
        balancerVault.flashLoan(
            address(this),
            tokens,
            amounts,
            abi.encode(proposalAddress, direction)
        );
        
        // Transfer profits to caller
        uint256 balanceAfter = IERC20(borrowToken).balanceOf(address(this));
        uint256 profit = balanceAfter - balanceBefore;
        
        if (profit > 0) {
            IERC20(borrowToken).safeTransfer(msg.sender, profit);
        }
        
        emit ArbitrageExecuted(
            proposalAddress,
            direction,
            borrowToken,
            borrowAmount,
            profit,
            msg.sender
        );
    }
    
    /**
     * @notice Flash loan callback
     */
    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external override {
        require(msg.sender == address(balancerVault), "Only Balancer Vault");
        
        (address proposalAddress, ArbitrageDirection direction) = 
            abi.decode(userData, (address, ArbitrageDirection));
        
        address borrowedToken = address(tokens[0]);
        uint256 borrowedAmount = amounts[0];
        uint256 fee = feeAmounts[0];
        uint256 repayAmount = borrowedAmount + fee;
        
        // Load proposal info
        ProposalInfo memory info = loadProposal(proposalAddress);
        
        // Execute strategy based on direction
        if (direction == ArbitrageDirection.YES_TO_NO) {
            _executeYesToNo(info, borrowedToken, borrowedAmount);
        } else if (direction == ArbitrageDirection.NO_TO_YES) {
            _executeNoToYes(info, borrowedToken, borrowedAmount);
        } else if (direction == ArbitrageDirection.SPOT_SPLIT) {
            _executeSpotSplit(info, borrowedToken, borrowedAmount);
        } else if (direction == ArbitrageDirection.MERGE_SPOT) {
            _executeMergeSpot(info, borrowedToken, borrowedAmount);
        }
        
        // Repay flash loan
        uint256 balance = IERC20(borrowedToken).balanceOf(address(this));
        require(balance >= repayAmount, "Insufficient to repay flash loan");
        
        uint256 profit = balance - repayAmount;
        require(profit >= activeState.minProfit, "Profit below minimum");
        
        IERC20(borrowedToken).safeTransfer(address(balancerVault), repayAmount);
    }
    
    // ==========================================================================
    // ARBITRAGE STRATEGIES
    // ==========================================================================
    
    /**
     * @dev Strategy: Buy on YES pool, sell on NO pool
     * If YES pool has better price than NO pool
     */
    function _executeYesToNo(
        ProposalInfo memory info,
        address borrowedToken,
        uint256 amount
    ) internal {
        require(info.yesPool != address(0) && info.noPool != address(0), "Both pools required");
        
        // Example flow:
        // 1. Swap sDAI -> YES_SDAI on spot/Balancer
        // 2. Swap YES_SDAI -> YES_GNO on YES pool
        // 3. NO_GNO -> NO_SDAI on NO pool (or via collateral merge)
        // 4. Swap back to sDAI
        
        // Simplified: swap on YES pool
        _swapOnPool(info.yesPool, borrowedToken, amount);
        
        // Swap result on NO pool
        address intermediateToken = borrowedToken == info.yesSdai ? info.yesGno : info.yesSdai;
        uint256 intermediateBalance = IERC20(intermediateToken).balanceOf(address(this));
        
        if (intermediateBalance > 0) {
            _swapOnPool(info.noPool, intermediateToken, intermediateBalance);
        }
    }
    
    /**
     * @dev Strategy: Buy on NO pool, sell on YES pool
     */
    function _executeNoToYes(
        ProposalInfo memory info,
        address borrowedToken,
        uint256 amount
    ) internal {
        require(info.yesPool != address(0) && info.noPool != address(0), "Both pools required");
        
        // Swap on NO pool first
        _swapOnPool(info.noPool, borrowedToken, amount);
        
        // Then swap result on YES pool
        address intermediateToken = borrowedToken == info.noSdai ? info.noGno : info.noSdai;
        uint256 intermediateBalance = IERC20(intermediateToken).balanceOf(address(this));
        
        if (intermediateBalance > 0) {
            _swapOnPool(info.yesPool, intermediateToken, intermediateBalance);
        }
    }
    
    /**
     * @dev Strategy: Split GNO into YES+NO, sell on pools, merge sDAI
     * Flow: GNO → YES_GNO + NO_GNO → sell → YES_SDAI + NO_SDAI → merge → sDAI
     * Profitable when outcome GNO prices > spot GNO price
     */
    function _executeSpotSplit(
        ProposalInfo memory info,
        address borrowedToken,
        uint256 amount
    ) internal {
        // If we borrowed sDAI, we need to swap to GNO first
        uint256 gnoAmount = amount;
        if (borrowedToken == info.collateralToken2) {
            // Swap sDAI → GNO via Balancer or available pool
            // For now, assume we borrowed GNO directly
            revert("SPOT_SPLIT requires borrowing GNO directly");
        }
        
        // 1. Split GNO into YES_GNO + NO_GNO via FutarchyRouter
        IERC20(info.collateralToken1).approve(address(futarchyRouter), gnoAmount);
        futarchyRouter.splitPosition(info.proposal, info.collateralToken1, gnoAmount);
        
        // 2. Sell YES_GNO on YES pool → receive YES_SDAI
        uint256 yesGnoBalance = IERC20(info.yesGno).balanceOf(address(this));
        if (yesGnoBalance > 0 && info.yesPool != address(0)) {
            _swapOnPool(info.yesPool, info.yesGno, yesGnoBalance);
        }
        
        // 3. Sell NO_GNO on NO pool → receive NO_SDAI
        uint256 noGnoBalance = IERC20(info.noGno).balanceOf(address(this));
        if (noGnoBalance > 0 && info.noPool != address(0)) {
            _swapOnPool(info.noPool, info.noGno, noGnoBalance);
        }
        
        // 4. CRITICAL: Merge YES_SDAI + NO_SDAI → real sDAI
        uint256 yesSdaiBalance = IERC20(info.yesSdai).balanceOf(address(this));
        uint256 noSdaiBalance = IERC20(info.noSdai).balanceOf(address(this));
        uint256 mergeSdaiAmount = yesSdaiBalance < noSdaiBalance ? yesSdaiBalance : noSdaiBalance;
        
        if (mergeSdaiAmount > 0) {
            IERC20(info.yesSdai).approve(address(futarchyRouter), mergeSdaiAmount);
            IERC20(info.noSdai).approve(address(futarchyRouter), mergeSdaiAmount);
            futarchyRouter.mergePositions(info.proposal, info.collateralToken2, mergeSdaiAmount);
        }
        
        // 5. Now we have real sDAI, need to swap to GNO to repay flash loan
        // (This is handled after this function returns - the contract checks balance)
    }
    
    /**
     * @dev Strategy: Buy YES+NO outcome tokens, merge to collateral
     * Useful when YES + NO < 1 (outcome tokens underpriced)
     */
    function _executeMergeSpot(
        ProposalInfo memory info,
        address borrowedToken,
        uint256 amount
    ) internal {
        // Split amount in half to buy YES and NO
        uint256 halfAmount = amount / 2;
        
        // 1. Buy YES_GNO from YES pool
        if (info.yesPool != address(0)) {
            _swapOnPool(info.yesPool, borrowedToken, halfAmount);
        }
        
        // 2. Buy NO_GNO from NO pool  
        if (info.noPool != address(0)) {
            _swapOnPool(info.noPool, borrowedToken, halfAmount);
        }
        
        // 3. Merge YES_GNO + NO_GNO -> GNO
        uint256 yesBalance = IERC20(info.yesGno).balanceOf(address(this));
        uint256 noBalance = IERC20(info.noGno).balanceOf(address(this));
        uint256 mergeAmount = yesBalance < noBalance ? yesBalance : noBalance;
        
        if (mergeAmount > 0) {
            IERC20(info.yesGno).approve(address(futarchyRouter), mergeAmount);
            IERC20(info.noGno).approve(address(futarchyRouter), mergeAmount);
            futarchyRouter.mergePositions(info.proposal, info.collateralToken1, mergeAmount);
        }
        
        // 4. Swap GNO back to borrowed token if needed
        // (implementation depends on available pools)
    }
    
    /**
     * @dev Execute swap on an Algebra pool via router
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
    // ADMIN FUNCTIONS
    // ==========================================================================
    
    function setContracts(
        address _balancerVault,
        address _swaprRouter,
        address _futarchyRouter,
        address _algebraFactory
    ) external onlyOwner {
        if (_balancerVault != address(0)) balancerVault = IBalancerVault(_balancerVault);
        if (_swaprRouter != address(0)) swaprRouter = IAlgebraSwapRouter(_swaprRouter);
        if (_futarchyRouter != address(0)) futarchyRouter = IFutarchyRouter(_futarchyRouter);
        if (_algebraFactory != address(0)) algebraFactory = IAlgebraFactory(_algebraFactory);
    }
    
    function setExpectedTokens(address _gno, address _sdai) external onlyOwner {
        gnoToken = _gno;
        sdaiToken = _sdai;
    }
    
    function recoverTokens(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(msg.sender, amount);
    }
    
    receive() external payable {}
}
