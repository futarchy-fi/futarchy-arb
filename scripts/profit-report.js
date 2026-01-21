/**
 * 📈 Arbitrage Profit Reporter
 * 
 * Reads the JSON log file and calculates total profits and trade stats.
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const LOG_FILE = path.join(__dirname, "../logs/arbitrage-bot.json");

function main() {
    if (!fs.existsSync(LOG_FILE)) {
        console.error("❌ Log file not found at " + LOG_FILE);
        return;
    }

    const lines = fs.readFileSync(LOG_FILE, "utf8").split("\n").filter(l => l.trim());
    const events = lines.map(line => {
        try {
            return JSON.parse(line);
        } catch (e) {
            return null;
        }
    }).filter(e => e !== null);

    const trades = events.filter(e => e.type === "trade" && e.status === "success");
    const fails = events.filter(e => e.type === "trade" && e.status === "failed");
    const scans = events.filter(e => e.type === "scan");

    console.log("\n📊 ARBITRAGE BOT PERFORMANCE REPORT");
    console.log("=".repeat(50));

    let totalProfit = 0;
    const strategyStats = {};

    trades.forEach(t => {
        totalProfit += t.profit;
        strategyStats[t.strategy] = (strategyStats[t.strategy] || 0) + t.profit;
    });

    console.log(`⏱️ Total Scans:    ${scans.length}`);
    console.log(`✅ Successful Trades: ${trades.length}`);
    console.log(`❌ Failed Trades:     ${fails.length}`);
    console.log(`💰 Total Profit:      ${totalProfit.toFixed(6)} GNO`);

    if (trades.length > 0) {
        console.log(`📈 Avg Profit/Trade:  ${(totalProfit / trades.length).toFixed(6)} GNO`);
    }

    console.log("\n🔹 Profits by Strategy:");
    Object.entries(strategyStats).forEach(([strategy, profit]) => {
        console.log(`   - ${strategy}: ${profit.toFixed(6)} GNO`);
    });

    if (trades.length > 0) {
        console.log("\n📜 Recent Successful Trades:");
        trades.slice(-5).reverse().forEach(t => {
            console.log(`   [${t.timestamp}] ${t.strategy} | ${t.amount} GNO | +${t.profit.toFixed(6)} GNO | TX: ${t.txHash.slice(0, 10)}...`);
        });
    }

    console.log("=".repeat(50) + "\n");
}

main();
