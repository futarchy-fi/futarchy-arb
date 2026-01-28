# Balancer V3 GHO→AAVE Swap Attempt - Post-Mortem

**Date:** 2026-01-28 05:45 UTC  
**Network:** Ethereum Mainnet  
**Status:** ❌ Failed

---

## Transaction Details

| Field | Value |
|-------|-------|
| **TX Hash** | [`0xa5a2ed509c52cf5ba55dcae6c9fb7fadedd64fcd7ca873b8bbee5e5e3367348f`](https://etherscan.io/tx/0xa5a2ed509c52cf5ba55dcae6c9fb7fadedd64fcd7ca873b8bbee5e5e3367348f) |
| **From** | `0x645A3D9208523bbFEE980f7269ac72C61Dd3b552` |
| **To** | `0xAE563E3f8219521950555F5962419C8919758Ea2` (Balancer V3 Router) |
| **Function** | `swapSingleTokenExactIn()` |
| **Gas Used** | 177,751 / 250,000 (71%) |
| **Gas Cost** | ~0.000025 ETH |

---

## What Went Right ✅

### 1. ERC20 → Permit2 Approval
- **TX:** `0x69af8ba60b2763732c25a13d4511002d76ff7a8b81ac4bf35f1caa9aea004ab2`
- **Status:** ✅ Confirmed
- Approved GHO to Permit2 contract

### 2. Permit2 → Router Approval  
- **TX:** `0xf06748b6c5798d1cf18e4a8ab72d53a14ae5faa6b7fe374a6581f551deaee771`
- **Status:** ✅ Confirmed
- Approved Permit2 to spend GHO on behalf of Balancer V3 Router

### 3. Gas Estimation
- Script correctly estimated gas costs
- All threshold checks passed ($0.14 total)

---

## What Went Wrong ❌

### Issue 1: AAVE Token Is NOT In This Pool

Looking at the [Balancer UI](https://balancer.fi/pools/ethereum/v3/0x85b2b559bc2d21104c4defdd6efca8a20343361d), this pool is:

**"Aave GHO/USDT/USDC"** - a stablecoin pool containing:
- ✅ GHO (via waGHO)
- ✅ USDT (via waUSDT)
- ✅ USDC (via waUSDC)
- ❌ **NO AAVE token!**

> [!CAUTION]
> The pool name "Aave GHO/USDT/USDC" refers to **Aave yield strategy**, NOT the AAVE token!

**What you CAN do with this pool:**
- Swap GHO ↔ USDT ✅
- Swap GHO ↔ USDC ✅
- Swap USDT ↔ USDC ✅

**What you CANNOT do:**
- Swap GHO ↔ AAVE ❌ (AAVE not in pool)

---

### Issue 2: Boosted Pool Requires Wrapped Tokens

Even if AAVE were in the pool, this is a **Boosted Pool** that uses wrapped ERC-4626 tokens:

#### Tenderly Stack Trace

```
Vault._findTokenIndex(
  tokens = [
    "0x7bc3485026ac48b6cf9baf0a377477fff5703af8",  // wrapped token
    "0xc71ea051a5f82c67adcf634c36ffe6334793d24c",  // wrapped token
    "0xd4fa2d31b7968e448877f69a96de69f5de8cd23e"   // wrapped token
  ],
  token = 0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f  // raw GHO
)
=> REVERT: Token not found
```

The pool expects **wrapped** tokens (waGHO, waUSDT, waUSDC), not raw tokens.

---

### Summary of Both Issues

| Issue | Problem | Solution |
|-------|---------|----------|
| **Wrong pool** | AAVE not in GHO/USDT/USDC pool | Find a GHO-AAVE pool (if exists) |
| **Boosted pool** | Raw tokens not accepted | Use `CompositeLiquidityRouter` or buffer steps |

---

## Technical Flow

```
User → Router.swapSingleTokenExactIn()
         │
         ▼
       Vault.unlock() → Vault.swap()
                           │
                           ▼
                    Vault._loadSwapState()
                           │
                           ▼
                    Vault._findTokenIndex(GHO)
                           │
                           ▼
                    ❌ REVERT: Token not in pool
```

---

## Lessons Learned

1. **Always verify pool composition** before swapping
   - Query `vault.getPoolTokens(pool)` to confirm tokens
   - Don't assume pool address from documentation

2. **Balancer V3 Boosted Pools** use wrapped tokens
   - GHO → waGHO (wrapped Aave GHO)
   - AAVE → waAAVE (wrapped Aave AAVE)
   - Need to wrap/unwrap or find a direct pool

3. **Quote failures are warnings**
   - The script showed `⚠️ Quote failed` but continued
   - Should abort if quote fails (indicates pool incompatibility)

---

## Next Steps

1. **Find a direct GHO-AAVE pool** on Balancer V3 (if one exists)
2. **Or use wrapped tokens:**
   - Wrap GHO → waGHO first
   - Swap waGHO → waAAVE in the pool
   - Unwrap waAAVE → AAVE
3. **Or use a different DEX** (e.g., Uniswap V3)

---

## Cost Analysis

| Transaction | Status | Gas Cost |
|-------------|--------|----------|
| ERC20 Approval | ✅ | ~$0.02 |
| Permit2 Approval | ✅ | ~$0.02 |
| Swap (reverted) | ❌ | ~$0.02 |
| **Total Lost** | | **~$0.06** |

The approvals are still valid and can be reused for future attempts.

---

## References

- [Tenderly TX Analysis](https://dashboard.tenderly.co/tx/mainnet/0xa5a2ed509c52cf5ba55dcae6c9fb7fadedd64fcd7ca873b8bbee5e5e3367348f)
- [Balancer V3 Router](https://etherscan.io/address/0xAE563E3f8219521950555F5962419C8919758Ea2)
- [Balancer V3 Vault](https://etherscan.io/address/0xbA1333333333a1BA1108E8412f11850A5C319bA9)
