# GnosisFlashArbitrageV4 - Usage Guide

**Contract**: `0x0ECD7369cFe4CD2f35b47B3c66e32AaC2016B25a` 🔓 **PERMISSIONLESS**  
**Network**: Gnosis Chain  
**Verified**: https://gnosisscan.io/address/0x0ECD7369cFe4CD2f35b47B3c66e32AaC2016B25a#code

## The `direction` Parameter

The `direction` argument (an integer) selects the arbitrage core logic. It determines which token you borrow and whether you are "splitting" to sell or "buying" to merge.

| Value | Name | Core Logic | Market Signal |
|-------|------|------------|---------------|
| `0` | **SPOT_SPLIT** | Borrow GNO -> Split into YES/NO -> Sell both for sDAI -> Merge sDAI | Outcome prices are **HIGHER** than spot GNO price. |
| `1` | **MERGE_SPOT** | Borrow sDAI -> Split into YES/NO sDAI -> Buy outcome GNO -> Merge into GNO | Outcome prices are **LOWER** than spot GNO price. |

---

## Strategies

### 1. SPOT_SPLIT (Direction: 0) - Borrow GNO
**When profitable**: Outcome token prices > Spot GNO price

```
Flow: Borrow GNO → Split → Sell outcomes → Merge sDAI → Swap back → Repay + Profit
```

| Step | Action | Example (1 GNO) |
|------|--------|-----------------|
| 1 | Flash loan GNO | Borrow 1 GNO |
| 2 | Split GNO | Get 1 YES_GNO + 1 NO_GNO |
| 3 | Sell YES_GNO → YES_SDAI | ~115 YES_SDAI |
| 4 | Sell NO_GNO → NO_SDAI | ~115 NO_SDAI |
| 5 | Merge YES+NO sDAI | ~115 real sDAI |
| 6 | Swap sDAI → GNO | ~1.02 GNO |
| 7 | Repay flash loan | -1 GNO |
| **Result** | **Profit** | **~0.02 GNO (2%)** |

**Usage**:
```javascript
await contract.executeArbitrage(
    "0x45e1064348fD8A407D6D1F59Fc64B05F633b28FC",  // proposal
    "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb",  // GNO (borrow token)
    ethers.parseEther("1"),  // amount
    0,  // SPOT_SPLIT
    ethers.parseEther("0.01")  // min profit
);
```

---

### 2. MERGE_SPOT (Direction: 1) - Borrow sDAI
**When profitable**: Spot GNO price > Outcome token prices

```
Flow: Borrow sDAI → Split → Buy outcomes → Merge GNO → Swap back → Repay + Profit
```

| Step | Action | Example (100 sDAI) |
|------|--------|-------------------|
| 1 | Flash loan sDAI | Borrow 100 sDAI |
| 2 | Split sDAI | Get 100 YES_SDAI + 100 NO_SDAI |
| 3 | Buy YES_GNO with YES_SDAI | ~0.87 YES_GNO |
| 4 | Buy NO_GNO with NO_SDAI | ~0.87 NO_GNO |
| 5 | Merge YES+NO GNO | ~0.87 real GNO |
| 6 | Swap GNO → sDAI | ~97 sDAI |
| 7 | Repay flash loan | -100 sDAI |
| **Result** | **LOSS** | **Not profitable currently** |

**Usage**:
```javascript
await contract.executeArbitrage(
    "0x45e1064348fD8A407D6D1F59Fc64B05F633b28FC",  // proposal
    "0xaf204776c7245bF4147c2612BF6e5972Ee483701",  // sDAI (borrow token)
    ethers.parseEther("100"),  // amount
    1,  // MERGE_SPOT
    ethers.parseEther("1")  // min profit
);
```

---

## Scripts

### `check-opportunities.js` - Scan for Profit Opportunities ⭐
Comprehensive scanner that tests both strategies with static calls (no gas cost):
```bash
npx hardhat run scripts/check-opportunities.js --network gnosis
```
**Output example**:
```
┌─────────────────────────────────────────────────────────────────┐
│ STEP 1: Fetching Spot Price (Balancer V3 WAGNO/sDAI)            │
└─────────────────────────────────────────────────────────────────┘
   ✅ GNO Spot Price: 111.9108 sDAI/GNO

│ STEP 2: SPOT_SPLIT Strategy (Borrow GNO)                        │
   ✅  0.01 GNO → Profit: 0.000254 GNO (2.54%)
   ✅   0.1 GNO → Profit: 0.002440 GNO (2.44%)
   ✅     1 GNO → Profit: 0.014521 GNO (1.45%)

│ STEP 3: MERGE_SPOT Strategy (Borrow sDAI)                       │
   ❌   100 sDAI → FAILED: Insufficient to repay

   🎯 BEST OPPORTUNITY:
      Strategy:    SPOT_SPLIT
      Amount:      0.01 GNO
      Return:      2.54%
```

