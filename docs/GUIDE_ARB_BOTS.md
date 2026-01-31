# Arbitrage Bots Guide

Comprehensive guide for running permissionless flash arbitrage bots on Futarchy markets.

## Deployed Contracts

| Network | Contract | Address | Bot Script |
|---------|----------|---------|------------|
| **Gnosis Chain** | GnosisFlashArbitrageV4 | [`0x0ECD7369cFe4CD2f35b47B3c66e32AaC2016B25a`](https://gnosisscan.io/address/0x0ECD7369cFe4CD2f35b47B3c66e32AaC2016B25a) | `scripts/arb-bot.js` |
| **Ethereum Mainnet** | **AaveFlashArbitrageV6** | [`0xBc69Db11D5Eb837926E8f5Bb6Dd20069193919AE`](https://etherscan.io/address/0xBc69Db11D5Eb837926E8f5Bb6Dd20069193919AE) | `scripts/arb-bot-aave-v6.js` |
| **Ethereum Mainnet** | VLRFlashArbitrageV3 | [`0xe0A988Ccb9b65036Bc7C6E307De6e5518a0F3B62`](https://etherscan.io/address/0xe0A988Ccb9b65036Bc7C6E307De6e5518a0F3B62) | `scripts/arb-bot-vlr.js` |

---

## Quick Start

### 1. Configure Environment

```bash
# .env file
PRIVATE_KEY=your_wallet_private_key

# Gnosis
GNOSIS_RPC_URL=https://rpc.gnosischain.com

# Ethereum Mainnet
MAINNET_RPC_URL=https://ethereum.publicnode.com
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

**Ethereum Mainnet (AAVE/GHO markets - V6):**
```bash
# Continuous monitoring & execution check
node scripts/arb-bot-aave-v6.js
```

**Ethereum Mainnet (VLR/USDS markets):**
```bash
# Dry run (simulation only)
node scripts/arb-bot-vlr.js

# Live execution
CONFIRM=true node scripts/arb-bot-vlr.js
```

---

## Architecture Comparison

| Feature | Gnosis V4 | Mainnet AAVE V6 | Mainnet VLR V3 |
|---------|-----------|-----------------|----------------|
| **Flash Loan** | Balancer V3 | Balancer V2 (0% fee!) | Balancer V2 (0% fee!) |
| **Outcome Swaps** | Algebra (Uniswap V3 fork) | Uniswap V3 (Dynamic) | Uniswap V3 (Universal) |
| **Repayment** | Direct pools | Universal Router + Permit2 | Universal Router + Permit2 |
| **Collaterals** | GNO / sDAI | AAVE / GHO | VLR / USDS |
| **Pool Logic** | Auto-Discovery | **Dynamic Proposal Loading** | Hardcoded |
| **MEV Protection** | minProfit | minProfit + Atomic Revert | minProfit + Atomic Revert |

---

## Aave V6 Strategy Details

The Aave V6 bot handles the complex 4-hop swap and dynamic proposal loading:

1.  **Dynamic Loading**: The contract inspects `FutarchyProposal` collateral to determine YES/NO token addresses automatically.
2.  **Optimized Path**: Uses `AAVE -> WETH -> USDC (0.05%) -> GHO (0.05%)` path. The **0.05% GHO/USDC pool** is critical as it has deep liquidity (~163k GHO), whereas the 0.01% pool is empty.
3.  **Strategies**:
    *   **SPOT_SPLIT**: Borrow AAVE → Split to YES+NO → Swap Outcomes to GHO → Merge → Swap GHO to AAVE.
    *   **MERGE_SPOT**: Borrow AAVE → Swap to GHO → Split to YES+NO → Swap Outcomes to AAVE → Merge.

See [AAVE_V6_SAGA.md](./AAVE_V6_SAGA.md) for the full development history.

---

## Arbitrage Strategies (General)

### SPOT_SPLIT (Direction: 0)
Borrow collateral → Split → Sell outcomes → Merge other outcomes → Swap back → Repay

**Profitable when:** `min(YES_price, NO_price) > SPOT + fees`

### MERGE_SPOT (Direction: 1)
Borrow collateral → Swap to other → Split → Buy outcomes → Merge → Repay

**Profitable when:** `max(YES_price, NO_price) < SPOT - fees`

---

## Monitoring

Both bots log to console and can be configured to log to file.

**Key metrics:**
- Gas price at scan time
- Best opportunity found
- Net profit after gas
- Trade execution status

---

## Analysis Scripts

```bash
# Debug Aave V6 (Static Call Checks)
node scripts/debug-aave-v6-arb.js

# Check Uniswap outcome pool prices/liquidity
node scripts/check-outcome-pools.js

# Check Balancer costs
node scripts/check-balancer-swap.js
```

---

## Troubleshooting

| Error | Cause | Solution |
|-------|-------|----------|
| `Insufficient funds to repay` | Slippage > profit | Reduce trade size or wait for better prices |
| `ArbitrageFailed` | Contract logic check failed (profit < minProfit) | Normal behavior when opportunity disappears |
| `ERC20: transfer to the zero address` | Logic bug or missing approval | Use V6 (Fixed dynamic approvals) |
| `missing revert data` | Out of Gas (OOG) | Use `{ gasLimit: 5000000 }` in script |


---

## Security Notes

- **Permissionless:** Anyone can call `executeArbitrage`
- **Profit to caller:** All profit goes to `msg.sender`
- **Admin role:** Only for emergency token recovery
- **No custody:** Contract doesn't hold funds between txs

---

## VLR/USDS Detailed Guide

### Flash Loan Constraints

**Critical: Only VLR can be flash borrowed!**

| Token | Balancer V2 Vault Liquidity |
|-------|----------------------------|
| VLR | 210M VLR ✅ |
| USDS | 0 USDS ❌ |

This means **both strategies borrow VLR**:

**SPOT_SPLIT:** `VLR → split → swap outcomes to USDS → merge USDS → swap back to VLR`

**MERGE_SPOT:** `VLR → swap to USDS → split → swap outcomes to VLR → merge VLR`

### Contract Versions

| Version | Address | Status |
|---------|---------|--------|
| V1 | `0xC6BF0047710cD512b24a5E9472CA1665d70171b0` | ❌ Legacy (uses old SwapRouter) |
| V2 | `0x4d6b0d01a3Ee9cE2cF731fcf7325ad835cB952A4` | ✅ Working (Universal Router + Permit2) |
| V3 | `0xe0A988Ccb9b65036Bc7C6E307De6e5518a0F3B62` | ✅ **Recommended** (V2 + minProfit protection) |

### MEV Protection with minProfit

The V3 contract uses `minProfit` as MEV protection:

```solidity
function executeArbitrage(
    uint256 borrowAmount,     // Amount of VLR to flash borrow
    ArbitrageDirection direction,  // 0 = SPOT_SPLIT, 1 = MERGE_SPOT
    uint256 minProfit,        // Minimum profit in VLR (MEV protection!)
    uint256 slippageBps       // Unused, kept for compatibility
) external returns (ArbitrageResult memory)
```

> [!CAUTION]
> **You MUST use explicit gas limit!** The default gas estimation fails for VLR arbitrage due to its complexity (flash loan + 5 swaps + split/merge). Always use `{ gasLimit: 3000000 }` for both simulations AND real transactions. Without this, you'll get `missing revert data` errors.

**How it works:**
- Individual swaps use `amountOutMinimum = 0` (allow any slippage)
- At the end, contract checks: `profit >= minProfit`
- If not, **entire transaction reverts** → you pay only gas, no loss

**Example:**
```javascript
// Simulate opportunity
const result = await contract.executeArbitrage.staticCall(
    ethers.parseEther('500'),  // Borrow 500 VLR
    0,                          // SPOT_SPLIT
    ethers.parseEther('5'),     // Require at least 5 VLR profit
    0,                          // slippageBps (unused)
    { gasLimit: 3000000 }
);
// result.profit = 6.88 VLR → SUCCESS (6.88 > 5)

// If MEV bot sandwiches and profit drops to 4 VLR → REVERT!
```

### Verified Profitability (2026-01-28)

**Gross profit (before gas):**

| Amount | Profit | % |
|--------|--------|---|
| 1,000 VLR | 13.6 VLR | 1.35% |
| 20,000 VLR | 151.5 VLR | 0.76% |
| 30,000 VLR | 132.2 VLR | 0.44% |
| 40,000+ | ❌ Pool liquidity limit |

> [!NOTE]
> **Live Transaction Verified:** [0xea3d45a08d3f53...](https://etherscan.io/tx/0xea3d45a08d3f53b7eff332a4d31600c79d0b7496400d68a03ddf93e81f19700e)
> - Amount: 30,000 VLR
> - Profit: 132.24 VLR (~$0.26 USD)
> - Gas used: **1.23M** (not 2.5M!)
> - Gas cost: ~$0.18 USD
> - **NET: +$0.08 USD** ✅

**NET Profit Table** (with 1.3M gas @ 0.05 gwei = $0.19):

| Amount VLR | Gross VLR | Gross USD | Gas USD | NET USD |
|------------|-----------|-----------|---------|---------|
| 1,000 | 13.65 | $0.027 | $0.19 | **-$0.16** ❌ |
| 20,000 | 151.52 | $0.30 | $0.19 | **+$0.11** ✅ |
| 30,000 | 132.24 | $0.26 | $0.19 | **+$0.07** ✅ |

**Optimal: 20,000 VLR** (best profit % before slippage increases)

The bot calculates this automatically - run it to check current conditions:
```bash
node scripts/arb-bot-vlr.js
```

### VLR Token Addresses

```
VLR:      0x4e107a0000DB66f0E9Fd2039288Bf811dD1f9c74
USDS:     0xdC035D45d973E3EC169d2276DDab16f1e407384F
USDC:     0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
YES_VLR:  0x354582ff9f500f05b506666b75B33dbc90A8708d
NO_VLR:   0x4B53aE333bB337c0C8123aD84CE2F541ed53746E
YES_USDS: 0xa51aFa14963FaE9696b6844D652196959Eb5b9F6
NO_USDS:  0x1a9c528Bc34a7267b1c51a8CD3fad9fC99136171
Proposal: 0x4e018f1D8b93B91a0Ce186874eDb53CB6fFfCa62
```

### Universal Router Pattern

VLR contracts use the modern Universal Router + Permit2 pattern:

```
Token → Permit2 (ERC20.approve)
      ↓
Permit2 → Router (Permit2.approve)
      ↓
Router executes swap with payerIsUser=true
```

For troubleshooting, see [UNIVERSAL_ROUTER_TROUBLESHOOTING.md](./UNIVERSAL_ROUTER_TROUBLESHOOTING.md).

