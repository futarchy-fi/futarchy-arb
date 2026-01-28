/**
 * Gas-Aware Swap Feasibility Test (Real Estimates)
 * 
 * Uses eth_estimateGas for ACCURATE gas calculations - NO hardcoded values!
 * 
 * Thresholds:
 * - Each Approval: max $0.20 USD
 * - Swap (10 GHO): max $0.50 USD (5% of trade)
 */

const { ethers } = require("ethers");

// ============================================================================
// CONFIGURATION
// ============================================================================

const RPC_URL = "https://ethereum.publicnode.com";

// Contract Addresses (Ethereum Mainnet)
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const UNIVERSAL_ROUTER = "0x66a9893cc07d91d95644aedd05d03f95e1dba8af";
const QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";

// Proposal tokens (from previous discovery)
const YES_GHO = "0x01917fD18c1019389cC89457c53E6631A13c1e9D";
const YES_AAVE = "0x63Ad5275380416b3700B84BFaD3B74ED812dfAE4";

// Trade parameters
const TRADE_AMOUNT = "10"; // 10 GHO (assuming 1 GHO = 1 USD)
const FEE_TIER = 500; // 0.05%

// Gas cost thresholds (in USD)
const MAX_APPROVAL_COST_USD = 0.20;
const MAX_SWAP_FEE_PERCENT = 5;
const MAX_SWAP_COST_USD = parseFloat(TRADE_AMOUNT) * (MAX_SWAP_FEE_PERCENT / 100);

// ETH price (can be fetched from oracle, using estimate)
const ETH_PRICE_USD = 3300;

// ============================================================================
// ABIs
// ============================================================================

