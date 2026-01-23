# V5 Calldata Swaps - Design Document

## Overview

**V5** adds flexible swap routing via calldata, allowing custom swap paths without redeploying the contract.

## V4 vs V5 Comparison

| Feature | V4 | V5 |
|---------|----|----|
| Swap route | Hardcoded 3-hop | Hardcoded **OR** custom calldata |
| Flexibility | Fixed path only | Any protocol/route |
| Redeploy needed | Yes, for new routes | No |
| Function | `executeArbitrage()` | `executeArbitrage()` + `executeArbitrageWithCalldata()` |

---

## V4: Hardcoded Swap Route

```
sDAI → USDC → WXDAI → GNO (Balancer V2)
```

The swap route is **inside the contract** - cannot be changed:

```solidity
function _swapSdaiToGnoV2(uint256 amount) internal {
    // Hardcoded pool IDs, hardcoded tokens
    swaps[0] = { poolId: sdaiUsdcPool, amount: amount };
    swaps[1] = { poolId: usdcWxdaiPool, amount: 0 };
    swaps[2] = { poolId: wxdaiGnoPool, amount: 0 };
    balancerV2Vault.batchSwap(...);
}
```

---

## V5: New `executeArbitrageWithCalldata()`

### New Struct

```solidity
struct SwapStep {
    address target;     // Router to call (Balancer, Swapr, 1inch, etc.)
    address tokenIn;    // Contract will approve this token
    bytes data;         // Pre-encoded swap calldata
}
```

### New Function Signature

```solidity
function executeArbitrageWithCalldata(
    address proposalAddress,
    address borrowToken,
    uint256 borrowAmount,
    ArbitrageDirection direction,
    uint256 minProfit,
    SwapStep[] calldata swapSteps  // 🆕 Custom swap route
) external returns (ArbitrageResult memory);
```

### Flow

```
1. JavaScript builds calldata for any swap route
2. Pass SwapStep[] to contract
3. Contract executes split/merge as usual
4. For final swap (repay token):
   - If swapSteps.length > 0: Execute custom calldata
   - If empty: Fall back to hardcoded 3-hop
5. Contract approves → calls → revokes for each step
```

---

## The Challenge: Amount in Calldata

### Problem

Balancer's `batchSwap` requires the actual amount in the first swap step:

```javascript
// You encode this BEFORE execution:
const calldata = encode({
    swaps: [{ amount: ??? }]  // Don't know sDAI balance yet!
});
```

But the contract only knows its sDAI balance **after** split/merge.

### Why Hardcoded Works

```solidity
// Contract gets balance at runtime, then builds swap:
uint256 sdaiBalance = IERC20(sDAI).balanceOf(address(this));
swaps[0].amount = sdaiBalance;  // ← Real value!
balancerV2Vault.batchSwap(...);
```

### Why Calldata Fails

```javascript
// Calldata built in JS with amount: 0
const calldata = encode({ swaps: [{ amount: 0 }] });
// Balancer interprets 0 as "swap nothing" → fails
```

---

## Test Results

| Route | Type | Status | Notes |
|-------|------|--------|-------|
| 3-hop Hardcoded | Built on-chain | ✅ Works | Uses real balance |
| 3-hop Calldata | Pre-encoded | ❌ Fails | Amount unknown |
| 2-hop wstETH Calldata | Pre-encoded | ❌ Fails | Same issue |
| Direct Swapr Calldata | Pre-encoded | ❌ Fails | Pool may be illiquid |

---

## Solutions

### Option A: Route Spec (Recommended for V6)

Pass **route specification**, not calldata. Contract builds swap on-chain:

```solidity
struct BalancerRoute {
    bytes32[] poolIds;
    address[] assets;
}

function executeArbitrageWithRoute(
    ...,
    BalancerRoute calldata route
) external {
    uint256 balance = IERC20(route.assets[0]).balanceOf(address(this));
    // Contract builds batchSwap with real balance
}
```

**Pros**: Any Balancer route, amount known at runtime  
**Cons**: Only works for Balancer

### Option B: Simulation First

1. Simulate execution to get expected sDAI balance
2. Encode that amount into calldata
3. Execute with encoded calldata

**Pros**: Works for any protocol  
**Cons**: Complex, two-step process

### Option C: Keep Hardcoded + Add Routes

Keep hardcoded 3-hop as default, add new hardcoded routes (wstETH 2-hop) as enum options.

**Pros**: Simple, reliable  
**Cons**: Need redeploy for new routes

---

## Files

| File | Description |
|------|-------------|
| `contracts/GnosisFlashArbitrageV5.sol` | V5 with calldata support |
| `scripts/test-v5-calldata.js` | Test calldata execution |
| `scripts/test-v5-compare.js` | Compare routes |
| `scripts/test-v5-routes.js` | Multi-route comparison |
| `scripts/test-maxuint.js` | Test maxUint approach |

---

## Current Status

- V5 deployed at `0xca978e3BAaF184B18D8a5848Df8F38162e26cA88`
- Hardcoded 3-hop works ✅
- Calldata feature works mechanically (approvals + calls execute)
- **Blocker**: Balancer needs amount in calldata, unknown at encode time

---

## Recommendation

For production: **Use V4 or V5's hardcoded route**. It works reliably.

For experimentation: V6 with Route Spec would enable flexible Balancer routing without the calldata amount problem.
