/**
 * Balancer V3 Swap: GHO → AAVE
 * 
 * This script:
 * 1. Estimates gas costs
 * 2. Verifies/completes ERC20 approval to Permit2
 * 3. Verifies/completes Permit2 approval to Router  
 * 4. Executes swap via Balancer V3 Router
 * 
 * Uses .env file for PRIVATE_KEY
 * Usage: node scripts/execute-balancer-v3-swap.js
 */

require('dotenv').config();
const { ethers } = require("ethers");

// ============================================================================
// CONFIGURATION
// ============================================================================

const RPC_URL = "https://ethereum.publicnode.com";

// Balancer V3 Contracts (Ethereum Mainnet)
const BALANCER_V3_ROUTER = "0xAE563E3f8219521950555F5962419C8919758Ea2";
const BALANCER_V3_VAULT = "0xbA1333333333a1BA1108E8412f11850A5C319bA9";
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

// Token Addresses
const GHO_ADDRESS = "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f";
const AAVE_ADDRESS = "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9";
const GHO_AAVE_POOL = "0x85b2b559bc2d21104c4defdd6efca8a20343361d";

// Trade parameters
const TRADE_AMOUNT = "5";
const SLIPPAGE_PERCENT = 3;

// Gas cost thresholds (in USD)
const MAX_APPROVAL_COST_USD = 0.20;
const MAX_SWAP_FEE_PERCENT = 5;
const MAX_SWAP_COST_USD = parseFloat(TRADE_AMOUNT) * (MAX_SWAP_FEE_PERCENT / 100);

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

const BALANCER_ROUTER_ABI = [
    "function swapSingleTokenExactIn(address pool, address tokenIn, address tokenOut, uint256 exactAmountIn, uint256 minAmountOut, uint256 deadline, bool wethIsEth, bytes userData) external payable returns (uint256)",
    "function querySwapSingleTokenExactIn(address pool, address tokenIn, address tokenOut, uint256 exactAmountIn, address sender, bytes userData) external returns (uint256 amountCalculated)",
    "function getPermit2() view returns (address)",
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
    console.log("║  BALANCER V3 SWAP: GHO → AAVE                                  ║");
    console.log("║  Ethereum Mainnet via Router + Permit2                         ║");
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
    const permit2 = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, provider);
    const router = new ethers.Contract(BALANCER_V3_ROUTER, BALANCER_ROUTER_ABI, provider);

    // Get balances
    const ghoDecimals = await gho.decimals();
    const ghoBalance = await gho.balanceOf(userAddress);
    const amountIn = ethers.parseUnits(TRADE_AMOUNT, ghoDecimals);

    console.log(`💰 GHO Balance: ${ethers.formatUnits(ghoBalance, ghoDecimals)}`);
    console.log(`📊 Trade Amount: ${TRADE_AMOUNT} GHO`);

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
    // PHASE 1: GAS ESTIMATION
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

    // Check Permit2 allowance to Router
    const [p2Amount, p2Expiration] = await permit2.allowance(userAddress, GHO_ADDRESS, BALANCER_V3_ROUTER);
    const now = Math.floor(Date.now() / 1000);
    const needsPermit2Approve = p2Amount < amountIn || p2Expiration <= now;

    let permit2Gas = 0n;
    if (needsPermit2Approve) {
        const p2ApproveData = permit2.interface.encodeFunctionData('approve', [
            GHO_ADDRESS, BALANCER_V3_ROUTER, ethers.MaxUint256 >> 96n, 281474976710655n
        ]);
        permit2Gas = await provider.estimateGas({ to: PERMIT2_ADDRESS, data: p2ApproveData, from: userAddress });
        console.log(`📝 Permit2 → Router approval needed: ${permit2Gas} gas ($${gasToUsd(permit2Gas, gasPriceGwei, ETH_PRICE_USD).toFixed(6)})`);
    } else {
        console.log(`✅ Permit2 already approved to Balancer Router`);
    }

    // Get quote from Router
    console.log(`\n🔍 Getting swap quote from Balancer V3...`);

    let amountOut;
    let swapGas = 200000n; // Fallback estimate

    try {
        // Query the swap (read-only simulation)
        amountOut = await router.querySwapSingleTokenExactIn.staticCall(
            GHO_AAVE_POOL,
            GHO_ADDRESS,
            AAVE_ADDRESS,
            amountIn,
            userAddress,
            "0x"
        );
        console.log(`📊 Quote: ${TRADE_AMOUNT} GHO → ${ethers.formatUnits(amountOut, 18)} AAVE`);

        // Estimate swap gas
        const swapData = router.interface.encodeFunctionData('swapSingleTokenExactIn', [
            GHO_AAVE_POOL,
            GHO_ADDRESS,
            AAVE_ADDRESS,
            amountIn,
            0n, // minAmountOut (0 for estimation)
            BigInt(Math.floor(Date.now() / 1000) + 3600),
            false,
            "0x"
        ]);

        swapGas = await provider.estimateGas({
            to: BALANCER_V3_ROUTER,
            data: swapData,
            from: userAddress
        });
        console.log(`📝 Swap gas estimate: ${swapGas} gas`);
    } catch (err) {
        console.log(`⚠️ Quote failed: ${err.message}`);
        console.log(`   Using fallback gas estimate: ${swapGas}`);
        amountOut = 0n;
    }

    const minAmountOut = amountOut * BigInt(100 - SLIPPAGE_PERCENT) / 100n;

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
        console.log("🔄 Step 2: Approving Permit2 to Balancer Router...");
        const permit2WithSigner = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, wallet);
        const tx2 = await permit2WithSigner.approve(
            GHO_ADDRESS,
            BALANCER_V3_ROUTER,
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

    // Step 3: Execute Swap via Balancer V3 Router
    console.log("🔄 Step 3: Executing swap via Balancer V3 Router...");

    const routerWithSigner = new ethers.Contract(BALANCER_V3_ROUTER, BALANCER_ROUTER_ABI, wallet);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200); // 20 minutes

    const tx3 = await routerWithSigner.swapSingleTokenExactIn(
        GHO_AAVE_POOL,
        GHO_ADDRESS,
        AAVE_ADDRESS,
        amountIn,
        minAmountOut,
        deadline,
        false,  // wethIsEth
        "0x",   // userData
        { gasLimit: swapGas + 50000n }
    );

    console.log(`   TX: ${tx3.hash}`);
    const receipt = await tx3.wait();
    console.log(`   ✅ Confirmed in block ${receipt.blockNumber}!`);

    // =========================================================================
    // RESULT
    // =========================================================================
    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("🎉 SWAP COMPLETE!");
    console.log("═══════════════════════════════════════════════════════════════\n");

    const aave = new ethers.Contract(AAVE_ADDRESS, ERC20_ABI, provider);
    const newAaveBalance = await aave.balanceOf(userAddress);
    console.log(`  Expected AAVE: ~${ethers.formatUnits(amountOut, 18)}`);
    console.log(`  New AAVE balance: ${ethers.formatUnits(newAaveBalance, 18)}`);
    console.log(`  Total gas cost: $${totalCostUsd.toFixed(6)}`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("\n❌ Error:", error.message);
        if (error.data) console.error("   Data:", error.data);
        process.exit(1);
    });
