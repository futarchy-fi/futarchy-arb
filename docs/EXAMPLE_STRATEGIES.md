# Futarchy Arbitrage Strategies

> **Reference guide for flash arbitrage strategies on Futarchy conditional markets**

---

## Strategy Overview

| Strategy | Profitable When | Bottleneck |
|----------|-----------------|------------|
| **SPOT_SPLIT** | MIN(YES, NO) > Spot | Receive MIN when merging |
| **MERGE_SPOT** | MAX(YES, NO) < Spot | Pay MAX for expensive outcome |

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    WHEN TO USE EACH STRATEGY                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   SPOT_SPLIT: Sell outcomes, merge to currency                          │
│   ─────────────────────────────────────────────                         │
│   You get MIN(YES, NO) when merging                                     │
│   → Profitable when MIN outcome price > spot (after fees)               │
│                                                                          │
│   MERGE_SPOT: Buy outcomes, merge to company token                      │
│   ─────────────────────────────────────────────                         │
│   You pay MAX(price) for the expensive outcome                          │
│   → Profitable when MAX outcome price < spot (after fees)               │
│                                                                          │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │                                                                 │   │
│   │   MIN(YES,NO) > SPOT              MAX(YES,NO) < SPOT            │   │
│   │   ════════════════                ════════════════              │   │
│   │                                                                 │   │
│   │   Use: SPOT_SPLIT                 Use: MERGE_SPOT               │   │
│   │   Split → Sell high outcomes      Buy cheap outcomes → Merge    │   │
│   │   Bottleneck: MIN received        Bottleneck: MAX paid          │   │
│   │                                                                 │   │
│   └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Strategy 1: SPOT_SPLIT

**When profitable**: MIN outcome price > spot price (after fees)  
**Direction**: Split cheap spot → Sell expensive outcomes → Merge → Convert back

### Flow Diagram

```
BORROW               SPLIT                SWAP OUTCOMES           MERGE              REPAY
  │                    │                      │                     │                  │
  ▼                    ▼                      ▼                     ▼                  ▼
┌──────────┐    ┌─────────────┐    ┌──────────────────┐    ┌─────────────┐    ┌─────────────┐
│ Flash    │    │ Split       │    │ Swap YES → YES   │    │ Merge       │    │ Swap back   │
│ Borrow   │───▶│ CompanyToken│───▶│ Swap NO  → NO    │───▶│ to Currency │───▶│ Repay loan  │
│ Company  │    │ via Router  │    │ (Uniswap pools)  │    │ via Router  │    │ Keep profit │
└──────────┘    └─────────────┘    └──────────────────┘    └─────────────┘    └─────────────┘
```

### Step by Step

| Step | Action | Contract | Method |
|------|--------|----------|--------|
| 1 | Flash borrow CompanyToken | Pool | `flash()` |
| 2 | Approve FutarchyRouter | CompanyToken | `approve()` |
| 3 | Split to outcomes | FutarchyRouter | `splitPosition()` |
| 4 | Approve SwapRouter | YES_Company | `approve()` |
| 5 | Swap YES_Company → YES_Currency | SwapRouter | `exactInputSingle()` |
| 6 | Approve SwapRouter | NO_Company | `approve()` |
| 7 | Swap NO_Company → NO_Currency | SwapRouter | `exactInputSingle()` |
| 8 | Approve FutarchyRouter | YES_Currency, NO_Currency | `approve()` |
| 9 | Merge to Currency | FutarchyRouter | `mergePositions()` |
| 10 | Approve SwapRouter | Currency | `approve()` |
| 11 | Swap Currency → CompanyToken | SwapRouter | `exactInput()` |
| 12 | Repay flash loan + fee | Pool | `transfer()` |
| 13 | Send profit to caller | CompanyToken | `transfer()` |

---

## Strategy 2: MERGE_SPOT

**When profitable**: MAX outcome price < spot price (after fees)  
**Direction**: Swap to currency → Split → Buy cheap outcomes → Merge to company → Repay

### Flow Diagram

```
BORROW               SWAP                SPLIT                BUY OUTCOMES           MERGE & REPAY
  │                    │                    │                      │                      │
  ▼                    ▼                    ▼                      ▼                      ▼
┌──────────┐    ┌─────────────┐    ┌─────────────┐    ┌──────────────────┐    ┌─────────────┐
│ Flash    │    │ Swap        │    │ Split       │    │ Swap YES → YES   │    │ Merge       │
│ Borrow   │───▶│ Company     │───▶│ Currency    │───▶│ Swap NO  → NO    │───▶│ to Company  │
│ Company  │    │ → Currency  │    │ via Router  │    │ (Uniswap pools)  │    │ Repay+Profit│
└──────────┘    └─────────────┘    └─────────────┘    └──────────────────┘    └─────────────┘
```

### Step by Step

