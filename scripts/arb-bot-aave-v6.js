/**
 * 🤖 AAVE/GHO Arbitrage Bot V6 (Mainnet)
 * 
 * Features:
 * - Uses AaveFlashArbitrageV6 contract (0xBc69...)
 * - Checks opportunities every block
 * - Uses staticCall for 100% accurate on-chain simulation
 * - MEV Protection: Atomic execution + minProfit check (reverts if not profitable)
 * 
 * Usage:
 *   node scripts/arb-bot-aave-v6.js
 * 
 * Environment Checks:
 * - MAINNET_RPC_URL must be set
 * - PRIVATE_KEY must be set (for execution)
 */

require("dotenv").config();
const { ethers } = require("ethers");

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
    contract: "0xBc69Db11D5Eb837926E8f5Bb6Dd20069193919AE",   // V6 Deployed Address
    proposal: "0xfb45ae9d8e5874e85b8e23d735eb9718efef47fa",   // AAVE Proposal

    // Limits
    minNetProfitUsd: 5.0,     // Minimum $5 profit afer gas to execute
    maxGasPriceGwei: 50,      // Max gas price to pay

    // Trade Sizes to Check (in AAVE)
    tradeSizes: ["0.1", "0.5", "1.0", "5.0", "15.0"],

    // RPC
    rpc: process.env.MAINNET_RPC_URL || "https://ethereum.publicnode.com",

    // Toggle Execution
    EXECUTE: true // Set to true to actually send TXs
};

const V6_ABI = [
    "function executeArbitrage(address proposalAddress, uint256 borrowAmount, uint8 direction, uint256 minProfit) external returns (tuple(bool success, uint256 profit, uint256 borrowAmount, uint256 gasUsed))",
];

// ============================================================================
// BOT LOGIC
// ============================================================================

async function main() {
    console.log("════════════════════════════════════════════════════════════");
    console.log("🤖 AAVE V6 ARBITRAGE BOT STARTING");
    console.log(`📍 Contract: ${CONFIG.contract}`);
    console.log(`🎯 Proposal: ${CONFIG.proposal}`);
    console.log("════════════════════════════════════════════════════════════");

    const provider = new ethers.JsonRpcProvider(CONFIG.rpc);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const contract = new ethers.Contract(CONFIG.contract, V6_ABI, wallet);

    console.log(`🔑 Wallet: ${wallet.address}`);

    // Main Loop
    provider.on("block", async (blockNumber) => {
        try {
            await checkOpportunities(contract, blockNumber, provider);
        } catch (e) {
            console.error(`Error in block ${blockNumber}:`, e.message.slice(0, 100));
        }
    });
}

async function checkOpportunities(contract, blockNumber, provider) {
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice;

    // Rough estimate of AAVE price in ETH (for gas calcs)
    // 1 AAVE ~ 0.05 ETH (from our earlier checks)
    const AAVE_PRICE_ETH = 0.05;
    const ETH_PRICE_USD = 2700; // Approx

    process.stdout.write(`\r📦 Block ${blockNumber} | Gas: ${ethers.formatUnits(gasPrice, "gwei")} gwei | Checking... `);

    let bestOpp = null;

    // Check both directions for all sizes
    for (const size of CONFIG.tradeSizes) {
        const amount = ethers.parseEther(size);

        // 1. Check SPOT_SPLIT (Direction 0)
        await checkStrategy(contract, amount, 0, "SPOT_SPLIT", gasPrice, AAVE_PRICE_ETH, ETH_PRICE_USD);

        // 2. Check MERGE_SPOT (Direction 1)
        await checkStrategy(contract, amount, 1, "MERGE_SPOT", gasPrice, AAVE_PRICE_ETH, ETH_PRICE_USD);
    }
}

async function checkStrategy(contract, amount, direction, stratName, gasPrice, aaveEthPrice, ethUsdPrice) {
    try {
        // staticCall to simulate
        // We set minProfit = 0 to see raw result. If it fails, it means negative profit.
        const result = await contract.executeArbitrage.staticCall(
            CONFIG.proposal,
            amount,
            direction,
            0,
            { gasLimit: 5000000 }
        );

        if (result.success) {
            const profitAave = ethers.formatEther(result.profit);

            // Calculate Gas Cost in AAVE terms
            // Gas Used ~ 500k-1M usually. Let's assume 800k for safety
            const estimatedGas = 800000n;
            const gasCostEth = estimatedGas * gasPrice;
            const gasCostAave = Number(ethers.formatEther(gasCostEth)) / aaveEthPrice;

            const netProfitAave = parseFloat(profitAave) - gasCostAave;
            const netProfitUsd = netProfitAave * aaveEthPrice * ethUsdPrice;

            if (netProfitUsd > 0) {
                console.log(`\nFound Opportunity! [${stratName}] Size: ${ethers.formatEther(amount)} AAVE`);
                console.log(`  Raw Profit: ${profitAave} AAVE`);
                console.log(`  Gas Cost:   ${gasCostAave.toFixed(4)} AAVE ($${(gasCostAave * aaveEthPrice * ethUsdPrice).toFixed(2)})`);
                console.log(`  Net Profit: ${netProfitAave.toFixed(4)} AAVE ($${netProfitUsd.toFixed(2)})`);

                if (netProfitUsd > CONFIG.minNetProfitUsd) {
                    executeTrade(contract, amount, direction, result.profit);
                }
            }
        }
    } catch (e) {
        // Reverts mean negative profit usually, ignore
        // console.log(e.message);
    }
}

async function executeTrade(contract, amount, direction, estimatedProfit) {
    if (!CONFIG.EXECUTE) {
        console.log("  ⚠️ Execution disabled in config");
        return;
    }

    console.log("🚀 EXECUTING TRADE...");
    try {
        // Set minProfit to 95% of estimated to avoid slight slippage reverts
        const minProfit = (estimatedProfit * 95n) / 100n;

        const tx = await contract.executeArbitrage(
            CONFIG.proposal,
            amount,
            direction,
            minProfit,
            { gasLimit: 5000000 }
        );

        console.log(`  Hash: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`  ✅ Transaction Confirmed! Block: ${receipt.blockNumber}`);
    } catch (e) {
        console.log(`  ❌ Execution Failed: ${e.message.slice(0, 100)}`);
    }
}

main().catch(console.error);
