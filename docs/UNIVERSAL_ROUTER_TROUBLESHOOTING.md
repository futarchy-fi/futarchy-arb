# Universal Router + Permit2 Troubleshooting Guide

> **Real debugging session: Why VLRFlashArbitrageV2 was reverting and how we fixed it**

---

## Summary

When migrating from legacy SwapRouter to Universal Router + Permit2, we encountered two critical issues:

1. **TRANSFER_FAILED** - Wrong `payerIsUser` flag
2. **Missing revert data** - Insufficient gas limit

Both were solved, resulting in a working contract achieving **1.6% profit**.

---

## How We Found the Errors

### Method 1: ethers.js Static Calls (What We Used)

Static calls simulate a transaction without broadcasting. They're the fastest way to test:

```javascript
const { ethers } = require('ethers');
require('dotenv').config();

const provider = new ethers.JsonRpcProvider('https://eth.llamarpc.com');
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);
const amount = ethers.parseEther('50');

// Simulate (no gas, no broadcast)
try {
    const result = await contract.executeArbitrage.staticCall(amount, 0, 0);
    console.log('SUCCESS:', result);
} catch(e) {
    console.log('Error:', e.shortMessage || e.reason);
    // First attempt: "execution reverted: TRANSFER_FAILED"
}
```

**Issue discovered:** `TRANSFER_FAILED` → Wrong `payerIsUser` flag.

After fixing, we still got errors:
```
❌ missing revert data
```

**Solution:** Add explicit gas limit:
```javascript
// With explicit gas - SUCCESS!
const result = await contract.executeArbitrage.staticCall(
    amount, 0, 0, 
    { gasLimit: 3000000 }  // ← Key fix!
);
console.log('SUCCESS:', result);
// Result(3) [ true, 815100745196254803n, 50000000000000000n ]
//            ^       ^                    ^
//          success   0.815 VLR profit     50 VLR borrowed
```

### Method 2: Tenderly Simulation (Alternative)

Tenderly provides visual transaction traces. Use when you need to see:
- Exact call stack
- Where in the call it failed
- State changes at each step

