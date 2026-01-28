# Balancer V3 Boosted Pools - Comprehensive Guide

## Overview

Balancer V3 Boosted Pools contain **yield-bearing wrapped tokens** (ERC-4626) instead of raw underlying assets. This design maximizes capital efficiency by earning yield on idle liquidity, but requires special handling for deposits and swaps.

> [!IMPORTANT]
> You **cannot** add liquidity or swap with raw tokens (e.g., GHO, AAVE) directly in a Boosted Pool. You must use specialized routers that handle wrapping automatically.

---

## Key Contracts (Ethereum Mainnet)

| Contract | Address | Purpose |
|----------|---------|---------|
| **Vault** | `0xbA1333333333a1BA1108E8412f11850A5C319bA9` | Core vault (holds all tokens) |
| **Router** | `0xAE563E3f8219521950555F5962419C8919758Ea2` | Standard swaps (wrapped tokens only) |
| **CompositeLiquidityRouter** | `0xb21A277415c8A9A8c1F32f2...` | Liquidity with underlying → auto-wrap |
| **BatchRouter / AggregatorBatchRouter** | `0xDADa7bE4...92D49` | Multi-step swaps with buffers |
| **BufferRouter** | `0x9179C066...7FE0E7b45` | Initialize/top-up ERC-4626 buffers |
| **Permit2** | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Gasless approvals |

---

## Understanding Wrapped Tokens

### Raw vs Wrapped

| Raw Token | Wrapped Token (ERC-4626) | Yield Source |
|-----------|--------------------------|--------------|
| GHO | waGHO | Aave lending |
| AAVE | waAAVE | Aave staking |
| DAI | stataDAI | Aave lending |
| USDC | stataUSDC | Aave lending |

### How Wrapping Works

```
User deposits GHO
       ↓
CompositeLiquidityRouter calls ERC-4626.deposit(GHO)
       ↓
Receives waGHO (yield-bearing shares)
       ↓
waGHO deposited into Boosted Pool
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        USER                                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Raw Tokens (GHO, AAVE)                 Wrapped Tokens (waGHO)   │
│         │                                        │               │
│         ▼                                        ▼               │
│  ┌──────────────────────┐              ┌─────────────────────┐  │
│  │ CompositeLiquidityRouter │           │  Standard Router    │  │
│  │ or BatchRouter        │              │                     │  │
│  └──────────────────────┘              └─────────────────────┘  │
│         │                                        │               │
│         │ (auto-wrap)                            │ (direct)      │
│         ▼                                        ▼               │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                         VAULT                             │   │
│  │  ┌─────────────────┐  ┌─────────────────────────────┐    │   │
│  │  │  ERC-4626       │  │     Boosted Pool             │    │   │
│  │  │  Buffers        │◄─┤     (waGHO, waAAVE, ...)    │    │   │
│  │  │  (liquidity)    │  │                              │    │   │
│  │  └─────────────────┘  └─────────────────────────────┘    │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Adding Liquidity to Boosted Pools

### ❌ Wrong Way (Standard Router)

```javascript
// This will FAIL - pool expects wrapped tokens, not raw!
router.addLiquidityUnbalanced(
  poolAddress,
  [ghoAmount, aaveAmount],  // Raw tokens
  minBptOut,
  false,
  "0x"
);
```

### ✅ Correct Way (CompositeLiquidityRouter)

```javascript
const compositeLiquidityRouter = new ethers.Contract(
  "0xb21A2774...15c8A",
  COMPOSITE_ROUTER_ABI,
  signer
);

// This auto-wraps GHO → waGHO before depositing
await compositeLiquidityRouter.addLiquidityUnbalancedToERC4626Pool(
  poolAddress,
  [ghoAmount, 0],  // Underlying amounts (raw tokens)
  minBptAmountOut,
  false,           // wethIsEth
  "0x"             // userData
);
```

---

## Swapping with Underlying Tokens

### The Buffer System

The Vault maintains **ERC-4626 buffers** that hold both underlying and wrapped tokens. When swapping, if sufficient buffer liquidity exists, the Vault can perform instant wrap/unwrap without calling the lending protocol.

### Multi-Step Swap Path

To swap raw DAI → raw USDC through a Boosted Pool:

```javascript
const swapPath = [
  {
    // Step 1: Wrap DAI → stataDAI
    pool: stataDAI_address,
    tokenIn: DAI,
    tokenOut: stataDAI,
    isBuffer: true  // ← Critical flag!
  },
  {
    // Step 2: Swap stataDAI → stataUSDC in pool
    pool: boostedPoolAddress,
    tokenIn: stataDAI,
    tokenOut: stataUSDC,
    isBuffer: false
  },
  {
    // Step 3: Unwrap stataUSDC → USDC
    pool: stataUSDC_address,
    tokenIn: stataUSDC,
    tokenOut: USDC,
    isBuffer: true  // ← Critical flag!
  }
];

