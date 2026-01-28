/**
 * Balancer V2 Multi-Hop Swap: AAVE → GHO (Reverse)
 * 
 * Uses batchSwap with 3-hop reverse path:
 * AAVE → wstETH → GYD → GHO
 * 
 * Usage: node scripts/execute-balancer-v2-reverse.js
 */

require('dotenv').config();
const { ethers } = require("ethers");

// ============================================================================
// CONFIGURATION
// ============================================================================

const RPC_URL = "https://ethereum.publicnode.com";

// Balancer V2 Vault (same on ALL chains!)
const VAULT_ADDRESS = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";

// Token Addresses (Ethereum Mainnet)
const AAVE_ADDRESS = "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9";
const WSTETH_ADDRESS = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
const GYD_ADDRESS = "0xe07F9D810a48ab5c3c914BA3cA53AF14E4491e8A";
const GHO_ADDRESS = "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f";

// Pool IDs (same pools, reverse direction works!)
const AAVE_WSTETH_POOL = "0x3de27efa2f1aa663ae5d458857e731c129069f29000200000000000000000588";
const WSTETH_GYD_POOL = "0xc8cf54b0b70899ea846b70361e62f3f5b22b1f4b0002000000000000000006c7";
const GYD_GHO_POOL = "0xaa7a70070e7495fe86c67225329dbd39baa2f63b000200000000000000000663";

// Trade parameters
const TRADE_AMOUNT = "0.012";  // 0.012 AAVE
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

