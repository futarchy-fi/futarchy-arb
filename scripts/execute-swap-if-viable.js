/**
 * Execute Swap If Gas Check Passes
 * 
 * This script:
 * 1. Estimates real gas costs for approvals + swap
 * 2. If within thresholds, EXECUTES the transaction
 * 
 * Thresholds:
 * - Each Approval: max $0.20 USD
 * - Swap: max 5% of trade value
 * 
 * Uses .env file for PRIVATE_KEY
 * Usage: node scripts/execute-swap-if-viable.js
 */

require('dotenv').config();
const { ethers } = require("ethers");

// ============================================================================
// CONFIGURATION
// ============================================================================

const RPC_URL = "https://ethereum.publicnode.com";

// Contract Addresses (Ethereum Mainnet)
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const UNIVERSAL_ROUTER = "0x66a9893cc07d91d95644aedd05d03f95e1dba8af";
const QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";

// Proposal tokens
const YES_GHO = "0x01917fD18c1019389cC89457c53E6631A13c1e9D";
const YES_AAVE = "0x63Ad5275380416b3700B84BFaD3B74ED812dfAE4";

// Trade parameters
const TRADE_AMOUNT = "1";
const FEE_TIER = 500;
const SLIPPAGE_PERCENT = 3; // 3% slippage tolerance

// Gas cost thresholds (in USD)
const MAX_APPROVAL_COST_USD = 0.20;
const MAX_SWAP_FEE_PERCENT = 5;
const MAX_SWAP_COST_USD = parseFloat(TRADE_AMOUNT) * (MAX_SWAP_FEE_PERCENT / 100);

// ETH price (update or fetch from oracle)
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

const UNIVERSAL_ROUTER_ABI = [
    "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"
];

