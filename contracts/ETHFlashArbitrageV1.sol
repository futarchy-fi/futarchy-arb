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

interface IFutarchyRouter {
    function splitPosition(address proposal, address collateralToken, uint256 amount) external;
    function mergePositions(address proposal, address collateralToken, uint256 amount) external;
}

/// @dev Sky UsdsPsmWrapper: direct USDS <-> USDC at 1:1 (internally DaiUsds + LitePSM).
///      sellGem pulls `gemAmt` USDC (6 dec) from caller, sends USDS (18 dec) to `usr`.
///      buyGem pulls USDS from caller, sends `gemAmt` USDC to `usr`.
interface IUsdsPsmWrapper {
    function sellGem(address usr, uint256 gemAmt) external returns (uint256 usdsOutWad);
    function buyGem(address usr, uint256 gemAmt) external returns (uint256 usdsInWad);
}

// =============================================================================
// ETH FLASH ARBITRAGE V1 - ETH/USDS FUTARCHY MARKET (MAINNET)
// =============================================================================

/**
 * @title ETHFlashArbitrageV1
 * @notice Flash arbitrage for the ETH/USDS futarchy market, ported from
 *         VLRFlashArbitrageV3 (same architecture: Balancer V2 flash loan,
 *         Universal Router + Permit2 conditional-pool swaps, futarchy router
 *         split/merge, final min-profit check as slippage protection).
 * @dev Design change vs VLR template: the Uniswap USDS/USDC pools are empty on
 *      mainnet (USDC/USDS 100/500/3000 pools all had liquidity 0), so the
 *      USDS <-> USDC spot leg goes through Sky's canonical converters instead
 *      of a Uniswap hop. We use the Sky UsdsPsmWrapper, which performs
 *      USDS <-> USDC in a single call (internally DaiUsds + LitePSM).
 *
 *      Sky converter addresses verified on-chain 2026-08-07 via
 *      https://ethereum.publicnode.com (eth_getCode + view-function probes +
 *      selector presence in runtime bytecode):
 *
 *      - UsdsPsmWrapper 0xA188EEC8F81263234dA3622A406892F3D630f98c
 *          code size 2972 bytes; usds() = USDS (0xdC03...384F),
 *          gem() = USDC (0xA0b8...eB48), tin() = 0, tout() = 0 (fee-free),
 *          to18ConversionFactor() = 1e12,
 *          psm() = 0xf6e72Db5454dd049d0788e411b06CfAF16853042,
 *          selectors buyGem(address,uint256) 0x8d7ef9bb and
 *          sellGem(address,uint256) 0x95991276 present in bytecode.
 *      - LitePSM (MCD_LITE_PSM_USDC_A) 0xf6e72Db5454dd049d0788e411b06CfAF16853042
 *          code size 8414 bytes; dai() = DAI (0x6B17...1d0F), gem() = USDC,
 *          tin() = tout() = 0, pocket() = 0x37305B1cD40574E4C5Ce33f8e8306Be057fD7341
 *          holding ~4.2B USDC (deep 1:1 liquidity).
 *      - DaiUsds 0x3225737a9Bbb6473CB4a45b7244ACa2BeFdB276A
 *          code size 1428 bytes; dai() = DAI, usds() = USDS, selectors
 *          daiToUsds 0xf2c07aae and usdsToDai 0x68f30150 present in bytecode.
 *
 *      The wrapper is used (rather than DaiUsds + LitePSM separately) because
 *      it is the canonical direct USDS<->USDC route: one external call, zero
 *      fee (tin/tout = 0), backed by the same LitePSM liquidity.
 *
 * Slippage uses Uniswap fee format: 500 = 0.05%, 3000 = 0.3%, 10000 = 1%.
 */
