/**
 * 🤖 AAVE/GHO Arbitrage Bot (Ethereum Mainnet)
 * 
 * Contract: AaveFlashArbitrageV1
 * Strategies: SPOT_SPLIT (Borrow → Split → Sell) and MERGE_SPOT
 * Features: Gas-aware execution, JSON logging, staticCall simulation
 * 
 * Usage: node scripts/arb-bot-aave.js
 * Execute: CONFIRM=true node scripts/arb-bot-aave.js
 */

const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
    rpcUrl: process.env.RPC_URL || "https://ethereum.publicnode.com",
    contractAddress: "0x098321F3f0d20dD4fc9559267a9B1c88AaDd2876",  // AaveFlashArbitrageV2
    proposalAddress: "0xFb45aE9d8e5874e85b8e23D735EB9718EfEF47Fa",

    // Token addresses (Mainnet)
    tokens: {
        AAVE: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
        GHO: "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f"
    },

    // Scan Settings
    scanIntervalMs: 30000, // 30 seconds

    // Profit Thresholds (in token units)
    minNetProfitAave: "0.0001",  // Execute if Net Profit > 0.0001 AAVE
    minNetProfitGho: "0.01",     // Execute if Net Profit > 0.01 GHO

    // Gas Estimation
    estimatedGasLimit: 3500000,

    // Logging
    logFile: path.join(__dirname, "../logs/arb-bot-aave.json")
};

// Contract ABI (minimal for bot usage)
const CONTRACT_ABI = [
    "function executeArbitrage(address proposalAddress, address borrowToken, uint256 borrowAmount, uint8 direction, uint256 minProfit) external returns (tuple(bool success, uint256 profit, uint256 borrowAmount) result)",
    "function AAVE() view returns (address)",
    "function GHO() view returns (address)"
];

// Stateless cumulative profit tracker
let sessionTotalProfit = 0;

// ═══════════════════════════════════════════════════════════════════════════
// BOT LOGIC
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
    console.log("\n🤖 AAVE/GHO ARBITRAGE BOT STARTED (Ethereum Mainnet)");
    console.log("═".repeat(60));

    const provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);

    // Check if wallet is available (uses PRIVATE_KEY_AAVE for Mainnet bot)
    let signer = null;
    if (process.env.PRIVATE_KEY_AAVE) {
        signer = new ethers.Wallet(process.env.PRIVATE_KEY_AAVE, provider);
        console.log(`👤 Wallet: ${signer.address}`);
        const balance = await provider.getBalance(signer.address);
        console.log(`💰 Balance: ${ethers.formatEther(balance)} ETH`);
    } else {
        console.log("⚠️  No PRIVATE_KEY - Running in READ-ONLY mode");
    }

    const contract = new ethers.Contract(CONFIG.contractAddress, CONTRACT_ABI, signer || provider);

    // Create logs directory if it doesn't exist
    const logsDir = path.dirname(CONFIG.logFile);
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
    }

    console.log(`📊 Contract: ${CONFIG.contractAddress}`);
    console.log(`📊 Proposal: ${CONFIG.proposalAddress}`);
    console.log(`📊 Monitoring interval: ${CONFIG.scanIntervalMs / 1000}s`);
    console.log(`📝 Log file: ${CONFIG.logFile}`);

    while (true) {
        try {
            await runScanCycle(contract, signer, provider);
        } catch (error) {
            console.error("\n❌ Error in scan cycle:", error.message);
        }

        console.log(`\n⏳ Waiting ${CONFIG.scanIntervalMs / 1000}s for next scan...`);
        await new Promise(resolve => setTimeout(resolve, CONFIG.scanIntervalMs));
    }
}

