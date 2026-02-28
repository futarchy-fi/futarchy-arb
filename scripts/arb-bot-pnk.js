/**
 * Automated Arbitrage Bot for PNK/sDAI Futarchy Markets (KIP-86)
 *
 * Always borrows WETH from Balancer V3. Tests both SPOT_SPLIT and MERGE_SPOT.
 * Route: WETH ↔ PNK (DXswap) and WETH ↔ WXDAI (Honeyswap) ↔ sDAI (ERC4626).
 *
 * Usage: CONFIRM=true npx hardhat run scripts/arb-bot-pnk.js --network gnosis
 */

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
    // Contract address — update after deployment
    contractAddress: process.env.PNK_ARB_CONTRACT || "",
    proposalAddress: "0xb607bd7c7201e966e6a150cd6ef1d08db55cad5d",  // KIP-86

    // Token addresses (for reference / gas conversion)
    tokens: {
        WETH: "0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1",
    },

    // Scan settings
    scanIntervalMs: 15000,  // 15 seconds

    // Test amounts in WETH (ascending — early exit on failure)
    wethAmounts: ["0.01", "0.05", "0.1", "0.2", "0.5"],

    // Minimum net profit in WETH to execute
    minNetProfitWeth: "0.0001",

    // Gas estimation
    estimatedGasLimit: 4000000,

    // Logging
    logFile: path.join(__dirname, "../logs/arb-bot-pnk.json"),
};

let sessionTotalProfit = 0;