contract ETHFlashArbitrageV1 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ==========================================================================
    // CONSTANTS (Verified Mainnet Addresses)
    // ==========================================================================

    address public constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address public constant USDS = 0xdC035D45d973E3EC169d2276DDab16f1e407384F;
    address public constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    address public constant PROPOSAL = 0x0d78b95fca9f3e1b588271A330b0D6f731eC38aA;
    address public constant YES_WETH = 0x642a8d92B4FC8ECd504DFc169Fbd15275354E620;
    address public constant NO_WETH = 0x98c4c36AaBA743C5A320355111bA51559fdD8E21;
    address public constant YES_USDS = 0xee3db3b2f2296a92d8e57bf61e9423B0e7f5e7e1;
    address public constant NO_USDS = 0x6C833e3787D024048F357eBA54134C358ebB1971;

    IBalancerV2Vault public constant balancerVault = IBalancerV2Vault(0xBA12222222228d8Ba445958a75a0704d566BF2C8);
    IPermit2 public constant permit2 = IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    IUniversalRouter public constant universalRouter = IUniversalRouter(0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af);
    IFutarchyRouter public constant futarchyRouter = IFutarchyRouter(0xAc9Bf8EbA6Bd31f8E8c76f8E8B2AAd0BD93f98Dc);
    // Sky direct USDS<->USDC converter (verification documented in contract natspec)
    IUsdsPsmWrapper public constant usdsPsmWrapper = IUsdsPsmWrapper(0xA188EEC8F81263234dA3622A406892F3D630f98c);

    uint24 public constant OUTCOME_FEE = 500;
    uint24 public constant WETH_USDC_FEE = 500;

    bytes1 public constant V3_SWAP_EXACT_IN = 0x00;
    uint160 private constant MAX_UINT160 = type(uint160).max;
    uint48 private constant MAX_UINT48 = type(uint48).max;
    uint256 private constant GEM_CONVERSION = 1e12; // USDS wad -> USDC units

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
    bool private _flashPending; // guards receiveFlashLoan against third-party-initiated flash loans

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

    // ==========================================================================
    // CONSTRUCTOR
    // ==========================================================================

    constructor() {
        admin = msg.sender;

        // Pre-approve Universal-Router-swapped tokens to Permit2
        IERC20(WETH).approve(address(permit2), type(uint256).max);
        IERC20(USDC).approve(address(permit2), type(uint256).max);
        IERC20(YES_WETH).approve(address(permit2), type(uint256).max);
        IERC20(NO_WETH).approve(address(permit2), type(uint256).max);
        IERC20(YES_USDS).approve(address(permit2), type(uint256).max);
        IERC20(NO_USDS).approve(address(permit2), type(uint256).max);

        // Pre-approve Permit2 -> Universal Router
        permit2.approve(WETH, address(universalRouter), MAX_UINT160, MAX_UINT48);
        permit2.approve(USDC, address(universalRouter), MAX_UINT160, MAX_UINT48);
        permit2.approve(YES_WETH, address(universalRouter), MAX_UINT160, MAX_UINT48);
        permit2.approve(NO_WETH, address(universalRouter), MAX_UINT160, MAX_UINT48);
        permit2.approve(YES_USDS, address(universalRouter), MAX_UINT160, MAX_UINT48);
        permit2.approve(NO_USDS, address(universalRouter), MAX_UINT160, MAX_UINT48);

        // Pre-approve to FutarchyRouter (split/merge pulls collateral & outcome tokens)
        IERC20(WETH).approve(address(futarchyRouter), type(uint256).max);
        IERC20(USDS).approve(address(futarchyRouter), type(uint256).max);
        IERC20(YES_WETH).approve(address(futarchyRouter), type(uint256).max);
        IERC20(NO_WETH).approve(address(futarchyRouter), type(uint256).max);
        IERC20(YES_USDS).approve(address(futarchyRouter), type(uint256).max);
        IERC20(NO_USDS).approve(address(futarchyRouter), type(uint256).max);

        // Pre-approve to Sky UsdsPsmWrapper (buyGem pulls USDS, sellGem pulls USDC)
        IERC20(USDS).approve(address(usdsPsmWrapper), type(uint256).max);
        IERC20(USDC).approve(address(usdsPsmWrapper), type(uint256).max);
    }

    // ==========================================================================
    // EXTERNAL FUNCTIONS
    // ==========================================================================

    /**
     * @notice Execute flash arbitrage with final min-profit protection
     * @param borrowAmount Amount of WETH to flash borrow
     * @param direction SPOT_SPLIT (0) or MERGE_SPOT (1)
     * @param minProfit Minimum profit in WETH (may be 0 - economics is price alignment)
     * @param slippageBps Slippage tolerance in bps (kept for interface parity with V3)
     * @return result Arbitrage result with profit and gas used
     */
    function executeArbitrage(
        uint256 borrowAmount,
        ArbitrageDirection direction,
        uint256 minProfit,
        uint256 slippageBps
    ) external nonReentrant returns (ArbitrageResult memory result) {
        require(msg.sender == admin, "Admin only");
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
        tokens[0] = IERC20(WETH);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = borrowAmount;

        _flashPending = true;
        balancerVault.flashLoan(address(this), tokens, amounts, abi.encode(_params));
        _flashPending = false;

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
        require(_flashPending, "Unsolicited flash loan");

        ArbitrageParams memory params = abi.decode(userData, (ArbitrageParams));
        uint256 repayAmount = amounts[0] + feeAmounts[0];

        // Execute strategy
        if (params.direction == ArbitrageDirection.SPOT_SPLIT) {
            _executeSpotSplit(params.borrowAmount, params.slippageBps);
        } else {
            _executeMergeSpot(params.borrowAmount, params.slippageBps);
        }

        // Check and repay
        uint256 wethBalance = IERC20(WETH).balanceOf(address(this));
        if (wethBalance < repayAmount) {
            revert ArbitrageFailed(wethBalance, repayAmount, "Insufficient to repay");
        }

        uint256 profit = wethBalance - repayAmount;
        if (profit < params.minProfit) {
            revert ArbitrageFailed(wethBalance, repayAmount, "Profit below minimum");
        }

        IERC20(WETH).transfer(address(balancerVault), repayAmount);

        if (profit > 0) {
            IERC20(WETH).safeTransfer(_profitRecipient, profit);
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
    // STRATEGY: SPOT_SPLIT (conditional WETH rich vs spot)
    // ==========================================================================

    function _executeSpotSplit(uint256 amount, uint256 slippageBps) internal {
        // 1. Split WETH -> YES_WETH + NO_WETH
        futarchyRouter.splitPosition(PROPOSAL, WETH, amount);

        // 2. Swap YES_WETH -> YES_USDS
        uint256 yesWethBal = IERC20(YES_WETH).balanceOf(address(this));
        if (yesWethBal > 0) {
            _swapWithSlippage(YES_WETH, YES_USDS, OUTCOME_FEE, yesWethBal, slippageBps);
        }

        // 3. Swap NO_WETH -> NO_USDS
        uint256 noWethBal = IERC20(NO_WETH).balanceOf(address(this));
        if (noWethBal > 0) {
            _swapWithSlippage(NO_WETH, NO_USDS, OUTCOME_FEE, noWethBal, slippageBps);
        }

        // 4. Merge YES_USDS + NO_USDS -> USDS
        uint256 yesUsdsBal = IERC20(YES_USDS).balanceOf(address(this));
        uint256 noUsdsBal = IERC20(NO_USDS).balanceOf(address(this));
        uint256 mergeAmount = yesUsdsBal < noUsdsBal ? yesUsdsBal : noUsdsBal;
        if (mergeAmount > 0) {
            futarchyRouter.mergePositions(PROPOSAL, USDS, mergeAmount);
        }

        // 5. USDS -> USDC via Sky wrapper (1:1, buyGem takes USDC units)
        uint256 usdsBal = IERC20(USDS).balanceOf(address(this));
        uint256 gemAmt = usdsBal / GEM_CONVERSION;
        if (gemAmt > 0) {
            usdsPsmWrapper.buyGem(address(this), gemAmt);
        }

        // 6. USDC -> WETH via Uniswap V3 spot pool
        uint256 usdcBal = IERC20(USDC).balanceOf(address(this));
        if (usdcBal > 0) {
            _swapWithSlippage(USDC, WETH, WETH_USDC_FEE, usdcBal, slippageBps);
        }
    }

    // ==========================================================================
    // STRATEGY: MERGE_SPOT (conditional WETH cheap vs spot)
    // ==========================================================================

    function _executeMergeSpot(uint256 amount, uint256 slippageBps) internal {
        // 1. Swap WETH -> USDC via Uniswap V3 spot pool
        _swapWithSlippage(WETH, USDC, WETH_USDC_FEE, amount, slippageBps);

        // 2. USDC -> USDS via Sky wrapper (1:1)
        uint256 usdcBal = IERC20(USDC).balanceOf(address(this));
        if (usdcBal > 0) {
            usdsPsmWrapper.sellGem(address(this), usdcBal);
        }

        // 3. Split USDS -> YES_USDS + NO_USDS
        uint256 usdsBal = IERC20(USDS).balanceOf(address(this));
        futarchyRouter.splitPosition(PROPOSAL, USDS, usdsBal);

        // 4. Swap YES_USDS -> YES_WETH
        uint256 yesUsdsBal = IERC20(YES_USDS).balanceOf(address(this));
        if (yesUsdsBal > 0) {
            _swapWithSlippage(YES_USDS, YES_WETH, OUTCOME_FEE, yesUsdsBal, slippageBps);
        }

        // 5. Swap NO_USDS -> NO_WETH
        uint256 noUsdsBal = IERC20(NO_USDS).balanceOf(address(this));
        if (noUsdsBal > 0) {
            _swapWithSlippage(NO_USDS, NO_WETH, OUTCOME_FEE, noUsdsBal, slippageBps);
        }

        // 6. Merge YES_WETH + NO_WETH -> WETH
        uint256 yesWethBal = IERC20(YES_WETH).balanceOf(address(this));
        uint256 noWethBal = IERC20(NO_WETH).balanceOf(address(this));
        uint256 mergeAmount = yesWethBal < noWethBal ? yesWethBal : noWethBal;
        if (mergeAmount > 0) {
            futarchyRouter.mergePositions(PROPOSAL, WETH, mergeAmount);
        }
    }

    // ==========================================================================
    // SWAP (Universal Router V3_SWAP_EXACT_IN, payer = this contract via Permit2)
    // ==========================================================================

    function _swapWithSlippage(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 /* slippageBps */  // Unused - rely on minProfit instead (as in V3)
    ) internal {
        bytes memory path = abi.encodePacked(tokenIn, fee, tokenOut);

        // Use minOut = 0 for individual swaps.
        // Final protection comes from the minProfit/repay check at the end -
        // an unprofitable flash-arb tx reverts atomically anyway.
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
