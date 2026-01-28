# Arbitrage Bots Guide

Comprehensive guide for running permissionless flash arbitrage bots on Futarchy markets.

## Deployed Contracts

| Network | Contract | Address | Bot Script |
|---------|----------|---------|------------|
| **Gnosis Chain** | GnosisFlashArbitrageV4 | [`0x0ECD7369cFe4CD2f35b47B3c66e32AaC2016B25a`](https://gnosisscan.io/address/0x0ECD7369cFe4CD2f35b47B3c66e32AaC2016B25a) | `scripts/arb-bot.js` |
| **Ethereum Mainnet** | AaveFlashArbitrageV2 | [`0x098321F3f0d20dD4fc9559267a9B1c88AaDd2876`](https://etherscan.io/address/0x098321F3f0d20dD4fc9559267a9B1c88AaDd2876) | `scripts/arb-bot-aave.js` |

---

## Quick Start

### 1. Configure Environment

```bash
# .env file
PRIVATE_KEY=your_wallet_private_key

# Gnosis
GNOSIS_RPC_URL=https://rpc.gnosischain.com

# Ethereum Mainnet
RPC_URL=https://ethereum.publicnode.com
ETHERSCAN_API_KEY=your_key  # For verification
```

### 2. Run Bots

**Gnosis Chain (GNO/sDAI markets):**
```bash
# Dry run (simulation only)
npx hardhat run scripts/arb-bot.js --network gnosis

# Live execution
CONFIRM=true npx hardhat run scripts/arb-bot.js --network gnosis
```

**Ethereum Mainnet (AAVE/GHO markets):**
```bash
# Dry run (simulation only)
node scripts/arb-bot-aave.js

# Live execution
CONFIRM=true node scripts/arb-bot-aave.js
```

---

## Architecture Comparison

| Feature | Gnosis V4 | Mainnet V2 |
|---------|-----------|------------|
| **Flash Loan** | Balancer V3 | Balancer V3 |
| **Outcome Swaps** | Algebra (Uniswap V3 fork) | Uniswap V3 |
| **Repayment** | Direct pools | Balancer V2 (3-hop) |
| **Collaterals** | GNO / sDAI | AAVE / GHO |
| **Pool Type** | YES_GNO/YES_SDAI | YES_AAVE/YES_GHO |

---

## Arbitrage Strategies

### SPOT_SPLIT (Direction: 0)
Borrow collateral → Split → Sell outcomes → Merge other outcomes → Swap back → Repay

**Profitable when:** `min(YES_price, NO_price) > SPOT + fees`

### MERGE_SPOT (Direction: 1)
Borrow collateral → Swap to other → Split → Buy outcomes → Merge → Repay

**Profitable when:** `max(YES_price, NO_price) < SPOT - fees`

---

## Monitoring

Both bots log to JSON files:
- Gnosis: `logs/arbitrage-bot.json`
- Mainnet: `logs/arb-bot-aave.json`

**Key metrics:**
- Gas price at scan time
- Best opportunity found
- Net profit after gas
- Trade execution status

---

## Analysis Scripts

```bash
# Check Uniswap outcome pool prices/liquidity
node scripts/check-outcome-pools.js

# Check Balancer V2 repayment swap costs
node scripts/check-balancer-swap.js

# Verify proposal infrastructure
node scripts/verify-mainnet-proposal.js
```

---

## Troubleshooting

| Error | Cause | Solution |
|-------|-------|----------|
| `Insufficient funds to repay` | Slippage > profit | Reduce trade size or wait for better prices |
| `Invalid borrow token` | Wrong token address | Use AAVE or GHO on Mainnet |
| `Pool reverted` | Low liquidity | Try smaller amounts |
| `GYR#357` | Balancer pool limit | Amount too large for pool |

---

## Security Notes

- **Permissionless:** Anyone can call `executeArbitrage`
- **Profit to caller:** All profit goes to `msg.sender`
- **Admin role:** Only for emergency token recovery
- **No custody:** Contract doesn't hold funds between txs
