/**
 * 🤖 Automated Arbitrage Monitoring & Execution Bot
 * 
 * Strategy: Multi-amount scanning for SPOT_SPLIT and MERGE_SPOT
 * Features: Gas-aware execution, JSON logging, configurable intervals.
 * 
 * Usage: CONFIRM=true npx hardhat run scripts/arb-bot-gnosis-new.js --network gnosis
 */

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
    contractAddress: "0x0ECD7369cFe4CD2f35b47B3c66e32AaC2016B25a",  // V4 PERMISSIONLESS
    proposalAddress: "0x47c80f5f701ebc5f25cab64e660f0577890729c2",  // New Gnosis GIP-149

    // Token addresses
    tokens: {
        GNO: "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb",
        SDAI: "0xaf204776c7245bF4147c2612BF6e5972Ee483701"
    },

    // Scan Settings
    scanIntervalMs: 10000, // 30 seconds
    maxGnoAmount: 2.0,      // Max GNO to borrow
    maxSdaiAmount: 500,     // Max sDAI to borrow

    // Profit Thresholds
    minNetProfitGno: "0.00001", // Execute if Net Profit > 0.00001 GNO
    minNetProfitSdai: "0.00001",  // Execute if Net Profit > 0.00001 sDAI

    // Gas Estimation (Average gas for these complex txs)
    // Gas Estimation (Average gas for these complex txs)
    estimatedGasLimit: 3500000, // Increased to 3.5M to prevent Out of Gas

    // Logging
    logFile: path.join(__dirname, "../logs/arbitrage-bot-gnosis-new.json")
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
    const contract = await ethers.getContractAt("GnosisFlashArbitrageV4", CONFIG.contractAddress, signer);

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

    console.log("   📊 Testing SPOT_SPLIT (GNO)...");
    for (let i = 0; i < gnoAmounts.length; i++) {
        const amt = gnoAmounts[i];
        const arb = await simulateArbitrage(contract, CONFIG.tokens.GNO, amt, 0); // 0 = SPOT_SPLIT
        if (arb && arb.success) {
            const netProfit = calculateNetProfit(arb.profit, gasPrice.gasPrice, gnoSdaiPrice);
            console.log(`      ✅ GNO ${amt}: profit=${arb.profit.toFixed(6)} GNO, net=${netProfit.toFixed(6)} GNO`);
            if (!bestArb || netProfit > bestArb.netProfit) {
                bestArb = { ...arb, netProfit, strategy: "SPOT_SPLIT", borrowToken: "GNO", profitUnit: "GNO" };
            }
        } else if (arb && arb.error) {
            console.log(`      ❌ GNO ${amt}: ${arb.error}`);
            // Early exit: larger amounts will also fail
            const skipped = gnoAmounts.length - i - 1;
            if (skipped > 0) console.log(`      ⏭️  Skipping ${skipped} larger amounts`);
            break;
        } else {
            console.log(`      ⚪ GNO ${amt}: no profit`);
        }
    }

    // Multi-amount test for sDAI (MERGE_SPOT)
    const sdaiAmounts = ["0.1", "0.5", "1", "2", "5", "10", "50", "100", "200", "500"];
    let bestSdaiArb = null;

    console.log("   📊 Testing MERGE_SPOT (sDAI)...");
    for (let i = 0; i < sdaiAmounts.length; i++) {
        const amt = sdaiAmounts[i];
        const arb = await simulateArbitrage(contract, CONFIG.tokens.SDAI, amt, 1); // 1 = MERGE_SPOT
        if (arb && arb.success) {
            // sDAI profit stays in sDAI units
            const gasCostSdai = calculateGasCostInSdai(gasPrice.gasPrice, gnoSdaiPrice);
            const netProfitSdai = arb.profit - gasCostSdai;
            console.log(`      ✅ sDAI ${amt}: profit=${arb.profit.toFixed(4)} sDAI, gas≈${gasCostSdai.toFixed(4)} sDAI, net=${netProfitSdai.toFixed(4)} sDAI`);
            if (!bestSdaiArb || netProfitSdai > bestSdaiArb.netProfitSdai) {
                bestSdaiArb = { ...arb, netProfitSdai, strategy: "MERGE_SPOT", borrowToken: "SDAI", profitUnit: "sDAI" };
            }
        } else if (arb && arb.error) {
            console.log(`      ❌ sDAI ${amt}: ${arb.error}`);
            // Early exit: larger amounts will also fail
            const skipped = sdaiAmounts.length - i - 1;
            if (skipped > 0) console.log(`      ⏭️  Skipping ${skipped} larger amounts`);
            break;
        } else {
            console.log(`      ⚪ sDAI ${amt}: no profit`);
        }
    }

    // Report and Execute - check BOTH strategies
    console.log("\n   📋 SUMMARY:");

    // Check GNO strategy
    if (bestArb && bestArb.netProfit > parseFloat(CONFIG.minNetProfitGno)) {
        console.log(`   🎯 GNO TARGET: ${bestArb.amount} GNO → net ${bestArb.netProfit.toFixed(6)} GNO ✓`);
    } else if (bestArb) {
        console.log(`   ⚪ GNO best: ${bestArb.netProfit.toFixed(6)} GNO (threshold: ${CONFIG.minNetProfitGno})`);
    } else {
        console.log(`   ⚪ GNO: no profitable opportunities`);
    }

    // Check sDAI strategy
    if (bestSdaiArb && bestSdaiArb.netProfitSdai > parseFloat(CONFIG.minNetProfitSdai)) {
        console.log(`   🎯 sDAI TARGET: ${bestSdaiArb.amount} sDAI → net ${bestSdaiArb.netProfitSdai.toFixed(4)} sDAI ✓`);
    } else if (bestSdaiArb) {
        console.log(`   ⚪ sDAI best: ${bestSdaiArb.netProfitSdai.toFixed(4)} sDAI (threshold: ${CONFIG.minNetProfitSdai})`);
    } else {
        console.log(`   ⚪ sDAI: no profitable opportunities`);
    }

    // Execute best opportunity
    const executeGno = bestArb && bestArb.netProfit > parseFloat(CONFIG.minNetProfitGno);
    const executeSdai = bestSdaiArb && bestSdaiArb.netProfitSdai > parseFloat(CONFIG.minNetProfitSdai);

    if (executeGno || executeSdai) {
        // Pick the more profitable one (convert to common unit - GNO)
        const gnoValue = executeGno ? bestArb.netProfit : 0;
        const sdaiValueInGno = executeSdai ? bestSdaiArb.netProfitSdai / gnoSdaiPrice : 0;

        const selected = gnoValue >= sdaiValueInGno ? bestArb : bestSdaiArb;
        const unit = gnoValue >= sdaiValueInGno ? "GNO" : "sDAI";
        const netVal = gnoValue >= sdaiValueInGno ? bestArb.netProfit : bestSdaiArb.netProfitSdai;

        console.log(`\n🔥 EXECUTING: ${selected.strategy} with ${selected.amount} ${selected.borrowToken}`);
        console.log(`   Net Profit: ${netVal.toFixed(6)} ${unit}`);

        if (process.env.CONFIRM === "true") {
            await executeTrade(contract, selected);
        } else {
            console.log("   ⚠️  DRY RUN: Set CONFIRM=true to execute.");
        }
    } else {
        console.log("\n   📉 No opportunities above thresholds");
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
        // Extract short error message
        const errorMsg = e.message?.includes("reverted") ? "reverted" :
            e.message?.includes("BAD_DATA") ? "BAD_DATA" :
                e.message?.slice(0, 30) || "unknown";
        return { success: false, error: errorMsg };
    }
}

function calculateNetProfit(grossProfitGno, gasPriceWei, gnoPriceSdai) {
    const gasCostWei = gasPriceWei * BigInt(CONFIG.estimatedGasLimit);
    const gasCostGno = parseFloat(ethers.formatEther(gasCostWei));
    return grossProfitGno - gasCostGno;
}

function calculateGasCostInSdai(gasPriceWei, gnoPriceSdai) {
    const gasCostWei = gasPriceWei * BigInt(CONFIG.estimatedGasLimit);
    const gasCostGno = parseFloat(ethers.formatEther(gasCostWei));
    return gasCostGno * gnoPriceSdai; // Convert GNO gas cost to sDAI
}

async function executeTrade(contract, arb) {
    console.log("\n🔥 EXECUTING ACTUAL TRADE...");
    try {
        const tx = await contract.executeArbitrage(
            CONFIG.proposalAddress,
            arb.borrowToken === "GNO" ? CONFIG.tokens.GNO : CONFIG.tokens.SDAI,
            ethers.parseEther(arb.amount),
            arb.strategy === "SPOT_SPLIT" ? 0 : 1,
            0, // minProfit = 0 (same as simulation)
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