async function runScanCycle(contract, signer, provider) {
    const timestamp = new Date().toISOString();
    console.log(`\n🔍 SCAN START: ${timestamp}`);

    const feeData = await provider.getFeeData();
    const gasPriceGwei = ethers.formatUnits(feeData.gasPrice, "gwei");
    console.log(`⛽ Gas Price: ${parseFloat(gasPriceGwei).toFixed(2)} Gwei`);

    // Approximate ETH price for gas cost calculation
    const ethPriceUsd = 3300;
    const aavePriceUsd = 250;  // Approximate
    const ghoPriceUsd = 1;     // Stablecoin

    // Calculate gas cost in tokens
    const gasCostWei = feeData.gasPrice * BigInt(CONFIG.estimatedGasLimit);
    const gasCostEth = parseFloat(ethers.formatEther(gasCostWei));
    const gasCostUsd = gasCostEth * ethPriceUsd;
    const gasCostAave = gasCostUsd / aavePriceUsd;
    const gasCostGho = gasCostUsd;

    console.log(`   Gas Cost: ~$${gasCostUsd.toFixed(2)} (~${gasCostAave.toFixed(6)} AAVE / ~${gasCostGho.toFixed(2)} GHO)`);

    // Test amounts for AAVE (SPOT_SPLIT) - SMALL for low slippage
    const aaveAmounts = ["0.001", "0.002", "0.005", "0.01", "0.02"];
    let bestAaveArb = null;

    console.log("\n   📊 Testing SPOT_SPLIT (Borrow AAVE)...");
    for (let i = 0; i < aaveAmounts.length; i++) {
        const amt = aaveAmounts[i];
        const arb = await simulateArbitrage(contract, CONFIG.tokens.AAVE, amt, 0, provider);
        if (arb && arb.success) {
            const netProfit = arb.profit - gasCostAave;
            console.log(`      ✅ AAVE ${amt}: profit=${arb.profit.toFixed(6)} AAVE, net=${netProfit.toFixed(6)} AAVE`);
            if (!bestAaveArb || netProfit > bestAaveArb.netProfit) {
                bestAaveArb = { ...arb, netProfit, strategy: "SPOT_SPLIT", borrowToken: "AAVE", profitUnit: "AAVE" };
            }
        } else if (arb && arb.error) {
            console.log(`      ❌ AAVE ${amt}: ${arb.error}`);
            break; // Early exit
        } else {
            console.log(`      ⚪ AAVE ${amt}: no profit`);
        }
    }

    // Test amounts for GHO (MERGE_SPOT) - SMALL for low slippage
    const ghoAmounts = ["0.5", "1", "2", "5", "10"];
    let bestGhoArb = null;

    console.log("\n   📊 Testing MERGE_SPOT (Borrow GHO)...");
    for (let i = 0; i < ghoAmounts.length; i++) {
        const amt = ghoAmounts[i];
        const arb = await simulateArbitrage(contract, CONFIG.tokens.GHO, amt, 1, provider);
        if (arb && arb.success) {
            const netProfit = arb.profit - gasCostGho;
            console.log(`      ✅ GHO ${amt}: profit=${arb.profit.toFixed(4)} GHO, net=${netProfit.toFixed(4)} GHO`);
            if (!bestGhoArb || netProfit > bestGhoArb.netProfit) {
                bestGhoArb = { ...arb, netProfit, strategy: "MERGE_SPOT", borrowToken: "GHO", profitUnit: "GHO" };
            }
        } else if (arb && arb.error) {
            console.log(`      ❌ GHO ${amt}: ${arb.error}`);
            break; // Early exit
        } else {
            console.log(`      ⚪ GHO ${amt}: no profit`);
        }
    }

    // Report and Execute
    console.log("\n   📋 SUMMARY:");

    // Check AAVE strategy
    if (bestAaveArb && bestAaveArb.netProfit > parseFloat(CONFIG.minNetProfitAave)) {
        console.log(`   🎯 AAVE TARGET: ${bestAaveArb.amount} AAVE → net ${bestAaveArb.netProfit.toFixed(6)} AAVE ✓`);
    } else if (bestAaveArb) {
        console.log(`   ⚪ AAVE best: ${bestAaveArb.netProfit.toFixed(6)} AAVE (threshold: ${CONFIG.minNetProfitAave})`);
    } else {
        console.log(`   ⚪ AAVE: no profitable opportunities`);
    }

    // Check GHO strategy
    if (bestGhoArb && bestGhoArb.netProfit > parseFloat(CONFIG.minNetProfitGho)) {
        console.log(`   🎯 GHO TARGET: ${bestGhoArb.amount} GHO → net ${bestGhoArb.netProfit.toFixed(4)} GHO ✓`);
    } else if (bestGhoArb) {
        console.log(`   ⚪ GHO best: ${bestGhoArb.netProfit.toFixed(4)} GHO (threshold: ${CONFIG.minNetProfitGho})`);
    } else {
        console.log(`   ⚪ GHO: no profitable opportunities`);
    }

    // Execute best opportunity
    const executeAave = bestAaveArb && bestAaveArb.netProfit > parseFloat(CONFIG.minNetProfitAave);
    const executeGho = bestGhoArb && bestGhoArb.netProfit > parseFloat(CONFIG.minNetProfitGho);

    if ((executeAave || executeGho) && signer) {
        // Pick the one with higher USD value net profit
        const aaveValueUsd = executeAave ? bestAaveArb.netProfit * aavePriceUsd : 0;
        const ghoValueUsd = executeGho ? bestGhoArb.netProfit * ghoPriceUsd : 0;

        const selected = aaveValueUsd >= ghoValueUsd ? bestAaveArb : bestGhoArb;

        console.log(`\n🔥 EXECUTING: ${selected.strategy} with ${selected.amount} ${selected.borrowToken}`);
        console.log(`   Net Profit: ${selected.netProfit.toFixed(6)} ${selected.profitUnit}`);

        if (process.env.CONFIRM === "true") {
            await executeTrade(contract, selected, provider);
        } else {
            console.log("   ⚠️  DRY RUN: Set CONFIRM=true to execute.");
        }
    } else if (!signer && (executeAave || executeGho)) {
        console.log("\n   ⚠️  Opportunity found but no wallet configured!");
    } else {
        console.log("\n   📉 No opportunities above thresholds");
    }

    console.log(`\n💰 SESSION TOTAL: ${sessionTotalProfit.toFixed(6)} (mixed units)`);

    // Log the scan result
    logEvent({
        type: "scan",
        timestamp,
        gasPrice: gasPriceGwei,
        bestAave: bestAaveArb ? { amount: bestAaveArb.amount, netProfit: bestAaveArb.netProfit } : null,
        bestGho: bestGhoArb ? { amount: bestGhoArb.amount, netProfit: bestGhoArb.netProfit } : null
    });
}

