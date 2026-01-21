/**
 * 🤖 Automated Arbitrage Monitoring & Execution Bot
 * 
 * Strategy: Multi-amount scanning for SPOT_SPLIT and MERGE_SPOT
 * Features: Gas-aware execution, JSON logging, configurable intervals.
 * 
 * Usage: $env:CONFIRM="true"; npx hardhat run scripts/arb-bot.js --network gnosis
 */

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
    contractAddress: "0xe0545480aAB67Bc855806b1f64486F5c77F08eCC",
    proposalAddress: "0x45e1064348fD8A407D6D1F59Fc64B05F633b28FC",

    // Token addresses
    tokens: {
        GNO: "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb",
        SDAI: "0xaf204776c7245bF4147c2612BF6e5972Ee483701"
    },

    // Scan Settings
    scanIntervalMs: 10000, // 30 seconds
    maxGnoAmount: 2.0,      // Max GNO to borrow
    maxSdaiAmount: 500,     // Max sDAI to borrow

    // Profit Thresholds (GNO equivalents)
    minNetProfitGno: "0.00001", // Execute if Net Profit > 0.00001 GNO

    // Gas Estimation (Average gas for these complex txs)
    // Gas Estimation (Average gas for these complex txs)
    estimatedGasLimit: 3500000, // Increased to 3.5M to prevent Out of Gas

    // Logging
    logFile: path.join(__dirname, "../logs/arbitrage-bot.json")
};

// Stateless cumulative profit tracker (for console output)
let sessionTotalProfit = 0;

// ═══════════════════════════════════════════════════════════════════════════
// BOT LOGIC
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
    console.log("\n🤖 ARBITRAGE BOT STARTED");
    console.log("=".repeat(60));

    const [signer] = await ethers.getSigners();
    const contract = await ethers.getContractAt("GnosisFlashArbitrageV3", CONFIG.contractAddress, signer);

    // Create logs directory if it doesn't exist
    const logsDir = path.dirname(CONFIG.logFile);
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir);
    }

    console.log(`👤 Signer: ${signer.address}`);
    console.log(`📊 Monitoring interval: ${CONFIG.scanIntervalMs / 1000}s`);
    console.log(`📝 Log file: ${CONFIG.logFile}`);

    while (true) {
        try {
            await runScanCycle(contract, signer);
        } catch (error) {
            console.error("\n❌ Error in scan cycle:", error.message);
        }

        console.log(`\n⏳ Waiting ${CONFIG.scanIntervalMs / 1000}s for next scan...`);
        await new Promise(resolve => setTimeout(resolve, CONFIG.scanIntervalMs));
    }
}

