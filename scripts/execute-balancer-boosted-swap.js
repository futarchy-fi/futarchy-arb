/**
 * Balancer V3 Boosted Pool Swap: GHO → USDC
 * 
 * Uses BatchRouter with buffer steps (wrap/unwrap):
 * Step 1: GHO → waGHO (wrap via buffer)
 * Step 2: waGHO → waUSDC (swap in boosted pool)
 * Step 3: waUSDC → USDC (unwrap via buffer)
 * 
 * Uses .env file for PRIVATE_KEY
 * Usage: node scripts/execute-balancer-boosted-swap.js
 */

require('dotenv').config();
const { ethers } = require("ethers");

// ============================================================================
// CONFIGURATION
// ============================================================================

const RPC_URL = "https://ethereum.publicnode.com";

// Balancer V3 Contracts (Ethereum Mainnet)
const BATCH_ROUTER = "0x136f1EFcC3f8f88516B9E94110D56FDBfB1778d1"; // BatchRouter
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

// Token Addresses
const GHO_ADDRESS = "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f";
const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

// Wrapped (ERC-4626) Token Addresses
const waGHO_ADDRESS = "0xC71Ea051a5F82c67ADcF634c36FFE6334793D24C";
const waUSDC_ADDRESS = "0xD4fa2D31b7968E448877f69A96DE69f5de8cD23E";

// Boosted Pool
const BOOSTED_POOL = "0x85b2b559bc2d21104c4defdd6efca8a20343361d";

// Trade parameters
const TRADE_AMOUNT = "1";  // 1 GHO
const SLIPPAGE_PERCENT = 3;

// Gas cost thresholds (in USD)
const MAX_APPROVAL_COST_USD = 0.20;
const MAX_SWAP_COST_USD = 0.50;

// ETH price
const ETH_PRICE_USD = 3300;

// ============================================================================
// ABIs
// ============================================================================

const ERC20_ABI = [
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function balanceOf(address account) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)"
];

const PERMIT2_ABI = [
    "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
    "function approve(address token, address spender, uint160 amount, uint48 expiration)"
];

// BatchRouter ABI for swapExactIn
const BATCH_ROUTER_ABI = [
    `function swapExactIn(
    (
      address tokenIn,
      (
        address pool,
        address tokenOut,
        bool isBuffer
      )[] steps,
      uint256 exactAmountIn,
      uint256 minAmountOut
    )[] paths,
    uint256 deadline,
    bool wethIsEth,
    bytes userData
  ) external payable returns (uint256[] pathAmountsOut, address[] tokensOut, uint256[] amountsOut)`,
    "function version() view returns (string)"
];

// ============================================================================
// HELPERS
// ============================================================================