// ═══════════════════════════════════════════════════════════════════════════
// BOT LOGIC
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
    if (!CONFIG.contractAddress) {
        // Try reading from last_deployment_pnk.txt
        const depFile = path.join(__dirname, "../last_deployment_pnk.txt");
        if (fs.existsSync(depFile)) {
            CONFIG.contractAddress = fs.readFileSync(depFile, "utf8").trim();
        } else {
            console.error("Set PNK_ARB_CONTRACT env var or deploy first (last_deployment_pnk.txt)");
            process.exit(1);
        }
    }

    console.log("\nPNK ARB BOT STARTED");
    console.log("=".repeat(60));

    const [signer] = await ethers.getSigners();
    const contract = await ethers.getContractAt("PNKFlashArbitrage", CONFIG.contractAddress, signer);

    const logsDir = path.dirname(CONFIG.logFile);
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

    console.log(`Signer:   ${signer.address}`);
    console.log(`Contract: ${CONFIG.contractAddress}`);
    console.log(`Proposal: ${CONFIG.proposalAddress}`);
    console.log(`Interval: ${CONFIG.scanIntervalMs / 1000}s`);
    console.log(`Log:      ${CONFIG.logFile}`);

    // Verify proposal loads correctly
    try {
        const info = await contract.loadProposal(CONFIG.proposalAddress);
        if (!info.isValid) {
            console.error("Proposal is not valid for PNK/sDAI arbitrage");
            process.exit(1);
        }
        console.log(`\nProposal loaded:`);
        console.log(`  YES pool: ${info.yesPool}`);
        console.log(`  NO pool:  ${info.noPool}`);
    } catch (e) {
        console.error("Failed to load proposal:", e.message);
        process.exit(1);
    }

    while (true) {
        try {
            await runScanCycle(contract, signer);
        } catch (error) {
            console.error("\nError in scan cycle:", error.message);
        }
        console.log(`\nWaiting ${CONFIG.scanIntervalMs / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, CONFIG.scanIntervalMs));
    }
}

async function runScanCycle(contract, signer) {
    const timestamp = new Date().toISOString();
    console.log(`\nSCAN: ${timestamp}`);

    const feeData = await ethers.provider.getFeeData();
    const gasPriceGwei = ethers.formatUnits(feeData.gasPrice, "gwei");
    console.log(`Gas: ${parseFloat(gasPriceGwei).toFixed(2)} Gwei`);

    // Gas cost in WETH (on Gnosis, gas is paid in xDAI; approximate conversion)
    const gasCostXdai = parseFloat(ethers.formatEther(feeData.gasPrice * BigInt(CONFIG.estimatedGasLimit)));
    // Rough xDAI/WETH price (~1900 xDAI per WETH)
    const xdaiPerWeth = 1900;
    const gasCostWeth = gasCostXdai / xdaiPerWeth;

    let bestSpotSplit = null;
    let bestMergeSpot = null;

    // Test SPOT_SPLIT
    console.log("  Testing SPOT_SPLIT...");
    for (let i = 0; i < CONFIG.wethAmounts.length; i++) {
        const amt = CONFIG.wethAmounts[i];
        const arb = await simulateArbitrage(contract, amt, 0);
        if (arb && arb.success) {
            const net = arb.profit - gasCostWeth;
            console.log(`    WETH ${amt}: profit=${arb.profit.toFixed(6)}, gas~${gasCostWeth.toFixed(6)}, net=${net.toFixed(6)}`);
            if (!bestSpotSplit || net > bestSpotSplit.net) {
                bestSpotSplit = { ...arb, net, strategy: "SPOT_SPLIT" };
            }
        } else if (arb && arb.error) {
            console.log(`    WETH ${amt}: ${arb.error}`);
            const skipped = CONFIG.wethAmounts.length - i - 1;
            if (skipped > 0) console.log(`    Skipping ${skipped} larger amounts`);
            break;
        } else {
            console.log(`    WETH ${amt}: no profit`);
        }
    }

    // Test MERGE_SPOT
    console.log("  Testing MERGE_SPOT...");
    for (let i = 0; i < CONFIG.wethAmounts.length; i++) {
        const amt = CONFIG.wethAmounts[i];
        const arb = await simulateArbitrage(contract, amt, 1);
        if (arb && arb.success) {
            const net = arb.profit - gasCostWeth;
            console.log(`    WETH ${amt}: profit=${arb.profit.toFixed(6)}, gas~${gasCostWeth.toFixed(6)}, net=${net.toFixed(6)}`);
            if (!bestMergeSpot || net > bestMergeSpot.net) {
                bestMergeSpot = { ...arb, net, strategy: "MERGE_SPOT" };
            }
        } else if (arb && arb.error) {
            console.log(`    WETH ${amt}: ${arb.error}`);
            const skipped = CONFIG.wethAmounts.length - i - 1;
            if (skipped > 0) console.log(`    Skipping ${skipped} larger amounts`);
            break;
        } else {
            console.log(`    WETH ${amt}: no profit`);
        }
    }

    // Determine best opportunity
    console.log("\n  SUMMARY:");
    const threshold = parseFloat(CONFIG.minNetProfitWeth);

    const candidates = [bestSpotSplit, bestMergeSpot].filter(a => a && a.net > threshold);
    if (candidates.length === 0) {
        if (bestSpotSplit) console.log(`  SPOT_SPLIT best: net ${bestSpotSplit.net.toFixed(6)} WETH`);
        if (bestMergeSpot) console.log(`  MERGE_SPOT best: net ${bestMergeSpot.net.toFixed(6)} WETH`);
        console.log("  No opportunities above threshold");
        logEvent({ type: "scan", timestamp, gasPrice: gasPriceGwei, best: null });
        return;
    }

    // Pick highest net profit
    candidates.sort((a, b) => b.net - a.net);
    const selected = candidates[0];

    console.log(`  TARGET: ${selected.strategy} ${selected.amount} WETH -> net ${selected.net.toFixed(6)} WETH`);

    if (process.env.CONFIRM === "true") {
        await executeTrade(contract, selected);
    } else {
        console.log("  DRY RUN: Set CONFIRM=true to execute.");
    }

    console.log(`\nSESSION TOTAL: ${sessionTotalProfit.toFixed(6)} WETH`);
    logEvent({
        type: "scan",
        timestamp,
        gasPrice: gasPriceGwei,
        best: { strategy: selected.strategy, amount: selected.amount, net: selected.net },
    });
}

async function simulateArbitrage(contract, amountStr, direction) {
    const amount = ethers.parseEther(amountStr);
    try {
        const result = await contract.executeArbitrage.staticCall(
            CONFIG.proposalAddress,
            amount,
            direction,
            0  // minProfit = 0 for simulation
        );
        return {
            success: true,
            amount: amountStr,
            profit: parseFloat(ethers.formatEther(result.profit)),
        };
    } catch (e) {
        const errorMsg = e.message?.includes("reverted") ? "reverted"
            : e.message?.includes("BAD_DATA") ? "BAD_DATA"
            : e.message?.slice(0, 60) || "unknown";
        return { success: false, error: errorMsg };
    }
}

async function executeTrade(contract, arb) {
    console.log("\n  EXECUTING TRADE...");
    try {
        const direction = arb.strategy === "SPOT_SPLIT" ? 0 : 1;
        const tx = await contract.executeArbitrage(
            CONFIG.proposalAddress,
            ethers.parseEther(arb.amount),
            direction,
            0,
            { gasLimit: CONFIG.estimatedGasLimit }
        );

        console.log(`  TX: ${tx.hash}`);
        const receipt = await tx.wait();
        const status = receipt.status === 1 ? "SUCCESS" : "FAIL";
        console.log(`  Mined: ${status}, gas used: ${receipt.gasUsed.toString()}`);

        if (receipt.status === 1) {
            sessionTotalProfit += arb.profit;
        }

        logEvent({
            type: "trade",
            timestamp: new Date().toISOString(),
            txHash: tx.hash,
            status: status.toLowerCase(),
            profit: arb.profit,
            gasUsed: receipt.gasUsed.toString(),
            strategy: arb.strategy,
            amount: arb.amount,
            sessionTotal: sessionTotalProfit,
        });
    } catch (error) {
        console.error("  Execution error:", error.message);
        logEvent({
            type: "trade_error",
            timestamp: new Date().toISOString(),
            error: error.message?.slice(0, 200),
            strategy: arb.strategy,
            amount: arb.amount,
        });
    }
}

function logEvent(event) {
    fs.appendFileSync(CONFIG.logFile, JSON.stringify(event) + "\n");
}

main().then(() => process.exit(0)).catch(console.error);