async function runScanCycle(contract, signer) {
    const timestamp = new Date().toISOString();
    console.log(`\n🔍 SCAN START: ${timestamp}`);

    const gasPrice = await ethers.provider.getFeeData();
    const gasPriceGwei = ethers.formatUnits(gasPrice.gasPrice, "gwei");
    console.log(`⛽ Gas Price: ${parseFloat(gasPriceGwei).toFixed(2)} Gwei`);

    // GNO price for gas estimation conversion (approximate)
    const gnoSdaiPrice = await getGnoPrice();

    // Multi-amount test for GNO (SPOT_SPLIT)
    // Updated based on successful check-opportunities (0.01 - 0.5 range)
    const gnoAmounts = ["0.01", "0.05", "0.1", "0.2", "0.5"];
    let bestArb = null;

    for (const amt of gnoAmounts) {
        const arb = await simulateArbitrage(contract, CONFIG.tokens.GNO, amt, 0); // 0 = SPOT_SPLIT
        if (arb && arb.success) {
            const netProfit = calculateNetProfit(arb.profit, gasPrice.gasPrice, gnoSdaiPrice);
            if (!bestArb || netProfit > bestArb.netProfit) {
                bestArb = { ...arb, netProfit, strategy: "SPOT_SPLIT", borrowToken: "GNO" };
            }
        }
    }

    // Report and Execute
    if (bestArb && bestArb.netProfit > parseFloat(CONFIG.minNetProfitGno)) {
        console.log(`\n🎯 TARGET FOUND: ${bestArb.strategy} with ${bestArb.amount} ${bestArb.borrowToken}`);
        console.log(`   Internal Profit: ${bestArb.profit.toFixed(6)} GNO`);
        console.log(`   Est. Gas Cost:   ${(bestArb.profit - bestArb.netProfit).toFixed(6)} GNO`);
        console.log(`   Net Profit:      ${bestArb.netProfit.toFixed(6)} GNO (Gas-Adjusted)`);

        if (process.env.CONFIRM === "true") {
            await executeTrade(contract, bestArb);
        } else {
            console.log("   ⚠️  DRY RUN: Execution skipped. Set CONFIRM=true to automate.");
        }
    } else {
        console.log("   📉 No targets above threshhold (Min Net: " + CONFIG.minNetProfitGno + " GNO)");
        if (bestArb) console.log(`      Best found: ${bestArb.netProfit.toFixed(6)} GNO net`);
    }

    console.log(`\n💰 SESSION TOTAL: ${sessionTotalProfit.toFixed(6)} GNO`);

    // Log the scan result
    logEvent({
        type: "scan",
        timestamp,
        gasPrice: gasPriceGwei,
        bestOpportunity: bestArb ? {
            strategy: bestArb.strategy,
            amount: bestArb.amount,
            profit: bestArb.profit,
            netProfit: bestArb.netProfit
        } : null
    });
}

async function simulateArbitrage(contract, token, amountStr, direction) {
    const amount = ethers.parseEther(amountStr);
    try {
        const result = await contract.executeArbitrage.staticCall(
            CONFIG.proposalAddress,
            token,
            amount,
            direction,
            0 // minProfit = 0 for simulation
        );
        return {
            success: true,
            amount: amountStr,
            profit: parseFloat(ethers.formatEther(result.profit))
        };
    } catch (e) {
        return { success: false };
    }
}

function calculateNetProfit(grossProfit, gasPriceWei, gnoPriceSdai) {
    const gasCostWei = gasPriceWei * BigInt(CONFIG.estimatedGasLimit);
    const gasCostGno = parseFloat(ethers.formatEther(gasCostWei));
    return grossProfit - gasCostGno;
}

async function executeTrade(contract, arb) {
    console.log("\n🔥 EXECUTING ACTUAL TRADE...");
    try {
        const tx = await contract.executeArbitrage(
            CONFIG.proposalAddress,
            arb.borrowToken === "GNO" ? CONFIG.tokens.GNO : CONFIG.tokens.SDAI,
            ethers.parseEther(arb.amount),
            arb.strategy === "SPOT_SPLIT" ? 0 : 1,
            ethers.parseEther((arb.profit * 0.9).toFixed(6)), // 90% min profit safety
            { gasLimit: CONFIG.estimatedGasLimit }
        );

        console.log(`📝 TX Published: ${tx.hash}`);
        const receipt = await tx.wait();

        console.log(`✅ TRADE MINED! Status: ${receipt.status === 1 ? "SUCCESS" : "FAIL"}`);

        if (receipt.status === 1) {
            sessionTotalProfit += arb.profit;
        }

        logEvent({
            type: "trade",
            timestamp: new Date().toISOString(),
            txHash: tx.hash,
            status: receipt.status === 1 ? "success" : "failed",
            profit: arb.profit,
            gasUsed: receipt.gasUsed.toString(),
            strategy: arb.strategy,
            amount: arb.amount,
            sessionTotal: sessionTotalProfit
        });
    } catch (error) {
        console.error("❌ Execution Error:", error.message);
    }
}

// Simple GNO price fetch (approximate from Balancer V3 spot calculation logic)
async function getGnoPrice() {
    // For simplicity, we assume ~112 sDAI/GNO for gas conversion if oracle fails
    return 112.0;
}

function logEvent(event) {
    const data = JSON.stringify(event) + "\n";
    fs.appendFileSync(CONFIG.logFile, data);
}

main().then(() => process.exit(0)).catch(console.error);