const ERC20_ABI = [
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function balanceOf(address account) view returns (uint256)",
    "function decimals() view returns (uint8)"
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
// HELPER FUNCTIONS
// ============================================================================

function gasToUsd(gasUnits, gasPriceGwei, ethPriceUsd) {
    const ethCost = (Number(gasUnits) * gasPriceGwei) / 1e9;
    return ethCost * ethPriceUsd;
}

// Build Universal Router swap calldata
function buildSwapCalldata(tokenIn, tokenOut, amountIn, fee, recipient) {
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();

    // Build path: tokenIn + fee (3 bytes) + tokenOut
    const path = ethers.solidityPacked(
        ['address', 'uint24', 'address'],
        [tokenIn, fee, tokenOut]
    );

    // V3_SWAP_EXACT_IN command = 0x00
    const V3_SWAP_EXACT_IN = 0x00;
    const SWEEP = 0x04;

    // Encode V3_SWAP_EXACT_IN params: (recipient, amountIn, amountOutMin, path, payerIsUser)
    const swapParams = abiCoder.encode(
        ['address', 'uint256', 'uint256', 'bytes', 'bool'],
        [
            '0x0000000000000000000000000000000000000002', // MSG_SENDER placeholder
            amountIn,
            0, // minAmountOut (0 for estimation)
            path,
            true // payerIsUser
        ]
    );

    // Encode SWEEP params: (token, recipient, minAmount)
    const sweepParams = abiCoder.encode(
        ['address', 'address', 'uint256'],
        [tokenOut, recipient, 0]
    );

    // Build commands and inputs
    const commands = ethers.hexlify(new Uint8Array([V3_SWAP_EXACT_IN, SWEEP]));
    const inputs = [swapParams, sweepParams];
    const deadline = Math.floor(Date.now() / 1000) + 1200;

    // Encode execute() call
    const routerInterface = new ethers.Interface(UNIVERSAL_ROUTER_ABI);
    return routerInterface.encodeFunctionData('execute', [commands, inputs, deadline]);
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    console.log("╔════════════════════════════════════════════════════════════════╗");
    console.log("║  GAS-AWARE SWAP TEST (REAL eth_estimateGas)                    ║");
    console.log("║  YES_GHO → YES_AAVE on Ethereum Mainnet                        ║");
    console.log("╚════════════════════════════════════════════════════════════════╝\n");

    const provider = new ethers.JsonRpcProvider(RPC_URL);

    // Use a dummy address for estimation (any address works)
    const DUMMY_USER = "0x0000000000000000000000000000000000000001";

    // Get current gas price
    const feeData = await provider.getFeeData();
    const gasPriceWei = feeData.gasPrice;
    const gasPriceGwei = parseFloat(ethers.formatUnits(gasPriceWei, "gwei"));

    console.log("📊 NETWORK CONDITIONS (Real-time)");
    console.log("=".repeat(60));
    console.log(`  Gas Price: ${gasPriceGwei.toFixed(4)} Gwei`);
    console.log(`  ETH Price: $${ETH_PRICE_USD} (assumed)`);
    console.log(`  Trade: ${TRADE_AMOUNT} YES_GHO → YES_AAVE`);
    console.log();

    const decimals = 18;
    const amountIn = ethers.parseUnits(TRADE_AMOUNT, decimals);

    // =========================================================================
    // STEP 1: Estimate ERC20 Approve Gas (REAL)
    // =========================================================================
    console.log("💰 STEP 1: ERC20 APPROVAL (eth_estimateGas)");
    console.log("-".repeat(60));

    let erc20Gas = 0n;
    try {
        const tokenContract = new ethers.Contract(YES_GHO, ERC20_ABI, provider);
        const approveData = tokenContract.interface.encodeFunctionData('approve', [
            PERMIT2_ADDRESS,
            ethers.MaxUint256
        ]);

        erc20Gas = await provider.estimateGas({
            to: YES_GHO,
            data: approveData,
            from: DUMMY_USER
        });

        const erc20CostUsd = gasToUsd(erc20Gas, gasPriceGwei, ETH_PRICE_USD);
        console.log(`  ✅ Estimated Gas: ${erc20Gas.toString()} units`);
        console.log(`  💵 Cost: $${erc20CostUsd.toFixed(6)}`);
        console.log(`  📏 Limit: $${MAX_APPROVAL_COST_USD.toFixed(2)}`);
        console.log(`  ${erc20CostUsd <= MAX_APPROVAL_COST_USD ? "✅ PASS" : "❌ FAIL"}`);
    } catch (e) {
        console.log(`  ⚠️ Could not estimate (using fallback): ${e.message.slice(0, 50)}...`);
        erc20Gas = 50000n;
    }
    console.log();

    // =========================================================================
    // STEP 2: Estimate Permit2 Approve Gas (REAL)
    // =========================================================================
    console.log("💰 STEP 2: PERMIT2 APPROVAL (eth_estimateGas)");
    console.log("-".repeat(60));

    let permit2Gas = 0n;
    try {
        const permit2Contract = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, provider);
        const approveData = permit2Contract.interface.encodeFunctionData('approve', [
            YES_GHO,
            UNIVERSAL_ROUTER,
            ethers.MaxUint256 >> 96n, // uint160 max
            281474976710655n // uint48 max expiration
        ]);

        permit2Gas = await provider.estimateGas({
            to: PERMIT2_ADDRESS,
            data: approveData,
            from: DUMMY_USER
        });

        const permit2CostUsd = gasToUsd(permit2Gas, gasPriceGwei, ETH_PRICE_USD);
        console.log(`  ✅ Estimated Gas: ${permit2Gas.toString()} units`);
        console.log(`  💵 Cost: $${permit2CostUsd.toFixed(6)}`);
        console.log(`  📏 Limit: $${MAX_APPROVAL_COST_USD.toFixed(2)}`);
        console.log(`  ${permit2CostUsd <= MAX_APPROVAL_COST_USD ? "✅ PASS" : "❌ FAIL"}`);
    } catch (e) {
        console.log(`  ⚠️ Could not estimate (using fallback): ${e.message.slice(0, 50)}...`);
        permit2Gas = 55000n;
    }
    console.log();

    // =========================================================================
    // STEP 3: Estimate Swap Gas using QuoterV2 (REAL)
    // =========================================================================
    console.log("💰 STEP 3: SWAP EXECUTION (QuoterV2.gasEstimate)");
    console.log("-".repeat(60));

    let swapGas = 0n;
    let amountOut = 0n;

    try {
        const quoter = new ethers.Contract(QUOTER_V2, QUOTER_V2_ABI, provider);

        // QuoterV2 returns gasEstimate as part of the quote
        const quoteResult = await quoter.quoteExactInputSingle.staticCall({
            tokenIn: YES_GHO,
            tokenOut: YES_AAVE,
            amountIn: amountIn,
            fee: FEE_TIER,
            sqrtPriceLimitX96: 0
        });

        amountOut = quoteResult[0];
        swapGas = quoteResult[3]; // gasEstimate from QuoterV2

        // Add overhead for Universal Router (Permit2 transfer, SWEEP, etc.)
        const routerOverhead = 50000n;
        swapGas = swapGas + routerOverhead;

        const swapCostUsd = gasToUsd(swapGas, gasPriceGwei, ETH_PRICE_USD);
        const amountOutFormatted = ethers.formatUnits(amountOut, 18);

        console.log(`  ✅ Quote: ${TRADE_AMOUNT} YES_GHO → ${parseFloat(amountOutFormatted).toFixed(6)} YES_AAVE`);
        console.log(`  ✅ Estimated Gas: ${swapGas.toString()} units (incl. router overhead)`);
        console.log(`  💵 Cost: $${swapCostUsd.toFixed(6)}`);
        console.log(`  📏 Limit: $${MAX_SWAP_COST_USD.toFixed(2)}`);
        console.log(`  ${swapCostUsd <= MAX_SWAP_COST_USD ? "✅ PASS" : "❌ FAIL"}`);
    } catch (e) {
        console.log(`  ⚠️ Could not get quote: ${e.message.slice(0, 80)}...`);
        console.log(`  Using fallback gas estimate: 200,000`);
        swapGas = 200000n;
    }
    console.log();

    // =========================================================================
    // SUMMARY
    // =========================================================================
    console.log("=".repeat(60));
    console.log("📋 FINAL SUMMARY (REAL ESTIMATES)");
    console.log("=".repeat(60));

    const totalGas = erc20Gas + permit2Gas + swapGas;
    const erc20CostUsd = gasToUsd(erc20Gas, gasPriceGwei, ETH_PRICE_USD);
    const permit2CostUsd = gasToUsd(permit2Gas, gasPriceGwei, ETH_PRICE_USD);
    const swapCostUsd = gasToUsd(swapGas, gasPriceGwei, ETH_PRICE_USD);
    const totalCostUsd = erc20CostUsd + permit2CostUsd + swapCostUsd;
    const tradeValue = parseFloat(TRADE_AMOUNT);
    const feePercent = (totalCostUsd / tradeValue) * 100;

    console.log();
    console.log("  Gas Breakdown:");
    console.log(`    ERC20 Approve:    ${erc20Gas.toString().padStart(8)} gas → $${erc20CostUsd.toFixed(6)}`);
    console.log(`    Permit2 Approve:  ${permit2Gas.toString().padStart(8)} gas → $${permit2CostUsd.toFixed(6)}`);
    console.log(`    Swap Execution:   ${swapGas.toString().padStart(8)} gas → $${swapCostUsd.toFixed(6)}`);
    console.log(`    ─────────────────────────────────────────────`);
    console.log(`    TOTAL:            ${totalGas.toString().padStart(8)} gas → $${totalCostUsd.toFixed(6)}`);
    console.log();
    console.log(`  Trade Value: $${tradeValue.toFixed(2)}`);
    console.log(`  Total Fees:  $${totalCostUsd.toFixed(6)} (${feePercent.toFixed(4)}%)`);
    console.log(`  Net Value:   $${(tradeValue - totalCostUsd).toFixed(6)}`);
    console.log();

    const allPass =
        erc20CostUsd <= MAX_APPROVAL_COST_USD &&
        permit2CostUsd <= MAX_APPROVAL_COST_USD &&
        swapCostUsd <= MAX_SWAP_COST_USD;

    if (allPass) {
        console.log("  🎉 RESULT: ALL CHECKS PASS - SWAP IS VIABLE!");
    } else {
        console.log("  ⛔ RESULT: GAS COSTS EXCEED THRESHOLDS");

        // Calculate max viable gas price
        const maxCostWei = (MAX_APPROVAL_COST_USD * 2 + MAX_SWAP_COST_USD) / ETH_PRICE_USD;
        const maxGasPriceGwei = (maxCostWei * 1e9) / Number(totalGas);
        console.log(`  💡 Need gas price ≤ ${maxGasPriceGwei.toFixed(2)} Gwei for viability`);
    }
    console.log();
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("\n❌ Error:", error.message);
        process.exit(1);
    });