function gasToUsd(gasUnits, gasPriceGwei, ethPriceUsd) {
    const ethCost = (Number(gasUnits) * gasPriceGwei) / 1e9;
    return ethCost * ethPriceUsd;
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main() {
    console.log("╔════════════════════════════════════════════════════════════════╗");
    console.log("║  BALANCER V3 BOOSTED POOL SWAP: GHO → USDC                     ║");
    console.log("║  Using BatchRouter with Buffer Steps (Wrap/Unwrap)             ║");
    console.log("╚════════════════════════════════════════════════════════════════╝\n");

    // Check for private key
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) {
        console.log("❌ ERROR: PRIVATE_KEY required in .env file");
        process.exit(1);
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(privateKey, provider);
    const userAddress = await wallet.getAddress();

    console.log(`👤 Wallet: ${userAddress}`);

    // Setup contracts
    const gho = new ethers.Contract(GHO_ADDRESS, ERC20_ABI, provider);
    const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
    const permit2 = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, provider);

    // Get balances
    const ghoDecimals = await gho.decimals();
    const usdcDecimals = await usdc.decimals();
    const ghoBalance = await gho.balanceOf(userAddress);
    const amountIn = ethers.parseUnits(TRADE_AMOUNT, ghoDecimals);

    console.log(`💰 GHO Balance: ${ethers.formatUnits(ghoBalance, ghoDecimals)}`);
    console.log(`📊 Trade: ${TRADE_AMOUNT} GHO → USDC (via boosted pool)\n`);

    console.log("📋 Swap Path:");
    console.log("   Step 1: GHO → waGHO (wrap via buffer)");
    console.log("   Step 2: waGHO → waUSDC (swap in boosted pool)");
    console.log("   Step 3: waUSDC → USDC (unwrap via buffer)\n");

    if (ghoBalance < amountIn) {
        console.log(`❌ Insufficient GHO balance. Need ${TRADE_AMOUNT}, have ${ethers.formatUnits(ghoBalance, ghoDecimals)}`);
        process.exit(1);
    }

    // Get gas price
    const feeData = await provider.getFeeData();
    const gasPriceWei = feeData.gasPrice;
    const gasPriceGwei = parseFloat(ethers.formatUnits(gasPriceWei, "gwei"));

    console.log(`⛽ Gas Price: ${gasPriceGwei.toFixed(4)} Gwei\n`);

    // =========================================================================
    // PHASE 1: GAS ESTIMATION & APPROVAL CHECK
    // =========================================================================
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("PHASE 1: GAS ESTIMATION & APPROVAL CHECK");
    console.log("═══════════════════════════════════════════════════════════════\n");

    // Check ERC20 allowance to Permit2
    const erc20Allowance = await gho.allowance(userAddress, PERMIT2_ADDRESS);
    const needsErc20Approve = erc20Allowance < amountIn;

    let erc20Gas = 0n;
    if (needsErc20Approve) {
        const approveData = gho.interface.encodeFunctionData('approve', [PERMIT2_ADDRESS, ethers.MaxUint256]);
        erc20Gas = await provider.estimateGas({ to: GHO_ADDRESS, data: approveData, from: userAddress });
        console.log(`📝 ERC20 → Permit2 approval needed: ${erc20Gas} gas ($${gasToUsd(erc20Gas, gasPriceGwei, ETH_PRICE_USD).toFixed(6)})`);
    } else {
        console.log(`✅ GHO already approved to Permit2`);
    }

    // Check Permit2 allowance to BatchRouter
    const [p2Amount, p2Expiration] = await permit2.allowance(userAddress, GHO_ADDRESS, BATCH_ROUTER);
    const now = Math.floor(Date.now() / 1000);
    const needsPermit2Approve = p2Amount < amountIn || p2Expiration <= now;

    let permit2Gas = 0n;
    if (needsPermit2Approve) {
        const p2ApproveData = permit2.interface.encodeFunctionData('approve', [
            GHO_ADDRESS, BATCH_ROUTER, ethers.MaxUint256 >> 96n, 281474976710655n
        ]);
        permit2Gas = await provider.estimateGas({ to: PERMIT2_ADDRESS, data: p2ApproveData, from: userAddress });
        console.log(`📝 Permit2 → BatchRouter approval needed: ${permit2Gas} gas ($${gasToUsd(permit2Gas, gasPriceGwei, ETH_PRICE_USD).toFixed(6)})`);
    } else {
        console.log(`✅ Permit2 already approved to BatchRouter`);
    }

    // Estimate swap gas (fallback since BatchRouter query is complex)
    const swapGas = 350000n; // Boosted swaps with wrap/unwrap are more expensive
    console.log(`📝 Swap gas estimate: ${swapGas} gas (3-step boosted swap)`);

    // Expected output: ~1 USDC for 1 GHO (stablecoin swap)
    const expectedOutput = ethers.parseUnits("0.99", usdcDecimals); // Expect ~0.99 USDC
    const minAmountOut = expectedOutput * BigInt(100 - SLIPPAGE_PERCENT) / 100n;

    // =========================================================================
    // PHASE 2: THRESHOLD CHECK
    // =========================================================================
    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("PHASE 2: THRESHOLD CHECK");
    console.log("═══════════════════════════════════════════════════════════════\n");

    const erc20CostUsd = gasToUsd(erc20Gas, gasPriceGwei, ETH_PRICE_USD);
    const permit2CostUsd = gasToUsd(permit2Gas, gasPriceGwei, ETH_PRICE_USD);
    const swapCostUsd = gasToUsd(swapGas, gasPriceGwei, ETH_PRICE_USD);
    const totalCostUsd = erc20CostUsd + permit2CostUsd + swapCostUsd;

    const erc20Pass = erc20CostUsd <= MAX_APPROVAL_COST_USD;
    const permit2Pass = permit2CostUsd <= MAX_APPROVAL_COST_USD;
    const swapPass = swapCostUsd <= MAX_SWAP_COST_USD;
    const allPass = erc20Pass && permit2Pass && swapPass;

    console.log(`  ERC20 Approval:   $${erc20CostUsd.toFixed(6)} / $${MAX_APPROVAL_COST_USD} ${erc20Pass ? "✅" : "❌"}`);
    console.log(`  Permit2 Approval: $${permit2CostUsd.toFixed(6)} / $${MAX_APPROVAL_COST_USD} ${permit2Pass ? "✅" : "❌"}`);
    console.log(`  Swap Execution:   $${swapCostUsd.toFixed(6)} / $${MAX_SWAP_COST_USD} ${swapPass ? "✅" : "❌"}`);
    console.log(`  ────────────────────────────────────────`);
    console.log(`  TOTAL:            $${totalCostUsd.toFixed(6)}`);

    if (!allPass) {
        console.log("\n⛔ GAS CHECK FAILED - NOT EXECUTING");
        console.log("   Wait for lower gas prices or increase thresholds.");
        process.exit(1);
    }

    console.log("\n✅ ALL GAS CHECKS PASSED!");

    // =========================================================================
    // PHASE 3: EXECUTION
    // =========================================================================
    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("PHASE 3: EXECUTION");
    console.log("═══════════════════════════════════════════════════════════════\n");

    // Step 1: ERC20 Approval (if needed)
    if (needsErc20Approve) {
        console.log("🔄 Step 1: Approving GHO to Permit2...");
        const ghoWithSigner = new ethers.Contract(GHO_ADDRESS, ERC20_ABI, wallet);
        const tx1 = await ghoWithSigner.approve(PERMIT2_ADDRESS, ethers.MaxUint256, {
            gasLimit: erc20Gas + 10000n
        });
        console.log(`   TX: ${tx1.hash}`);
        await tx1.wait();
        console.log(`   ✅ Confirmed!`);
    } else {
        console.log("⏭️ Step 1: Skipped (already approved)");
    }

    // Step 2: Permit2 Approval (if needed)
    if (needsPermit2Approve) {
        console.log("🔄 Step 2: Approving Permit2 to BatchRouter...");
        const permit2WithSigner = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, wallet);
        const tx2 = await permit2WithSigner.approve(
            GHO_ADDRESS,
            BATCH_ROUTER,
            ethers.MaxUint256 >> 96n,
            281474976710655n,
            { gasLimit: permit2Gas + 10000n }
        );
        console.log(`   TX: ${tx2.hash}`);
        await tx2.wait();
        console.log(`   ✅ Confirmed!`);
    } else {
        console.log("⏭️ Step 2: Skipped (already approved)");
    }

    // Step 3: Execute Boosted Swap via BatchRouter
    console.log("🔄 Step 3: Executing boosted swap via BatchRouter...");
    console.log("   Path: GHO → [wrap] → waGHO → [pool swap] → waUSDC → [unwrap] → USDC");

    const batchRouter = new ethers.Contract(BATCH_ROUTER, BATCH_ROUTER_ABI, wallet);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);

    // Build the 3-step path
    const paths = [{
        tokenIn: GHO_ADDRESS,
        steps: [
            {
                pool: waGHO_ADDRESS,    // ERC-4626 wrapper acts as "pool" for buffer
                tokenOut: waGHO_ADDRESS,
                isBuffer: true          // Step 1: Wrap GHO → waGHO
            },
            {
                pool: BOOSTED_POOL,     // Actual boosted pool
                tokenOut: waUSDC_ADDRESS,
                isBuffer: false         // Step 2: Swap waGHO → waUSDC
            },
            {
                pool: waUSDC_ADDRESS,   // ERC-4626 wrapper
                tokenOut: USDC_ADDRESS,
                isBuffer: true          // Step 3: Unwrap waUSDC → USDC
            }
        ],
        exactAmountIn: amountIn,
        minAmountOut: minAmountOut
    }];

    try {
        const tx3 = await batchRouter.swapExactIn(
            paths,
            deadline,
            false,  // wethIsEth
            "0x",   // userData
            { gasLimit: swapGas + 100000n }
        );

        console.log(`   TX: ${tx3.hash}`);
        const receipt = await tx3.wait();
        console.log(`   ✅ Confirmed in block ${receipt.blockNumber}!`);

        // =========================================================================
        // RESULT
        // =========================================================================
        console.log("\n═══════════════════════════════════════════════════════════════");
        console.log("🎉 BOOSTED SWAP COMPLETE!");
        console.log("═══════════════════════════════════════════════════════════════\n");

        const newUsdcBalance = await usdc.balanceOf(userAddress);
        console.log(`  Swapped: ${TRADE_AMOUNT} GHO → USDC`);
        console.log(`  New USDC balance: ${ethers.formatUnits(newUsdcBalance, usdcDecimals)}`);
        console.log(`  Total gas cost: $${totalCostUsd.toFixed(6)}`);

    } catch (error) {
        console.log(`\n❌ Swap failed: ${error.message}`);
        if (error.data) {
            console.log(`   Error data: ${error.data}`);
        }
        process.exit(1);
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("\n❌ Error:", error.message);
        process.exit(1);
    });