---

### `find-max.js` - Find Maximum Trade Size
Tests various GNO amounts to find optimal trade size:
```bash
npx hardhat run scripts/find-max.js --network gnosis
```
**Output example**:
```
✅  0.01 GNO → Profit: 0.000254 GNO (2.54%)
✅   0.1 GNO → Profit: 0.002440 GNO (2.44%)
✅   0.5 GNO → Profit: 0.009992 GNO (2.00%)
✅     1 GNO → Profit: 0.014521 GNO (1.45%)
✅     2 GNO → Profit: 0.007534 GNO (0.38%)
❌     5 GNO → FAILED: Insufficient to repay
```

### `test-sdai.js` - Test MERGE_SPOT Strategy
Tests sDAI borrow amounts:
```bash
npx hardhat run scripts/test-sdai.js --network gnosis
```

### `execute-arb.js` - Test Single Trade
Tests a specific amount with detailed result:
```bash
npx hardhat run scripts/execute-arb.js --network gnosis
```

---

## ArbitrageResult Struct

Static calls return this struct so you can preview results:

```solidity
struct ArbitrageResult {
    bool success;           // Did arbitrage succeed?
    uint256 profit;         // Profit in borrowed token
    uint256 leftoverYesGno; // Leftover YES_GNO sent to caller
    uint256 leftoverNoGno;  // Leftover NO_GNO sent to caller
    uint256 leftoverYesSdai;// Leftover YES_SDAI sent to caller
    uint256 leftoverNoSdai; // Leftover NO_SDAI sent to caller
    uint256 leftoverGno;    // Leftover real GNO
    uint256 leftoverSdai;   // Leftover real sDAI
}
```

**JavaScript usage**:
```javascript
const result = await contract.executeArbitrage.staticCall(
    proposal, borrowToken, amount, direction, minProfit
);
console.log("Profit:", ethers.formatEther(result.profit));
console.log("Leftover YES_SDAI:", ethers.formatEther(result.leftoverYesSdai));
```

---

## Simulation Accuracy Experiment (Verification)

To trust the bot with larger amounts, we conducted a "Simulation vs. Reality" experiment. This methodology allows you to confirm the bot's accuracy at any time.

### Methodology
1. **Simulation**: Run `staticCall` on a specific amount (e.g., 1.0 GNO).
2. **Execution**: Immediately send the real transaction for the same amount.
3. **Comparison**: Compare the `profit` in the simulation result with the GNO received in your wallet.

### Case Study Result (Jan 20, 2026)
| Parameter | Simulation (`staticCall`) | Real Transaction |
|-----------|---------------------------|------------------|
| **Borrow Amount** | 1.0 GNO | 1.0 GNO |
| **Expected Profit** | `0.00880815 GNO` | `0.00880814 GNO` |
| **Accuracy** | N/A | **99.999%** |

