# Balancer V3 Swap Flow with Permit2

## Overview

Swap two ERC20 tokens (e.g., AAVE ↔ GHO) on Balancer V3 using Permit2 approvals.

## Key Addresses (Ethereum Mainnet)

| Contract | Address |
|----------|---------|
| **Balancer V3 Router** | `0xAE563E3f8219521950555F5962419C8919758Ea2` |
| **Balancer V3 Vault** | `0xbA1333333333a1BA1108E8412f11850A5C319bA9` |
| **Permit2** | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| **AAVE Token** | `0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9` |
| **GHO Token** | `0x40D16FC02446E4893512e38ee0d20955BB172775` |
| **AAVE-GHO Pool** | `0x85b2b559bc2d21104c4defdd6efca8a20343361d` |

## Architecture

```
User → Router → Vault → Pool
        ↑
     Permit2 (approvals)
```

- **Router**: Stateless entry point for swaps (recommended)
- **Vault**: Stateful core contract holding all token balances
- **Permit2**: Handles off-chain signature-based approvals

---

## Step-by-Step Flow

### Step 1: One-Time ERC20 → Permit2 Approval

Approve Permit2 to spend your tokens (only done once per token):

```javascript
const token = new ethers.Contract(TOKEN_ADDRESS, ERC20_ABI, signer);
await token.approve(PERMIT2_ADDRESS, ethers.MaxUint256);
```

### Step 2: Sign Permit2 Message

Create and sign a Permit2 message to authorize the Balancer Router:

```javascript
const permit2 = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, provider);

// Get current nonce
const [, , nonce] = await permit2.allowance(userAddress, TOKEN_ADDRESS, ROUTER_ADDRESS);

// Create permit details
const permitDetails = {
  token: TOKEN_ADDRESS,
  amount: ethers.MaxUint160,  // uint160 max
  expiration: Math.floor(Date.now() / 1000) + 86400 * 30, // 30 days
  nonce: nonce
};

const permit2Batch = {
  details: [permitDetails],
  spender: ROUTER_ADDRESS,
  sigDeadline: Math.floor(Date.now() / 1000) + 3600 // 1 hour
};

// Sign using EIP-712
const signature = await signer.signTypedData(domain, types, permit2Batch);
```

### Step 3: Build Swap Calldata

Encode the swap function call:

```javascript
const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, signer);

const swapData = router.interface.encodeFunctionData("swapSingleTokenExactIn", [
  POOL_ADDRESS,           // pool
  TOKEN_IN,               // tokenIn
  TOKEN_OUT,              // tokenOut
  amountIn,               // exactAmountIn
  minAmountOut,           // minAmountOut (slippage protection)
  deadline,               // deadline (unix timestamp)
  false,                  // wethIsEth
  "0x"                    // userData (empty for standard swaps)
]);
```

### Step 4: Execute permitBatchAndCall

Combine Permit2 approval + swap in one transaction:

```javascript
const tx = await router.permitBatchAndCall(
  [],                     // permitBatch (empty if not using EIP-2612)
  [],                     // permitSignatures (empty)
  permit2Batch,           // Permit2 batch struct
  permit2Signature,       // Signed Permit2 message
  [swapData]              // Encoded swap calldata
);

await tx.wait();
```

---

## Alternative: Simple Swap (Pre-Approved)

If you've already done Step 1 & 2 (or using traditional approvals):

```javascript
// Direct swap call (requires prior approval to Router via Permit2)
const tx = await router.swapSingleTokenExactIn(
  POOL_ADDRESS,
  TOKEN_IN,
  TOKEN_OUT,
  amountIn,
  minAmountOut,
  deadline,
  false,  // wethIsEth
  "0x"    // userData
);
```

---

## Router Functions Summary

| Function | Use Case |
|----------|----------|
| `swapSingleTokenExactIn` | Swap exact amount of tokenIn for tokenOut |
| `swapSingleTokenExactOut` | Swap tokenIn to get exact amount of tokenOut |
| `permitBatchAndCall` | Combine Permit2 + any operation atomically |
| `querySwapSingleTokenExactIn` | Get quote (read-only) |

---

## Gas Estimates

| Operation | Estimated Gas |
|-----------|---------------|
| ERC20 → Permit2 Approval | ~46,000 |
| Permit2 → Router Approval | ~48,000 |
| Swap via Router | ~150,000-200,000 |
| `permitBatchAndCall` (all-in-one) | ~200,000-250,000 |

---

## EIP-712 Domain for Permit2

```javascript
const domain = {
  name: "Permit2",
  chainId: 1,  // Ethereum Mainnet
  verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3"
};

const types = {
  PermitBatch: [
    { name: "details", type: "PermitDetails[]" },
    { name: "spender", type: "address" },
    { name: "sigDeadline", type: "uint256" }
  ],
  PermitDetails: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint160" },
    { name: "expiration", type: "uint48" },
    { name: "nonce", type: "uint48" }
  ]
};
```

---

## Key Differences: Router vs Vault

| Aspect | Router | Vault |
|--------|--------|-------|
| **State** | Stateless (no funds) | Stateful (holds all tokens) |
| **Use** | User entry point | Internal execution |
| **Functions** | High-level (swap, addLiquidity) | Low-level (swap, settle) |
| **Upgradable** | Yes (deploy new version) | No (permanent) |

> **Best Practice**: Always use the Router for swaps. Only call the Vault directly for flash loans (`vault.unlock()`).

---

## References

- [Balancer V3 Developer Docs](https://docs.balancer.fi/developer-reference/v3/)
- [Permit2 by Uniswap](https://github.com/Uniswap/permit2)
- [Router ABI Source](https://etherscan.io/address/0xAE563E3f8219521950555F5962419C8919758Ea2#code)
