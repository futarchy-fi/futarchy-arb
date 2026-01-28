/**
 * Balancer V2 Multi-Hop Swap: GHO → AAVE
 * 
 * Uses batchSwap with 3-hop path:
 * GHO → GYD → wstETH → AAVE
 * 
 * Based on verified TX: 0x56a9a03afe84c964bffc2d395df57a70f04eee0519b207cb01f974ae161b3e94
 * 
 * Usage: node scripts/execute-balancer-v2-swap.js
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
const GHO_ADDRESS = "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f";
const GYD_ADDRESS = "0xe07F9D810a48ab5c3c914BA3cA53AF14E4491e8A";
const WSTETH_ADDRESS = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
const AAVE_ADDRESS = "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9";

// Pool IDs (verified from successful TX)
const GHO_GYD_POOL = "0xaa7a70070e7495fe86c67225329dbd39baa2f63b000200000000000000000663";
const GYD_WSTETH_POOL = "0xc8cf54b0b70899ea846b70361e62f3f5b22b1f4b0002000000000000000006c7";
const WSTETH_AAVE_POOL = "0x3de27efa2f1aa663ae5d458857e731c129069f29000200000000000000000588";

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
    console.log("║  BALANCER V2 BATCH SWAP: GHO → AAVE (3-hop)                    ║");
    console.log("║  Path: GHO → GYD → wstETH → AAVE                               ║");
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
    const aave = new ethers.Contract(AAVE_ADDRESS, ERC20_ABI, provider);

    // Get balances and decimals
    const ghoDecimals = await gho.decimals();
    const aaveDecimals = await aave.decimals();
    const ghoBalance = await gho.balanceOf(userAddress);
    const aaveBalanceBefore = await aave.balanceOf(userAddress);
    const amountIn = ethers.parseUnits(TRADE_AMOUNT, ghoDecimals);

    console.log(`💰 GHO Balance: ${ethers.formatUnits(ghoBalance, ghoDecimals)}`);
    console.log(`💰 AAVE Balance: ${ethers.formatUnits(aaveBalanceBefore, aaveDecimals)}`);
    console.log(`📊 Trade: ${TRADE_AMOUNT} GHO → AAVE (via GYD, wstETH)\n`);

    console.log("📋 Swap Path:");
    console.log("   Step 1: GHO → GYD   (Pool 0xaa7a...)");
    console.log("   Step 2: GYD → wstETH (Pool 0xc8cf...)");
    console.log("   Step 3: wstETH → AAVE (Pool 0x3de2...)\n");

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

    // Check ERC20 allowance to Vault (V2 approves directly to Vault!)
    const vaultAllowance = await gho.allowance(userAddress, VAULT_ADDRESS);
    const needsApproval = vaultAllowance < amountIn;

    let approvalGas = 0n;
    if (needsApproval) {
        const approveData = gho.interface.encodeFunctionData('approve', [VAULT_ADDRESS, ethers.MaxUint256]);
        approvalGas = await provider.estimateGas({ to: GHO_ADDRESS, data: approveData, from: userAddress });
        console.log(`📝 GHO → Vault approval needed: ${approvalGas} gas ($${gasToUsd(approvalGas, gasPriceGwei, ETH_PRICE_USD).toFixed(6)})`);
    } else {
        console.log(`✅ GHO already approved to Vault`);
    }

    // Estimate swap gas (based on verified TX: ~316k gas)
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

    // Step 1: Approval (if needed)
    if (needsApproval) {
        console.log("🔄 Step 1: Approving GHO to Vault...");
        const ghoWithSigner = new ethers.Contract(GHO_ADDRESS, ERC20_ABI, wallet);
        const tx1 = await ghoWithSigner.approve(VAULT_ADDRESS, ethers.MaxUint256, {
            gasLimit: approvalGas + 10000n
        });
        console.log(`   TX: ${tx1.hash}`);
        await tx1.wait();
        console.log(`   ✅ Confirmed!`);
    } else {
        console.log("⏭️ Step 1: Skipped (already approved)");
    }

    // Step 2: Execute batchSwap
    console.log("🔄 Step 2: Executing 3-hop batchSwap...");
    console.log("   Path: GHO → GYD → wstETH → AAVE");

    const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);

    // Assets array (order matters!)
    const assets = [
        GHO_ADDRESS,    // Index 0 - input
        GYD_ADDRESS,    // Index 1 - intermediate
        WSTETH_ADDRESS, // Index 2 - intermediate
        AAVE_ADDRESS    // Index 3 - output
    ];

    // Swap steps
    const swaps = [
        {
            poolId: GHO_GYD_POOL,
            assetInIndex: 0n,
            assetOutIndex: 1n,
            amount: amountIn,
            userData: "0x"
        },
        {
            poolId: GYD_WSTETH_POOL,
            assetInIndex: 1n,
            assetOutIndex: 2n,
            amount: 0n,  // Use output from step 1
            userData: "0x"
        },
        {
            poolId: WSTETH_AAVE_POOL,
            assetInIndex: 2n,
            assetOutIndex: 3n,
            amount: 0n,  // Use output from step 2
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

    // Limits: positive = max send, negative = min receive
    // Expected ~0.006 AAVE for 1 GHO, with slippage
    const minAaveOut = ethers.parseUnits("0.005", aaveDecimals);  // ~0.005 AAVE minimum
    const limits = [
        amountIn,           // Max GHO to send
        0n,                 // GYD intermediate (0 = no limit)
        0n,                 // wstETH intermediate
        -minAaveOut         // Min AAVE to receive (negative!)
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
        console.log("🎉 BATCH SWAP COMPLETE!");
        console.log("═══════════════════════════════════════════════════════════════\n");

        const aaveBalanceAfter = await aave.balanceOf(userAddress);
        const aaveReceived = aaveBalanceAfter - aaveBalanceBefore;

        console.log(`  Swapped: ${TRADE_AMOUNT} GHO → AAVE`);
        console.log(`  AAVE Received: ${ethers.formatUnits(aaveReceived, aaveDecimals)}`);
        console.log(`  New AAVE Balance: ${ethers.formatUnits(aaveBalanceAfter, aaveDecimals)}`);
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