const VAULT_ABI = [
    `function batchSwap(
    uint8 kind,
    (bytes32 poolId, uint256 assetInIndex, uint256 assetOutIndex, uint256 amount, bytes userData)[] swaps,
    address[] assets,
    (address sender, bool fromInternalBalance, address recipient, bool toInternalBalance) funds,
    int256[] limits,
    uint256 deadline
  ) external payable returns (int256[])`
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
    console.log("║  BALANCER V2 BATCH SWAP: AAVE → GHO (3-hop REVERSE)            ║");
    console.log("║  Path: AAVE → wstETH → GYD → GHO                               ║");
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
    const aave = new ethers.Contract(AAVE_ADDRESS, ERC20_ABI, provider);
    const gho = new ethers.Contract(GHO_ADDRESS, ERC20_ABI, provider);

    // Get balances and decimals
    const aaveDecimals = await aave.decimals();
    const ghoDecimals = await gho.decimals();
    const aaveBalance = await aave.balanceOf(userAddress);
    const ghoBalanceBefore = await gho.balanceOf(userAddress);
    const amountIn = ethers.parseUnits(TRADE_AMOUNT, aaveDecimals);

    console.log(`💰 AAVE Balance: ${ethers.formatUnits(aaveBalance, aaveDecimals)}`);
    console.log(`💰 GHO Balance: ${ethers.formatUnits(ghoBalanceBefore, ghoDecimals)}`);
    console.log(`📊 Trade: ${TRADE_AMOUNT} AAVE → GHO (via wstETH, GYD)\n`);

    console.log("📋 Swap Path (REVERSE):");
    console.log("   Step 1: AAVE → wstETH (Pool 0x3de2...)");
    console.log("   Step 2: wstETH → GYD  (Pool 0xc8cf...)");
    console.log("   Step 3: GYD → GHO    (Pool 0xaa7a...)\n");

    if (aaveBalance < amountIn) {
        console.log(`❌ Insufficient AAVE balance. Need ${TRADE_AMOUNT}, have ${ethers.formatUnits(aaveBalance, aaveDecimals)}`);
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

    // Check ERC20 allowance to Vault
    const vaultAllowance = await aave.allowance(userAddress, VAULT_ADDRESS);
    const needsApproval = vaultAllowance < amountIn;

    let approvalGas = 0n;
    if (needsApproval) {
        const approveData = aave.interface.encodeFunctionData('approve', [VAULT_ADDRESS, ethers.MaxUint256]);
        approvalGas = await provider.estimateGas({ to: AAVE_ADDRESS, data: approveData, from: userAddress });
        console.log(`📝 AAVE → Vault approval needed: ${approvalGas} gas ($${gasToUsd(approvalGas, gasPriceGwei, ETH_PRICE_USD).toFixed(6)})`);
    } else {
        console.log(`✅ AAVE already approved to Vault`);
    }

    // Estimate swap gas
    const swapGas = 350000n;
    console.log(`📝 Swap gas estimate: ${swapGas} gas (3-hop batchSwap)`);

    // =========================================================================
    // PHASE 2: THRESHOLD CHECK
    // =========================================================================
    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("PHASE 2: THRESHOLD CHECK");
    console.log("═══════════════════════════════════════════════════════════════\n");

    const approvalCostUsd = gasToUsd(approvalGas, gasPriceGwei, ETH_PRICE_USD);
    const swapCostUsd = gasToUsd(swapGas, gasPriceGwei, ETH_PRICE_USD);
    const totalCostUsd = approvalCostUsd + swapCostUsd;

    const approvalPass = approvalCostUsd <= MAX_APPROVAL_COST_USD;
    const swapPass = swapCostUsd <= MAX_SWAP_COST_USD;
    const allPass = approvalPass && swapPass;

    console.log(`  Approval:       $${approvalCostUsd.toFixed(6)} / $${MAX_APPROVAL_COST_USD} ${approvalPass ? "✅" : "❌"}`);
    console.log(`  Swap Execution: $${swapCostUsd.toFixed(6)} / $${MAX_SWAP_COST_USD} ${swapPass ? "✅" : "❌"}`);
    console.log(`  ────────────────────────────────────────`);
    console.log(`  TOTAL:          $${totalCostUsd.toFixed(6)}`);

    if (!allPass) {
        console.log("\n⛔ GAS CHECK FAILED - NOT EXECUTING");
        process.exit(1);
    }

    console.log("\n✅ ALL GAS CHECKS PASSED!");

    // =========================================================================
    // PHASE 3: EXECUTION
    // =========================================================================
    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("PHASE 3: EXECUTION");
    console.log("═══════════════════════════════════════════════════════════════\n");

    // Step 1: Approval (if needed)
    if (needsApproval) {
        console.log("🔄 Step 1: Approving AAVE to Vault...");
        const aaveWithSigner = new ethers.Contract(AAVE_ADDRESS, ERC20_ABI, wallet);
        const tx1 = await aaveWithSigner.approve(VAULT_ADDRESS, ethers.MaxUint256, {
            gasLimit: approvalGas + 10000n
        });
        console.log(`   TX: ${tx1.hash}`);
        await tx1.wait();
        console.log(`   ✅ Confirmed!`);
    } else {
        console.log("⏭️ Step 1: Skipped (already approved)");
    }

    // Step 2: Execute batchSwap (REVERSE PATH)
    console.log("🔄 Step 2: Executing 3-hop batchSwap (reverse)...");
    console.log("   Path: AAVE → wstETH → GYD → GHO");

    const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);

    // Assets array (REVERSE order!)
    const assets = [
        AAVE_ADDRESS,   // Index 0 - input
        WSTETH_ADDRESS, // Index 1 - intermediate
        GYD_ADDRESS,    // Index 2 - intermediate
        GHO_ADDRESS     // Index 3 - output
    ];

    // Swap steps (REVERSE direction!)
    const swaps = [
        {
            poolId: AAVE_WSTETH_POOL,
            assetInIndex: 0n,     // AAVE
            assetOutIndex: 1n,    // wstETH
            amount: amountIn,
            userData: "0x"
        },
        {
            poolId: WSTETH_GYD_POOL,
            assetInIndex: 1n,     // wstETH
            assetOutIndex: 2n,    // GYD
            amount: 0n,
            userData: "0x"
        },
        {
            poolId: GYD_GHO_POOL,
            assetInIndex: 2n,     // GYD
            assetOutIndex: 3n,    // GHO
            amount: 0n,
            userData: "0x"
        }
    ];

    // Funds management
    const funds = {
        sender: userAddress,
        fromInternalBalance: false,
        recipient: userAddress,
        toInternalBalance: false
    };

    // Limits - expect ~1.9 GHO for 0.012 AAVE (based on ~158 GHO/AAVE)
    const minGhoOut = ethers.parseUnits("1.5", ghoDecimals);  // Min 1.5 GHO
    const limits = [
        amountIn,       // Max AAVE to send
        0n,             // wstETH intermediate
        0n,             // GYD intermediate
        -minGhoOut      // Min GHO to receive (negative!)
    ];

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

    try {
        const tx2 = await vault.batchSwap(
            0,  // GIVEN_IN
            swaps,
            assets,
            funds,
            limits,
            deadline,
            { gasLimit: swapGas + 50000n }
        );

        console.log(`   TX: ${tx2.hash}`);
        const receipt = await tx2.wait();
        console.log(`   ✅ Confirmed in block ${receipt.blockNumber}!`);

        // =========================================================================
        // RESULT
        // =========================================================================
        console.log("\n═══════════════════════════════════════════════════════════════");
        console.log("🎉 REVERSE SWAP COMPLETE!");
        console.log("═══════════════════════════════════════════════════════════════\n");

        const ghoBalanceAfter = await gho.balanceOf(userAddress);
        const ghoReceived = ghoBalanceAfter - ghoBalanceBefore;

        console.log(`  Swapped: ${TRADE_AMOUNT} AAVE → GHO`);
        console.log(`  GHO Received: ${ethers.formatUnits(ghoReceived, ghoDecimals)}`);
        console.log(`  New GHO Balance: ${ethers.formatUnits(ghoBalanceAfter, ghoDecimals)}`);
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