| Step | Action | Contract | Method |
|------|--------|----------|--------|
| 1 | Flash borrow CompanyToken | Pool | `flash()` |
| 2 | Approve SwapRouter | CompanyToken | `approve()` |
| 3 | Swap CompanyToken → Currency | SwapRouter | `exactInput()` |
| 4 | Approve FutarchyRouter | Currency | `approve()` |
| 5 | Split to outcomes | FutarchyRouter | `splitPosition()` |
| 6 | Approve SwapRouter | YES_Currency | `approve()` |
| 7 | Swap YES_Currency → YES_Company | SwapRouter | `exactInputSingle()` |
| 8 | Approve SwapRouter | NO_Currency | `approve()` |
| 9 | Swap NO_Currency → NO_Company | SwapRouter | `exactInputSingle()` |
| 10 | Approve FutarchyRouter | YES_Company, NO_Company | `approve()` |
| 11 | Merge to CompanyToken | FutarchyRouter | `mergePositions()` |
| 12 | Repay flash loan + fee | Pool | `transfer()` |
| 13 | Send profit to caller | CompanyToken | `transfer()` |

---

## Strategy Comparison

| Aspect | SPOT_SPLIT | MERGE_SPOT |
|--------|------------|------------|
| **Borrow** | CompanyToken | CompanyToken |
| **First Action** | Split → Outcomes | Swap → Currency |
| **Outcome Direction** | Sell Company outcomes | Buy Company outcomes |
| **Merge Token** | Currency | CompanyToken |
| **Bottleneck** | MIN received | MAX price paid |
| **Profitable When** | MIN > Spot | MAX < Spot |
| **Market Signal** | Both outcomes overpriced | Both outcomes underpriced |

---

## Key Formulas

### SPOT_SPLIT Profitability

```
profit = min(swap_YES, swap_NO) × merge_rate - borrow_amount - flash_fee - swap_fees
```

Where:
- `swap_YES` = Amount of YES_Currency received from selling YES_Company
- `swap_NO` = Amount of NO_Currency received from selling NO_Company
- `merge_rate` = Currency per merged outcome (usually 1:1)
- `flash_fee` = borrow_amount × pool_fee_rate

### MERGE_SPOT Profitability

```
profit = merged_company - borrow_amount - flash_fee - swap_fees
merged_company = min(bought_YES, bought_NO)
```

Where:
- `bought_YES` = YES_Company received from spending YES_Currency
- `bought_NO` = NO_Company received from spending NO_Currency

---

## Example: VLR/USDS Proposal

### Addresses (Mainnet)

| Token | Address |
|-------|---------|
| VLR (Company) | `0x4e107a0000DB66f0E9Fd2039288Bf811dD1f9c74` |
| USDS (Currency) | `0xdC035D45d973E3EC169d2276DDab16f1e407384F` |
| YES_VLR | `0x354582ff9f500f05b506666b75B33dbc90A8708d` |
| NO_VLR | `0x4B53aE333bB337c0C8123aD84CE2F541ed53746E` |
| YES_USDS | `0xa51aFa14963FaE9696b6844D652196959Eb5b9F6` |
| NO_USDS | `0x1a9c528Bc34a7267b1c51a8CD3fad9fC99136171` |

### Pools

| Pool | Address | Fee |
|------|---------|-----|
| YES_VLR/YES_USDS | `0x425d5D868B9C0fA9Ff7B6c8A46eA62f973D3e974` | 0.05% (500) |
| NO_VLR/NO_USDS | `0x488580A26a2976D2562eD5aAa9c5238B13C407DA` | 0.05% (500) |
| VLR/USDC (Flash) | `0xb382646C447007a23Eab179957235DC3FC51606c` | 0.3% (3000) |
| USDS/USDC | `0x8AEE53B873176D9F938D24a53A8aE5cF36276464` | 0.05% (500) |

### Contracts

| Contract | Address |
|----------|---------|
| Proposal | `0x4e018f1D8b93B91a0Ce186874eDb53CB6fFfCa62` |
| FutarchyRouter | `0xAc9B48C31c6528637D68F0FA0ac172a4007a00d1` |
| SwapRouter | `0xE592427A0AEce92De3Edee1F18E0157C05861564` |

---

## Related Documentation

- [UNISWAP_V3_ULTIMATE_GUIDE.md](./UNISWAP_V3_ULTIMATE_GUIDE.md) - Uniswap V3 swaps and flash loans
- [UNISWAP_POOL_DISCOVERY.md](./UNISWAP_POOL_DISCOVERY.md) - Finding pools for token pairs
- [BALANCER_V2_ULTIMATE_GUIDE.md](./BALANCER_V2_ULTIMATE_GUIDE.md) - Balancer V2 batch swaps
- [GUIDE_ARB_BOTS.md](./GUIDE_ARB_BOTS.md) - Bot operation guide