### How to Verify Yourself:
1. Run `npx hardhat run scripts/execute-arb.js --network gnosis` (Simulation).
2. Note the `Profit (GNO)` value.
3. Run `npx hardhat run scripts/real-execute.js --network gnosis` (Execution).
4. Check [Gnosisscan](https://gnosisscan.io/) for your address and compare the "GNO" Transfer amount with Step 2.

> [!TIP]
> Higher volatility or larger trade sizes (above 2 GNO) may increase the variance between simulation and reality due to pool slippage and concurrent trades in the same block.

---

## Practical "Scan & Execute" Workflow ⭐

This is the recommended 2-step process used during development:

### Step 1: Scan for Opportunities
Run the scanner to see what's currently profitable.
```bash
npx hardhat run scripts/check-opportunities.js --network gnosis
```

### Step 2: Safe Execution
Once you find a good amount (e.g., 0.01 GNO), update `amount` in `scripts/safe-execute.js` and run:

**1. Analysis (Dry Run):**
```bash
npx hardhat run scripts/safe-execute.js --network gnosis
```

**2. Actual Transaction:**
Use the `EXECUTE=true` flag to send the transaction to the blockchain.
```bash
# Windows (PowerShell)
$env:EXECUTE="true"; npx hardhat run scripts/safe-execute.js --network gnosis

# Linux / Mac / Git Bash
EXECUTE=true npx hardhat run scripts/safe-execute.js --network gnosis
```

---

## 🤖 Automated Arbitrage Bot (`arb-bot.js`)

The `arb-bot.js` script is a professional monitoring tool that continuously scans for profit, accounts for gas, and automatically executes when an "edge" is found.

### Key Features:
- **Optimization**: Tests multiple borrow amounts (0.1 to 2.0 GNO) to find the absolute best profit.
- **Gas Aware**: Automatically subtracts current gas costs from potential profit. It only executes if `Net Profit > minNetProfit`.
- **JSON Logging**: Every scan and execution is logged to `/logs/arbitrage-bot.json` for analysis.
- **Safety**: Requires `CONFIRM=true` environment variable to send real transactions.

### How to Run:

**1. Dry Run (Scan only, no transactions):**
```bash
npx hardhat run scripts/arb-bot.js --network gnosis
```

**2. Production (Auto-Execution enabled):**
```bash
# Windows
$env:CONFIRM="true"; npx hardhat run scripts/arb-bot.js --network gnosis

# Linux/Mac
CONFIRM=true npx hardhat run scripts/arb-bot.js --network gnosis
```

### JSON Log Format:
The bot exports data to `logs/arbitrage-bot.json`.
```json
{"type":"scan","timestamp":"...","gasPrice":"2.50","bestOpportunity":{"strategy":"SPOT_SPLIT","amount":"1.0","profit":0.0088,"netProfit":0.0058}}
{"type":"trade","timestamp":"...","txHash":"0x...","status":"success","profit":0.0088,"gasUsed":"1120000","strategy":"SPOT_SPLIT","amount":"1.0"}
```

---

## When Each Strategy is Profitable

| Condition | Profitable Strategy | Borrow |
|-----------|--------------------| -------|
| Outcome prices > Spot | **SPOT_SPLIT** (0) | GNO |
| Outcome prices < Spot | **MERGE_SPOT** (1) | sDAI |

**Current Market (Jan 2026)**:
- Spot: ~112 sDAI/GNO
- YES_GNO: ~115 sDAI
- NO_GNO: ~115 sDAI
- **Profitable**: SPOT_SPLIT ✅

---

## Internal Contract Steps (What Happens Under the Hood)

### SPOT_SPLIT Flow Internals

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 0: Flash Loan                                                          │
│ ─────────────────────────────────────────────────────────────────────────── │
│ balancerVault.unlock() → vault.sendTo(GNO, contract, amount)                │
│                                                                             │
│ Result: Contract now holds borrowed GNO                                     │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 1: Split Position                                                      │
│ ─────────────────────────────────────────────────────────────────────────── │
│ futarchyRouter.splitPosition(proposal, GNO, amount)                         │
│                                                                             │
│ What happens:                                                               │
│   - Burns: 1 GNO                                                            │
│   - Mints: 1 YES_GNO + 1 NO_GNO                                             │
│                                                                             │
│ These are ERC1155 wrapped conditional tokens representing:                  │
│   - YES_GNO = GNO you get if proposal PASSES                                │
│   - NO_GNO = GNO you get if proposal FAILS                                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 2: Sell YES_GNO                                                        │
│ ─────────────────────────────────────────────────────────────────────────── │
│ swaprRouter.exactInputSingle(YES_GNO → YES_SDAI)                            │
│                                                                             │
│ What happens:                                                               │
│   - Swaps on Algebra V3 pool (YES_GNO/YES_SDAI)                             │
│   - Price: ~115 YES_SDAI per YES_GNO                                        │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 3: Sell NO_GNO                                                         │
│ ─────────────────────────────────────────────────────────────────────────── │
│ swaprRouter.exactInputSingle(NO_GNO → NO_SDAI)                              │
│                                                                             │
│ What happens:                                                               │
│   - Swaps on Algebra V3 pool (NO_GNO/NO_SDAI)                               │
│   - Price: ~115 NO_SDAI per NO_GNO                                          │
│                                                                             │
│ Now we have: ~115 YES_SDAI + ~115 NO_SDAI                                   │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 4: Merge sDAI Positions                                                │
│ ─────────────────────────────────────────────────────────────────────────── │
│ futarchyRouter.mergePositions(proposal, sDAI, min(YES, NO))                 │
│                                                                             │
│ What happens:                                                               │
│   - Burns: 115 YES_SDAI + 115 NO_SDAI                                       │
│   - Mints: 115 real sDAI                                                    │
│                                                                             │
│ CRITICAL: You can only merge equal amounts!                                 │
│ If you have 120 YES + 110 NO, you can only merge 110 of each.               │
│ Leftover 10 YES_SDAI is sent to caller.                                     │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 5: Swap sDAI → GNO                                                     │
│ ─────────────────────────────────────────────────────────────────────────── │
│ swaprRouter.exactInputSingle(sDAI → GNO)                                    │
│                                                                             │
│ What happens:                                                               │
│   - 115 sDAI ÷ 112 (spot price) = 1.027 GNO                                 │
│   - Now we have ~1.02 GNO to repay                                          │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 6: Repay Flash Loan + Send Profit                                      │
│ ─────────────────────────────────────────────────────────────────────────── │
│ GNO.transfer(vault, 1 GNO)                                                  │
│ balancerVault.settle(GNO, 1 GNO)                                            │
│ GNO.safeTransfer(caller, 0.02 GNO)  // PROFIT                               │
│                                                                             │
│ Also sends any leftovers:                                                   │
│   - Leftover YES_GNO, NO_GNO, YES_SDAI, NO_SDAI → caller                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key Concepts

#### Split Position
```solidity
futarchyRouter.splitPosition(proposal, collateral, amount)
```
- **Collateral IN**: Real GNO or sDAI
- **Outcomes OUT**: YES + NO versions of the collateral
- Ratio is always 1:1 (1 GNO → 1 YES_GNO + 1 NO_GNO)

#### Merge Positions
```solidity
futarchyRouter.mergePositions(proposal, collateral, amount)
```
- **Outcomes IN**: Equal amounts of YES + NO
- **Collateral OUT**: Real GNO or sDAI
- Must have equal amounts of both outcomes to merge!

#### Why Leftovers Happen
If YES and NO pools have different prices, you'll get unequal amounts:
```
1 YES_GNO → 120 YES_SDAI (pool price 120)
1 NO_GNO  → 110 NO_SDAI  (pool price 110)

Merge: min(120, 110) = 110 sDAI
Leftover: 10 YES_SDAI (sent to caller!)
```

---

## Understanding `minProfit` (The Safety Guard)

The `minProfit` parameter is a mandatory requirement in the `executeArbitrage` function. It acts as your protection against losses.

### Why it exists:
1. **MEV/Frontrunning Protection:** Prevents bots from "sandwiching" your trade. If a bot tries to manipulate the price while your transaction is in the mempool, the contract will revert because the profit fell below your `minProfit`.
2. **Slippage Coverage:** Protects you from natural price movements between the time you send the transaction and when it is mined.
3. **Gas Rationality:** Ensures you don't spend more on gas than you make in profit.

### How to calculate it (The "90% Rule"):
1. **Estimate:** Run a static call using `scripts/check-opportunities.js` (e.g., Expected Profit = `0.025 GNO`).
2. **Buffer:** Apply a 10-20% "safety buffer" to allow for minor slippage.
3. **Set:** `0.025 GNO * 0.9 = 0.0225 GNO`. Pass `0.0225 GNO` as the `minProfit`.

> [!IMPORTANT]
> If `minProfit` is set too high (e.g., equal to the expected profit), the trade will frequently fail due to even tiny price movements.
> If set too low (e.g., 0), you are vulnerable to MEV bots "eating" your profit.

---

## Error Messages

| Error | Meaning |
|-------|---------|
| `Insufficient to repay` | Slippage too high, can't repay flash loan |
| `Profit below minimum` | Profit < minProfit parameter |
| `SPOT_SPLIT requires borrowing GNO` | Wrong borrow token for strategy |
| `MERGE_SPOT requires borrowing sDAI` | Wrong borrow token for strategy |
| `Invalid proposal` | Proposal doesn't have GNO/sDAI collateral |


Note: If you check test-sdai.js, you'll see that the MERGE_SPOT strategy is used to merge sDAI positions. This is because sDAI is a stablecoin, so it's less volatile than GNO. It's also more liquid, so it's easier to merge positions. 

If you go to  find_max.js, you will see borrow token is GNO. This is because we are using the SPOT_SPLIT strategy. 