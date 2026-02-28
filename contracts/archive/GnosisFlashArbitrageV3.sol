// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// =============================================================================
// BALANCER V3 VAULT INTERFACE
// =============================================================================

interface IBalancerV3Vault {
    /// @notice Unlock the vault for transient operations (including flash loans)
    function unlock(bytes calldata data) external returns (bytes memory result);
    
    /// @notice Send tokens from the vault to a recipient
    function sendTo(IERC20 token, address to, uint256 amount) external;
    
    /// @notice Settle token debt back to the vault
    function settle(IERC20 token, uint256 amount) external returns (uint256 credit);
    
    /// @notice Get pool tokens and balances
    function getPoolTokens(bytes32 poolId) external view returns (
        IERC20[] memory tokens,
        uint256[] memory balances,
        uint256 lastChangeBlock
    );
}

// =============================================================================
// BALANCER V2 INTERFACE (For Swaps)
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
// OTHER INTERFACES
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
// BALANCER V3 FLASH ARBITRAGE CONTRACT
// =============================================================================

/**
 * @title GnosisFlashArbitrageV3
 * @notice Flash loan arbitrage using Balancer V3 Vault on Gnosis Chain
 * @dev Uses V3's unlock/sendTo/settle pattern for flash loans
 */
contract GnosisFlashArbitrageV3 is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    
    // ==========================================================================
    // STATE VARIABLES
    // ==========================================================================
    
    IBalancerV3Vault public balancerVault;
    IBalancerV2Vault public balancerV2Vault; // NEW: V2 Vault for Swaps
    IAlgebraSwapRouter public swaprRouter;
    IFutarchyRouter public futarchyRouter;
    IAlgebraFactory public algebraFactory;
    
    address public gnoToken;
    address public sdaiToken;
    
    // Transient state for flash loan callback
    address private _activeProposal;
    ArbitrageDirection private _activeDirection;
    uint256 private _minProfit;
    address private _profitRecipient;
    ArbitrageResult private _lastResult;  // Store result for return
    
    // ==========================================================================
    // STRUCTS & ENUMS
    // ==========================================================================
    
    struct ProposalInfo {
        address proposal;
        address collateralToken1;  // GNO
        address collateralToken2;  // sDAI
        address yesGno;
        address noGno;
        address yesSdai;
        address noSdai;
        address yesPool;
        address noPool;
        bool isValid;
    }
    
    enum ArbitrageDirection {
        SPOT_SPLIT,   // Split GNO → sell outcome tokens → merge sDAI
        MERGE_SPOT    // Buy outcome tokens → merge to GNO → sell at spot
    }
    
    /// @notice Result struct returned from executeArbitrage (useful for static calls)
    struct ArbitrageResult {
        bool success;
        uint256 profit;           // Profit in borrowed token
        uint256 leftoverYesGno;   // Leftover YES_GNO
        uint256 leftoverNoGno;    // Leftover NO_GNO
        uint256 leftoverYesSdai;  // Leftover YES_SDAI
        uint256 leftoverNoSdai;   // Leftover NO_SDAI
        uint256 leftoverGno;      // Leftover GNO
        uint256 leftoverSdai;     // Leftover sDAI
    }
    
    error ArbitrageFailed(uint256 balanceAfter, uint256 borrowAmount, string reason);
    
    // ==========================================================================
    // EVENTS
    // ==========================================================================
    
    event ArbitrageExecuted(
        address indexed proposal,
        ArbitrageDirection direction,
        address borrowToken,
        uint256 borrowAmount,
        uint256 profit,
        address profitRecipient
    );
    
    // ==========================================================================
    // CONSTRUCTOR
    // ==========================================================================
    
    constructor(
        address _balancerVault,
        address _balancerV2Vault, // NEW
        address _swaprRouter,
        address _futarchyRouter,
        address _algebraFactory,
        address _gnoToken,
        address _sdaiToken
    ) Ownable(msg.sender) {
        balancerVault = IBalancerV3Vault(_balancerVault);
        balancerV2Vault = IBalancerV2Vault(_balancerV2Vault); // NEW
        swaprRouter = IAlgebraSwapRouter(_swaprRouter);
        futarchyRouter = IFutarchyRouter(_futarchyRouter);
        algebraFactory = IAlgebraFactory(_algebraFactory);
        gnoToken = _gnoToken;
        sdaiToken = _sdaiToken;
    }
    
    // ==========================================================================
    // VIEW FUNCTIONS
    // ==========================================================================
    
    function loadProposal(address proposalAddress) public view returns (ProposalInfo memory info) {
        IFutarchyProposal proposal = IFutarchyProposal(proposalAddress);
        
        info.proposal = proposalAddress;
        info.collateralToken1 = address(proposal.collateralToken1());
        info.collateralToken2 = address(proposal.collateralToken2());
        
        info.isValid = (info.collateralToken1 == gnoToken && info.collateralToken2 == sdaiToken);
        if (!info.isValid) return info;
        
        (IERC20 yesGno,) = proposal.wrappedOutcome(0);
        (IERC20 noGno,) = proposal.wrappedOutcome(1);
        (IERC20 yesSdai,) = proposal.wrappedOutcome(2);
        (IERC20 noSdai,) = proposal.wrappedOutcome(3);
        
        info.yesGno = address(yesGno);
        info.noGno = address(noGno);
        info.yesSdai = address(yesSdai);
        info.noSdai = address(noSdai);
        
        info.yesPool = algebraFactory.poolByPair(info.yesGno, info.yesSdai);
        info.noPool = algebraFactory.poolByPair(info.noGno, info.noSdai);
    }
    
    // ==========================================================================
    // FLASH LOAN EXECUTION (V3 Pattern)
    // ==========================================================================
    
    /**
     * @notice Execute flash arbitrage using Balancer V3 unlock pattern
     * @param proposalAddress Futarchy proposal to arbitrage
     * @param borrowToken Token to borrow (GNO for SPOT_SPLIT, sDAI for MERGE_SPOT)
     * @param borrowAmount Amount to borrow
     * @param direction Arbitrage strategy
     * @param minProfit Minimum profit required
     */
    function executeArbitrage(
        address proposalAddress,
        address borrowToken,
        uint256 borrowAmount,
        ArbitrageDirection direction,
        uint256 minProfit
    ) external nonReentrant returns (ArbitrageResult memory result) {
        // Store state for callback
        _activeProposal = proposalAddress;
        _activeDirection = direction;
        _minProfit = minProfit;
        _profitRecipient = msg.sender;
        
        // Encode the callback data with the function selector
        // The Balancer V3 Vault does: (msg.sender).functionCall(data)
        bytes memory callbackData = abi.encodeWithSelector(
            this.onUnlock.selector,
            borrowToken,
            borrowAmount
        );
        
        // Call vault.unlock()
        balancerVault.unlock(callbackData);
        
        // Get result from state (set in callback)
        result = _lastResult;
        
        // Clear transient state
        _activeProposal = address(0);
        
        return result;
    }
    
    /**
     * @notice Balancer V3 callback - called by Vault during unlock()
     * @dev This must match the selector passed to unlock()
     */
    function onUnlock(
        address borrowToken,
        uint256 borrowAmount
    ) external returns (bytes memory) {
        require(msg.sender == address(balancerVault), "Only Balancer Vault");
        
        // 1. Get tokens from vault (flash loan)
        balancerVault.sendTo(IERC20(borrowToken), address(this), borrowAmount);
        
        // 2. Load proposal and execute strategy
        ProposalInfo memory info = loadProposal(_activeProposal);
        require(info.isValid, "Invalid proposal");
        
        if (_activeDirection == ArbitrageDirection.SPOT_SPLIT) {
            _executeSpotSplit(info, borrowToken, borrowAmount);
        } else {
            _executeMergeSpot(info, borrowToken, borrowAmount);
        }
        
        // 3. Calculate profit
        uint256 balanceAfter = IERC20(borrowToken).balanceOf(address(this));
        
        if (balanceAfter < borrowAmount) {
            revert ArbitrageFailed(balanceAfter, borrowAmount, "Insufficient to repay");
        }
        
        uint256 profit = balanceAfter - borrowAmount;
        
        if (profit < _minProfit) {
            revert ArbitrageFailed(balanceAfter, borrowAmount, "Profit below minimum");
        }
        
        // 4. Repay flash loan to vault
        IERC20(borrowToken).transfer(address(balancerVault), borrowAmount);
        balancerVault.settle(IERC20(borrowToken), borrowAmount);
        
        // 5. Send profit to caller
        if (profit > 0) {
            IERC20(borrowToken).safeTransfer(_profitRecipient, profit);
        }
        
        // 6. Send ALL leftover tokens to user (they have value!)
        (
            uint256 sentYesGno,
            uint256 sentNoGno,
            uint256 sentYesSdai,
            uint256 sentNoSdai,
            uint256 sentSdai,
            uint256 sentGno
        ) = _sendAllLeftovers(info, _profitRecipient);
        
        // 7. Build result with all token amounts SENT (for static call visibility)
        ArbitrageResult memory result = ArbitrageResult({
            success: true,
            profit: profit,
            leftoverYesGno: sentYesGno,
            leftoverNoGno: sentNoGno,
            leftoverYesSdai: sentYesSdai,
            leftoverNoSdai: sentNoSdai,
            leftoverGno: sentGno,
            leftoverSdai: sentSdai
        });
        
        // Store in state for executeArbitrage to read
        _lastResult = result;
        
        emit ArbitrageExecuted(
            _activeProposal,
            _activeDirection,
            borrowToken,
            borrowAmount,
            profit,
            _profitRecipient
        );
        
        return abi.encode(result);
    }
    
    // ==========================================================================
    // ARBITRAGE STRATEGIES
    // ==========================================================================
    
    /**
     * @dev SPOT_SPLIT: GNO → split → sell outcomes → merge sDAI → swap back to GNO
     * Profitable when: outcome GNO prices > spot GNO price
     */
    function _executeSpotSplit(
        ProposalInfo memory info,
        address borrowedToken,
        uint256 amount
    ) internal {
        require(borrowedToken == gnoToken, "SPOT_SPLIT requires borrowing GNO");
        
        // 1. Split GNO → YES_GNO + NO_GNO
        IERC20(gnoToken).approve(address(futarchyRouter), amount);
        futarchyRouter.splitPosition(info.proposal, gnoToken, amount);
        
        // 2. Sell YES_GNO → YES_SDAI
        uint256 yesGnoBalance = IERC20(info.yesGno).balanceOf(address(this));
        if (yesGnoBalance > 0 && info.yesPool != address(0)) {
            _swapOnPool(info.yesPool, info.yesGno, yesGnoBalance);
        }
        
        // 3. Sell NO_GNO → NO_SDAI
        uint256 noGnoBalance = IERC20(info.noGno).balanceOf(address(this));
        if (noGnoBalance > 0 && info.noPool != address(0)) {
            _swapOnPool(info.noPool, info.noGno, noGnoBalance);
        }
        
        // 4. Merge YES_SDAI + NO_SDAI → real sDAI
        uint256 yesSdaiBalance = IERC20(info.yesSdai).balanceOf(address(this));
        uint256 noSdaiBalance = IERC20(info.noSdai).balanceOf(address(this));
        uint256 mergeSdaiAmount = yesSdaiBalance < noSdaiBalance ? yesSdaiBalance : noSdaiBalance;
        
        if (mergeSdaiAmount > 0) {
            IERC20(info.yesSdai).approve(address(futarchyRouter), mergeSdaiAmount);
            IERC20(info.noSdai).approve(address(futarchyRouter), mergeSdaiAmount);
            futarchyRouter.mergePositions(info.proposal, sdaiToken, mergeSdaiAmount);
        }
        
        // 5. Swap sDAI → GNO (to repay flash loan)
        uint256 sdaiBalance = IERC20(sdaiToken).balanceOf(address(this));
        if (sdaiBalance > 0) {
            // NEW: Use Balancer V2 for swap (sDAI -> GNO)
            _swapSdaiToGnoV2(sdaiBalance);
        }
    }
    
    /**
     * @dev MERGE_SPOT: sDAI → split → buy outcomes → merge to GNO → swap to sDAI
     * Profitable when: spot GNO price > outcome GNO prices
     */
    function _executeMergeSpot(
        ProposalInfo memory info,
        address borrowedToken,
        uint256 amount
    ) internal {
        require(borrowedToken == sdaiToken, "MERGE_SPOT requires borrowing sDAI");
        
        // 1. Split sDAI → YES_SDAI + NO_SDAI
        IERC20(sdaiToken).approve(address(futarchyRouter), amount);
        futarchyRouter.splitPosition(info.proposal, sdaiToken, amount);
        
        // 2. Swap YES_SDAI → YES_GNO (buy YES_GNO)
        uint256 yesSdaiBalance = IERC20(info.yesSdai).balanceOf(address(this));
        if (yesSdaiBalance > 0 && info.yesPool != address(0)) {
            _swapOnPool(info.yesPool, info.yesSdai, yesSdaiBalance);
        }
        
        // 3. Swap NO_SDAI → NO_GNO (buy NO_GNO)
        uint256 noSdaiBalance = IERC20(info.noSdai).balanceOf(address(this));
        if (noSdaiBalance > 0 && info.noPool != address(0)) {
            _swapOnPool(info.noPool, info.noSdai, noSdaiBalance);
        }
        
        // 4. Merge YES_GNO + NO_GNO → real GNO
        uint256 yesGnoBalance = IERC20(info.yesGno).balanceOf(address(this));
        uint256 noGnoBalance = IERC20(info.noGno).balanceOf(address(this));
        uint256 mergeGnoAmount = yesGnoBalance < noGnoBalance ? yesGnoBalance : noGnoBalance;
        
        if (mergeGnoAmount > 0) {
            IERC20(info.yesGno).approve(address(futarchyRouter), mergeGnoAmount);
            IERC20(info.noGno).approve(address(futarchyRouter), mergeGnoAmount);
            futarchyRouter.mergePositions(info.proposal, gnoToken, mergeGnoAmount);
        }
        
        // 5. Swap GNO → sDAI (to repay flash loan)
        uint256 gnoBalance = IERC20(gnoToken).balanceOf(address(this));
        if (gnoBalance > 0) {
            // NEW: Use Balancer V2 for swap (GNO -> sDAI)
            _swapGnoToSdaiV2(gnoBalance);
        }
    }

    // ==========================================================================
    // BALANCER V2 SWAP HELPERS (NEW)
    // ==========================================================================

    function _swapGnoToSdaiV2(uint256 amount) internal {
        // GNO -> WXDAI -> USDC -> sDAI
        address[] memory assets = new address[](4);
        assets[0] = gnoToken;
        assets[1] = 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d; // WXDAI
        assets[2] = 0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83; // USDC
        assets[3] = sdaiToken;

        IBalancerV2Vault.BatchSwapStep[] memory swaps = new IBalancerV2Vault.BatchSwapStep[](3);
        
        // GNO -> WXDAI
        swaps[0] = IBalancerV2Vault.BatchSwapStep({
            poolId: 0x8189c4c96826d016a99986394103dfa9ae41e7ee0002000000000000000000aa,
            assetInIndex: 0,
            assetOutIndex: 1,
            amount: amount,
            userData: ""
        });
        
        // WXDAI -> USDC
        swaps[1] = IBalancerV2Vault.BatchSwapStep({
            poolId: 0x2086f52651837600180de173b09470f54ef7491000000000000000000000004f,
            assetInIndex: 1,
            assetOutIndex: 2,
            amount: 0, // 0 means use previous output
            userData: ""
        });

        // USDC -> sDAI
        swaps[2] = IBalancerV2Vault.BatchSwapStep({
            poolId: 0x7644fa5d0ea14fcf3e813fdf93ca9544f8567655000000000000000000000066,
            assetInIndex: 2,
            assetOutIndex: 3,
            amount: 0,
            userData: ""
        });

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
        limits[3] = type(int256).max; // Accept any amount of output

        IERC20(gnoToken).approve(address(balancerV2Vault), amount);
        balancerV2Vault.batchSwap(
            IBalancerV2Vault.SwapKind.GIVEN_IN,
            swaps,
            assets,
            funds,
            limits,
            block.timestamp
        );
    }
    
    function _swapSdaiToGnoV2(uint256 amount) internal {
        // sDAI -> USDC -> WXDAI -> GNO (Reverse)
        address[] memory assets = new address[](4);
        assets[0] = sdaiToken;
        assets[1] = 0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83; // USDC
        assets[2] = 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d; // WXDAI
        assets[3] = gnoToken;

        IBalancerV2Vault.BatchSwapStep[] memory swaps = new IBalancerV2Vault.BatchSwapStep[](3);
        
        // sDAI -> USDC
        swaps[0] = IBalancerV2Vault.BatchSwapStep({
            poolId: 0x7644fa5d0ea14fcf3e813fdf93ca9544f8567655000000000000000000000066,
            assetInIndex: 0,
            assetOutIndex: 1,
            amount: amount,
            userData: ""
        });
        
        // USDC -> WXDAI
        swaps[1] = IBalancerV2Vault.BatchSwapStep({
            poolId: 0x2086f52651837600180de173b09470f54ef7491000000000000000000000004f,
            assetInIndex: 1,
            assetOutIndex: 2,
            amount: 0,
            userData: ""
        });

        // WXDAI -> GNO
        swaps[2] = IBalancerV2Vault.BatchSwapStep({
            poolId: 0x8189c4c96826d016a99986394103dfa9ae41e7ee0002000000000000000000aa,
            assetInIndex: 2,
            assetOutIndex: 3,
            amount: 0,
            userData: ""
        });

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
        limits[3] = type(int256).max; // Accept any amount of GNO out

        IERC20(sdaiToken).approve(address(balancerV2Vault), amount);
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
    // LEFTOVER TRANSFER HELPER
    // ==========================================================================
    
    /**
     * @dev Send all leftover tokens to the user - they all have value!
     */
    function _sendAllLeftovers(ProposalInfo memory info, address recipient) internal 
        returns (
            uint256 sentYesGno,
            uint256 sentNoGno,
            uint256 sentYesSdai,
            uint256 sentNoSdai,
            uint256 sentSdai,
            uint256 sentGno
        ) 
    {
        // Transfer leftover YES_GNO
        sentYesGno = IERC20(info.yesGno).balanceOf(address(this));
        if (sentYesGno > 0) {
            IERC20(info.yesGno).safeTransfer(recipient, sentYesGno);
        }
        
        // Transfer leftover NO_GNO
        sentNoGno = IERC20(info.noGno).balanceOf(address(this));
        if (sentNoGno > 0) {
            IERC20(info.noGno).safeTransfer(recipient, sentNoGno);
        }
        
        // Transfer leftover YES_SDAI
        sentYesSdai = IERC20(info.yesSdai).balanceOf(address(this));
        if (sentYesSdai > 0) {
            IERC20(info.yesSdai).safeTransfer(recipient, sentYesSdai);
        }
        
        // Transfer leftover NO_SDAI
        sentNoSdai = IERC20(info.noSdai).balanceOf(address(this));
        if (sentNoSdai > 0) {
            IERC20(info.noSdai).safeTransfer(recipient, sentNoSdai);
        }
        
        // Transfer leftover real sDAI (if any)
        sentSdai = IERC20(sdaiToken).balanceOf(address(this));
        if (sentSdai > 0) {
            IERC20(sdaiToken).safeTransfer(recipient, sentSdai);
        }
        
        // Transfer leftover real GNO (if any)
        sentGno = IERC20(gnoToken).balanceOf(address(this));
        if (sentGno > 0) {
            IERC20(gnoToken).safeTransfer(recipient, sentGno);
        }
    }
    
    // ==========================================================================
    // SWAP HELPER
    // ==========================================================================
    
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
    // ADMIN
    // ==========================================================================
    
    function recoverTokens(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(msg.sender, amount);
    }
    
    receive() external payable {}
}