**Steps:**
1. Go to [dashboard.tenderly.co](https://dashboard.tenderly.co)
2. Click "Simulations" → "New Simulation"
3. Enter:
   - Network: Mainnet
   - Contract: Your deployed address
   - Function: `executeArbitrage`
   - Parameters: `borrowAmount`, `direction=0`, `minProfit=0`
   - From: Your wallet address
4. Click "Simulate"
5. View the execution trace to see exactly where it fails

**Example Tenderly trace for TRANSFER_FAILED:**
```
VLRFlashArbitrageV2.executeArbitrage()
  └── BalancerVault.flashLoan()
      └── VLRFlashArbitrageV2.receiveFlashLoan()
          └── FutarchyRouter.splitPosition() ✅
          └── UniversalRouter.execute()
              └── Permit2.transferFrom() ❌ TRANSFER_FAILED
```

This visual trace shows the failure happens at `Permit2.transferFrom()`, pointing to the approval/payer issue.

### Method 3: Etherscan Transaction Trace

For already-executed failed transactions:
1. Go to etherscan.io/tx/{txHash}
2. Click "Click to see More"
3. Look at "Revert Reason" or use "Parity Trace"

---

## Issue #1: TRANSFER_FAILED

### Symptom
```
50 VLR SPOT_SPLIT: ❌ execution reverted: "TRANSFER_FAILED"
100 VLR SPOT_SPLIT: ❌ execution reverted: "TRANSFER_FAILED"
```

### Root Cause

The Universal Router's `V3_SWAP_EXACT_IN` command has a `payerIsUser` boolean parameter:

```solidity
// V3_SWAP_EXACT_IN params encoding
abi.encode(recipient, amountIn, amountOutMinimum, path, payerIsUser)
```

**What each value means:**
- `payerIsUser = true`: Router pulls tokens from **msg.sender** via Permit2
- `payerIsUser = false`: Router uses tokens already **in the router's balance**

### The Bug (V2 Initial Deploy)

We set `payerIsUser = false`:

```solidity
// ❌ WRONG - This tells router to use its own balance (which is 0!)
bytes memory swapParams = abi.encode(
    address(this),  // recipient
    amountIn,
    0,
    path,
    false           // payerIsUser = false ← BUG!
);
```

Since the router has no tokens, `TRANSFER_FAILED`.

### The Fix

Changed to `payerIsUser = true`:

```solidity
// ✅ CORRECT - Router pulls from our contract via Permit2
bytes memory swapParams = abi.encode(
    address(this),  // recipient
    amountIn,
    0,
    path,
    true            // payerIsUser = true ← FIXED!
);
```

Now the router calls `permit2.transferFrom(msg.sender, pool, amount)` where `msg.sender` is our contract.

---

## Issue #2: Missing Revert Data

### Symptom
```
50 VLR SPOT_SPLIT: ❌ missing revert data
```

### Root Cause

The default gas estimation was too low for the complex multi-step transaction:
1. Flash loan callback
2. Split position (1M gas alone)
3. Multiple swaps via Universal Router
4. Merge positions
5. Final swap back

### The Fix

Explicitly set high gas limit:

```javascript
// ❌ WRONG - Uses default gas estimation
const result = await contract.executeArbitrage.staticCall(amount, 0, 0);

// ✅ CORRECT - Explicit high gas limit
const result = await contract.executeArbitrage.staticCall(amount, 0, 0, { gasLimit: 3000000 });
```

**Result:**
```
SUCCESS: Result(3) [ true, 815100745196254803n, 50000000000000000n ]
                    ↑      ↑                    ↑
                  success  0.815 VLR profit    50 VLR borrowed
```

---

## Universal Router + Permit2 Flow for Contracts

### Approval Setup (Constructor)

```solidity
constructor() {
    // Step 1: Token → Permit2 (standard ERC20 approve)
    IERC20(YES_VLR).approve(address(permit2), type(uint256).max);
    
    // Step 2: Permit2 → Router (Permit2's allowance system)
    permit2.approve(YES_VLR, address(universalRouter), MAX_UINT160, MAX_UINT48);
}
```

### Swap Execution

```solidity
function _swapExactInputUniversal(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn) internal {
    bytes memory path = abi.encodePacked(tokenIn, fee, tokenOut);
    
    bytes memory swapParams = abi.encode(
        address(this),  // recipient - send directly to contract
        amountIn,
        0,              // amountOutMinimum
        path,
        true            // payerIsUser = TRUE for contracts!
    );
    
    bytes memory commands = abi.encodePacked(V3_SWAP_EXACT_IN);
    bytes[] memory inputs = new bytes[](1);
    inputs[0] = swapParams;
    
    universalRouter.execute(commands, inputs, block.timestamp);
}
```

---

## Key Lessons

### 1. `payerIsUser` for Contracts

| Scenario | payerIsUser | Reason |
|----------|-------------|--------|
| EOA wallet calling | `true` | Router pulls from user's wallet via Permit2 |
| Contract calling | `true` | Router pulls from contract (msg.sender) via Permit2 |
| Tokens pre-sent to router | `false` | Router uses its internal balance |

**For flash arbitrage contracts, always use `payerIsUser = true`**.

### 2. Gas Limits

| Operation | Recommended Gas |
|-----------|-----------------|
| Split position | 1,000,000 |
| Single swap | 400,000 |
| Multi-hop swap | 500,000 |
| Full arbitrage | 3,000,000 |

### 3. Two-Step Permit2 Approval

```
Token → Permit2 (ERC20.approve)
    ↓
Permit2 → Router (Permit2.approve)
```

Both must be done in the constructor for contract-based swaps.

---

## Debugging Checklist

If you see `TRANSFER_FAILED`:
- [ ] Check `payerIsUser` flag (should be `true` for contracts)
- [ ] Verify Token → Permit2 approval exists
- [ ] Verify Permit2 → Router approval exists
- [ ] Confirm contract has token balance

If you see `missing revert data`:
- [ ] Increase gas limit to 3M+
- [ ] Use explicit `{ gasLimit: 3000000 }` in static calls

---

## Working Contract

**VLRFlashArbitrageV2:** [`0x4d6b0d01a3Ee9cE2cF731fcf7325ad835cB952A4`](https://etherscan.io/address/0x4d6b0d01a3Ee9cE2cF731fcf7325ad835cB952A4#code)

**Verified Results:**
| Amount | Profit | % |
|--------|--------|---|
| 100 VLR | 1.629 VLR | 1.62% |
| 500 VLR | 8.083 VLR | 1.61% |
| 1000 VLR | 16.00 VLR | 1.60% |

---

## Related Documentation

- [UNISWAP_V3_ULTIMATE_GUIDE.md](./UNISWAP_V3_ULTIMATE_GUIDE.md) - Full Uniswap V3 reference
- [UNISWAP_EXAMPLE.md](./UNISWAP_EXAMPLE.md) - Working code example
- [VLRFlashArbitrageV2.sol](../contracts/VLRFlashArbitrageV2.sol) - The fixed contract