await batchRouter.swapExactIn(
  swapPath,
  amountIn,
  minAmountOut,
  deadline
);
```

> [!TIP]
> Set `isBuffer: true` for any step that involves an ERC-4626 wrapper token.

---

## Detecting Boosted Pool Tokens

### Programmatic Detection

```javascript
// Check if a token is ERC-4626 (wrapped)
async function isERC4626(tokenAddress, provider) {
  const erc4626 = new ethers.Contract(tokenAddress, [
    "function asset() view returns (address)"
  ], provider);
  
  try {
    const underlyingAsset = await erc4626.asset();
    return { isWrapped: true, underlying: underlyingAsset };
  } catch {
    return { isWrapped: false, underlying: null };
  }
}

// Example usage
const result = await isERC4626("0xwaGHO...", provider);
// { isWrapped: true, underlying: "0x40D16FC..." (GHO) }
```

### Known Wrapped Tokens

| Wrapped Token | Symbol | Underlying | Contract |
|---------------|--------|------------|----------|
| Wrapped Aave GHO | waGHO | GHO | `0x...` |
| Wrapped Aave AAVE | waAAVE | AAVE | `0x...` |
| Static Aave DAI | stataDAI | DAI | `0x...` |
| Static Aave USDC | stataUSDC | USDC | `0x...` |

---

## Buffer Router (Advanced)

For setting up or topping up ERC-4626 buffers:

```javascript
const bufferRouter = new ethers.Contract(
  "0x9179C066...7FE0E7b45",
  BUFFER_ROUTER_ABI,
  signer
);

// Initialize a new buffer for a wrapped token
await bufferRouter.initializeBuffer(
  wrappedTokenAddress,  // IERC4626
  exactUnderlyingAmount,
  exactWrappedAmount,
  minShares
);

// Add liquidity to existing buffer
await bufferRouter.addLiquidityToBuffer(
  wrappedTokenAddress,
  maxUnderlyingAmount,
  maxWrappedAmount,
  exactShares
);
```

> [!NOTE]
> Most integrators use `CompositeLiquidityRouter` or `BatchRouter` instead of calling `BufferRouter` directly.

---

## SDK Support

The Balancer JS/TS SDK is being extended to support boosted pools:

```javascript
import { BalancerSDK } from '@balancer-labs/sdk';

const sdk = new BalancerSDK({ network: 1 });

// Build swap path with buffer steps automatically
const path = await sdk.swaps.buildSwapPath({
  tokenIn: GHO_ADDRESS,
  tokenOut: AAVE_ADDRESS,
  pool: boostedPoolAddress,
  useBuffers: true  // Auto-detect and include wrap/unwrap steps
});
```

---

## Common Mistakes

### 1. Using Standard Router with Raw Tokens

**Error:** `Token not found in pool`

```javascript
// ❌ Wrong
router.swapSingleTokenExactIn(pool, GHO, AAVE, amount, ...);

// ✅ Correct - use BatchRouter with buffer steps
batchRouter.swapExactIn(pathWithBufferSteps, amount, ...);
```

### 2. Forgetting `isBuffer` Flag

**Error:** Swap reverts because wrapper not invoked

```javascript
// ❌ Wrong
{ pool: stataDAI, tokenIn: DAI, tokenOut: stataDAI, isBuffer: false }

// ✅ Correct
{ pool: stataDAI, tokenIn: DAI, tokenOut: stataDAI, isBuffer: true }
```

### 3. Calling Vault Directly

**Error:** Raw deposit to boosted pool fails

```javascript
// ❌ Wrong - Vault expects wrapped tokens
vault.addLiquidity(params);

// ✅ Correct - Use CompositeLiquidityRouter
compositeLiquidityRouter.addLiquidityUnbalancedToERC4626Pool(params);
```

---

## Summary

| Action | Router to Use | Function |
|--------|---------------|----------|
| Add liquidity (raw tokens) | CompositeLiquidityRouter | `addLiquidityUnbalancedToERC4626Pool` |
| Add liquidity (wrapped) | Standard Router | `addLiquidityUnbalanced` |
| Swap (raw → raw) | BatchRouter | `swapExactIn` with buffer steps |
| Swap (wrapped → wrapped) | Standard Router | `swapSingleTokenExactIn` |
| Initialize buffer | BufferRouter | `initializeBuffer` |

---

## References

- [Balancer V3 Documentation](https://docs.balancer.fi/concepts/explore-available-balancer-pools/boosted-pool.html)
- [ERC-4626 Standard](https://eips.ethereum.org/EIPS/eip-4626)
- [Balancer SDK](https://github.com/balancer/balancer-sdk)
- [CompositeLiquidityRouter Source](https://etherscan.io/address/0xb21A2774...)
