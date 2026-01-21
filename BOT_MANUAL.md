# 🤖 Gnosis Arbitrage Bot - Manual

This guide covers how to run, monitor, and optimize your automated arbitrage bot.

## 🚀 Persistent Running (Persistence)

Running a bot in a terminal is fine for testing, but for production, you want it to restart automatically if it crashes or if the server reboots.

### Option 1: PM2 (Recommended)
PM2 is the industry standard for running Node.js processes in the background. It handles restarts automatically.

**1. Install PM2:**
```bash
npm install -g pm2
```

**2. Start the Bot:**
```bash
# Windows (PowerShell)
$env:CONFIRM="true"; pm2 start scripts/arb-bot.js --name "gnosis-arb" -- --network gnosis
```

**3. Manage:** `pm2 logs gnosis-arb` / `pm2 status`

---

### Option 2: Pure PowerShell (Simple "Keep-Alive" Mode)
If you don't want to install PM2, you can use this PowerShell loop. It will restart the bot automatically if it crashes or stops.

**Run this in your terminal:**
```powershell
# This loop will keep the bot running even if it errors out
while ($true) {
    echo "--- Starting Bot ---"
    $env:CONFIRM="true"
    npx hardhat run scripts/arb-bot.js --network gnosis
    echo "--- Bot stopped. Restarting in 5 seconds... ---"
    Start-Sleep -Seconds 5
}
```

---

## 📈 Monitoring & Persistent Logs

The bot uses a **persistent logging system**. Every activity is appended to `logs/arbitrage-bot.json` in real-time. This file is never cleared by the bot, allowing you to track historical performance.

### 1. Cumulative Profit Report
The `profit-report.js` script reads the entire history of the JSON log:
```bash
npx hardhat run scripts/profit-report.js
```
- **Session Total**: Shown in the bot console (profit since bot start).
- **Life-time Total**: Shown by the profit report script (profit across all bot restarts).

### 2. Live Log Streaming
To watch the JSON log in real-time (Linux/Mac/Git Bash):
```bash
tail -f logs/arbitrage-bot.json
```

---

## 🛠️ Configuration Tuning (`scripts/arb-bot.js`)

You can adjust these settings in the `CONFIG` object:

| Setting | Description | Recommended |
|---------|-------------|-------------|
| `scanIntervalMs` | Time between scans | `30000` (30s) |
| `minNetProfitGno` | Minimum profit after gas to execute | `0.001` GNO |
| `estimatedGasLimit` | Gas buffer for transactions | `2500000` |
| `maxGnoAmount` | Max flash loan size | `2.0` - `5.0` |

---

## 📑 Log Format Reference

The bot uses a line-delimited JSON format for easy parsing:

**Scan Event:**
```json
{"type":"scan","timestamp":"...","gasPrice":"2.50","bestOpportunity":{...}}
```

**Trade Event:**
```json
{"type":"trade","timestamp":"...","txHash":"0x...","status":"success","profit":0.008,"sessionTotal":0.15}
```

---

## ⚠️ Troubleshooting

- **"Insufficient to repay"**: The arbitrage didn't cover the loan. Check if prices moved or if gas was higher than expected.
- **"Profit below minimum"**: The bot found a target but the final execution profit was lower than your safety buffer.
- **"Already known"**: The transaction was sent twice. The bot handles this by waiting for the next cycle.