const QUOTER_V2_ABI = [
    "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)"
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
    console.log("║  EXECUTE SWAP IF GAS CHECK PASSES                              ║");
    console.log("║  YES_GHO → YES_AAVE on Ethereum Mainnet                        ║");
    console.log("╚════════════════════════════════════════════════════════════════╝\n");

    // Check for private key
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) {
        console.log("❌ ERROR: PRIVATE_KEY environment variable required");
        console.log("   Usage: PRIVATE_KEY=0x... node scripts/execute-swap-if-viable.js");
        console.log("\n   For DRY RUN (no execution): node scripts/test-swap-gas-check.js");
        process.exit(1);
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(privateKey, provider);
    const userAddress = await wallet.getAddress();

    console.log(`👤 Wallet: ${userAddress}`);

    // Get balances
    const tokenIn = new ethers.Contract(YES_GHO, ERC20_ABI, provider);
    const balance = await tokenIn.balanceOf(userAddress);
    const decimals = await tokenIn.decimals();
    const amountIn = ethers.parseUnits(TRADE_AMOUNT, decimals);

    console.log(`💰 YES_GHO Balance: ${ethers.formatUnits(balance, decimals)}`);

    if (balance < amountIn) {
        console.log(`❌ Insufficient balance. Need ${TRADE_AMOUNT}, have ${ethers.formatUnits(balance, decimals)}`);
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
    console.log("PHASE 1: GAS ESTIMATION");
    console.log("═══════════════════════════════════════════════════════════════\n");

    // Check ERC20 allowance to Permit2
    const erc20Allowance = await tokenIn.allowance(userAddress, PERMIT2_ADDRESS);
    const needsErc20Approve = erc20Allowance < amountIn;

    let erc20Gas = 0n;
    if (needsErc20Approve) {
        const approveData = tokenIn.interface.encodeFunctionData('approve', [PERMIT2_ADDRESS, ethers.MaxUint256]);
        erc20Gas = await provider.estimateGas({ to: YES_GHO, data: approveData, from: userAddress });
        console.log(`📝 ERC20 Approval needed: ${erc20Gas} gas ($${gasToUsd(erc20Gas, gasPriceGwei, ETH_PRICE_USD).toFixed(6)})`);
    } else {
        console.log(`✅ ERC20 already approved to Permit2`);
    }

    // Check Permit2 allowance to Router
    const permit2 = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, provider);
    const [p2Amount, p2Expiration] = await permit2.allowance(userAddress, YES_GHO, UNIVERSAL_ROUTER);
    const now = Math.floor(Date.now() / 1000);
    const needsPermit2Approve = p2Amount < amountIn || p2Expiration <= now;

    let permit2Gas = 0n;
    if (needsPermit2Approve) {
        const p2ApproveData = permit2.interface.encodeFunctionData('approve', [
            YES_GHO, UNIVERSAL_ROUTER, ethers.MaxUint256 >> 96n, 281474976710655n
        ]);
        permit2Gas = await provider.estimateGas({ to: PERMIT2_ADDRESS, data: p2ApproveData, from: userAddress });
        console.log(`📝 Permit2 Approval needed: ${permit2Gas} gas ($${gasToUsd(permit2Gas, gasPriceGwei, ETH_PRICE_USD).toFixed(6)})`);
    } else {
        console.log(`✅ Permit2 already approved to Router`);
    }

    // Get quote and swap gas estimate
    const quoter = new ethers.Contract(QUOTER_V2, QUOTER_V2_ABI, provider);
    const quoteResult = await quoter.quoteExactInputSingle.staticCall({
        tokenIn: YES_GHO, tokenOut: YES_AAVE, amountIn: amountIn, fee: FEE_TIER, sqrtPriceLimitX96: 0
    });

    const amountOut = quoteResult[0];
    const swapGasFromQuoter = quoteResult[3];
    const swapGas = swapGasFromQuoter + 50000n; // Add router overhead

    const minAmountOut = amountOut * BigInt(100 - SLIPPAGE_PERCENT) / 100n;

    console.log(`\n📊 Quote: ${TRADE_AMOUNT} YES_GHO → ${ethers.formatUnits(amountOut, 18)} YES_AAVE`);
    console.log(`   Min output (${SLIPPAGE_PERCENT}% slippage): ${ethers.formatUnits(minAmountOut, 18)} YES_AAVE`);
    console.log(`📝 Swap gas estimate: ${swapGas} gas ($${gasToUsd(swapGas, gasPriceGwei, ETH_PRICE_USD).toFixed(6)})`);

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
        console.log("🔄 Step 1: Approving YES_GHO to Permit2...");
        const tokenWithSigner = new ethers.Contract(YES_GHO, ERC20_ABI, wallet);
        const tx1 = await tokenWithSigner.approve(PERMIT2_ADDRESS, ethers.MaxUint256, {
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
        console.log("🔄 Step 2: Approving Permit2 to Universal Router...");
        const permit2WithSigner = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, wallet);
        const tx2 = await permit2WithSigner.approve(
            YES_GHO,
            UNIVERSAL_ROUTER,
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

    // Step 3: Execute Swap
    console.log("🔄 Step 3: Executing swap via Universal Router...");

    // Build swap calldata
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const path = ethers.solidityPacked(['address', 'uint24', 'address'], [YES_GHO, FEE_TIER, YES_AAVE]);

    const V3_SWAP_EXACT_IN = 0x00;
    const SWEEP = 0x04;

    const swapParams = abiCoder.encode(
        ['address', 'uint256', 'uint256', 'bytes', 'bool'],
        ['0x0000000000000000000000000000000000000002', amountIn, minAmountOut, path, true]
    );

    const sweepParams = abiCoder.encode(
        ['address', 'address', 'uint256'],
        [YES_AAVE, userAddress, minAmountOut]
    );

    const commands = ethers.hexlify(new Uint8Array([V3_SWAP_EXACT_IN, SWEEP]));
    const inputs = [swapParams, sweepParams];
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);

    const router = new ethers.Contract(UNIVERSAL_ROUTER, UNIVERSAL_ROUTER_ABI, wallet);
    const tx3 = await router.execute(commands, inputs, deadline, {
        gasLimit: swapGas + 30000n
    });

    console.log(`   TX: ${tx3.hash}`);
    const receipt = await tx3.wait();
    console.log(`   ✅ Confirmed in block ${receipt.blockNumber}!`);

    // =========================================================================
    // RESULT
    // =========================================================================
    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("🎉 SWAP COMPLETE!");
    console.log("═══════════════════════════════════════════════════════════════\n");

    const newBalance = await new ethers.Contract(YES_AAVE, ERC20_ABI, provider).balanceOf(userAddress);
    console.log(`  YES_AAVE received: ~${ethers.formatUnits(amountOut, 18)}`);
    console.log(`  New YES_AAVE balance: ${ethers.formatUnits(newBalance, 18)}`);
    console.log(`  Total gas cost: $${totalCostUsd.toFixed(6)}`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("\n❌ Error:", error.message);
        if (error.data) console.error("   Data:", error.data);
        process.exit(1);
    });