async function simulateArbitrage(contract, token, amountStr, direction, provider) {
    const amount = ethers.parseEther(amountStr);
    try {
        // Use staticCall for simulation (read-only, no gas spent)
        const result = await contract.executeArbitrage.staticCall(
            CONFIG.proposalAddress,
            token,
            amount,
            direction,
            0 // minProfit = 0 for simulation
        );
        return {
            success: result.success,
            amount: amountStr,
            profit: parseFloat(ethers.formatEther(result.profit))
        };
    } catch (e) {
        // Extract short error message
        let errorMsg = "unknown";
        if (e.message) {
            if (e.message.includes("reverted")) errorMsg = "reverted";
            else if (e.message.includes("ArbitrageFailed")) {
                const match = e.message.match(/ArbitrageFailed\([^)]+\)/);
                errorMsg = match ? match[0].slice(0, 50) : "ArbitrageFailed";
            }
            else if (e.message.includes("Invalid")) errorMsg = "Invalid token/proposal";
            else errorMsg = e.message.slice(0, 40);
        }
        return { success: false, error: errorMsg };
    }
}

async function executeTrade(contract, arb, provider) {
    console.log("\n🔥 EXECUTING ACTUAL TRADE...");
    try {
        const tokenAddress = arb.borrowToken === "AAVE" ? CONFIG.tokens.AAVE : CONFIG.tokens.GHO;
        const tx = await contract.executeArbitrage(
            CONFIG.proposalAddress,
            tokenAddress,
            ethers.parseEther(arb.amount),
            arb.strategy === "SPOT_SPLIT" ? 0 : 1,
            ethers.parseEther((arb.profit * 0.9).toFixed(6)), // 90% min profit safety
            { gasLimit: CONFIG.estimatedGasLimit }
        );

        console.log(`📝 TX Published: ${tx.hash}`);
        console.log(`   View on Etherscan: https://etherscan.io/tx/${tx.hash}`);

        const receipt = await tx.wait();

        console.log(`✅ TRADE MINED! Status: ${receipt.status === 1 ? "SUCCESS" : "FAIL"}`);
        console.log(`   Gas Used: ${receipt.gasUsed.toString()}`);

        if (receipt.status === 1) {
            sessionTotalProfit += arb.netProfit;
        }

        logEvent({
            type: "trade",
            timestamp: new Date().toISOString(),
            txHash: tx.hash,
            status: receipt.status === 1 ? "success" : "failed",
            profit: arb.profit,
            netProfit: arb.netProfit,
            gasUsed: receipt.gasUsed.toString(),
            strategy: arb.strategy,
            amount: arb.amount,
            sessionTotal: sessionTotalProfit
        });
    } catch (error) {
        console.error("❌ Execution Error:", error.message);
        logEvent({
            type: "trade_error",
            timestamp: new Date().toISOString(),
            error: error.message,
            strategy: arb.strategy,
            amount: arb.amount
        });
    }
}

function logEvent(event) {
    try {
        const data = JSON.stringify(event) + "\n";
        fs.appendFileSync(CONFIG.logFile, data);
    } catch (e) {
        console.error("Log write error:", e.message);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// RUN
// ═══════════════════════════════════════════════════════════════════════════

main().catch(console.error);
