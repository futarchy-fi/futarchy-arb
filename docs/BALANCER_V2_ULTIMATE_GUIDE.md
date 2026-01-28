# Balancer V2 Ultimate Low-Level Guide

> **Pure contract-level interactions** — Based on production code from `GnosisFlashArbitrageV4.sol`
> 
> Works on **Gnosis Chain** and **Ethereum Mainnet** (same Vault address: `0xBA12222222228d8Ba445958a75a0704d566BF2C8`)


---

## Table of Contents

1. [Contract Addresses](#contract-addresses)
2. [Core Concepts](#core-concepts)
3. [Single Swap](#single-swap)
4. [Multi-Hop Batch Swap](#multi-hop-batch-swap)
5. [Complete ABIs](#complete-abis)
6. [Live Examples](#live-examples)
7. [JavaScript Implementation](#javascript-implementation)
8. [Comparison: V2 vs V3](#comparison-v2-vs-v3)

---

## Contract Addresses

### Gnosis Chain

| Contract | Address |
|----------|---------|
| **Vault** | `0xBA12222222228d8Ba445958a75a0704d566BF2C8` |

### Ethereum Mainnet

| Contract | Address |
|----------|---------|
| **Vault** | `0xBA12222222228d8Ba445958a75a0704d566BF2C8` |

> **Note:** Balancer V2 Vault has the same address on all chains!

### Check Flash Loan Availability

**Critical for arbitrage:** Check if a token has liquidity in the Vault before attempting flash loans.

```javascript
const { ethers } = require('ethers');

const V2_VAULT = '0xBA12222222228d8Ba445958a75a0704d566BF2C8';
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

async function checkFlashLoanAvailability(tokenAddress, provider) {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const vaultBalance = await token.balanceOf(V2_VAULT);
    
    console.log('Token balance in V2 Vault:', ethers.formatEther(vaultBalance));
    return vaultBalance;
}

// Example: Check VLR and USDS availability
const VLR = '0x4e107a0000DB66f0E9Fd2039288Bf811dD1f9c74';
const USDS = '0xdC035D45d973E3EC169d2276DDab16f1e407384F';

// Results (2026-01-28):
// VLR:  210,000,000 VLR ✅ (can flash borrow)
// USDS: 0 USDS ❌ (cannot flash borrow)
```

> [!IMPORTANT]
> **Why this matters:** Balancer V2 Vault holds all pool tokens centrally. The `balanceOf(VAULT)` shows total available for flash loans. If a token has 0 balance, you **cannot** flash borrow it - design your arbitrage strategy accordingly!

---

## Core Concepts

### Pool IDs (bytes32)

Unlike V3 which uses pool addresses, **V2 uses 32-byte Pool IDs**:

```
0x8189c4c96826d016a99986394103dfa9ae41e7ee0002000000000000000000aa
│                                          │              │
└──────── Pool Address ────────────────────┴── Type ──────┴── Index
```

- First 20 bytes: Pool contract address
- Next 2 bytes: Pool type
- Last 10 bytes: Pool registration index

### Asset Array (address[])

All tokens involved in swaps must be in a single `assets` array. Steps reference tokens by their **index** in this array.

### SwapKind Enum

```solidity
enum SwapKind { 
    GIVEN_IN,   // You specify exact input, receive variable output
    GIVEN_OUT   // You specify exact output, pay variable input
}
```

### FundManagement Struct

```solidity
struct FundManagement {
    address sender;              // Who tokens come from
    bool fromInternalBalance;    // Use Vault internal balance?
    address payable recipient;   // Who receives output
    bool toInternalBalance;      // Send to internal balance?
}
```

For most swaps:
```javascript
{
  sender: yourAddress,
  fromInternalBalance: false,
  recipient: yourAddress,
  toInternalBalance: false
}
```

---

## Single Swap

For simple A → B swaps through a single pool.

### Vault Function: `swap`

```solidity
function swap(
    SingleSwap memory singleSwap,
    FundManagement memory funds,
    uint256 limit,           // minAmountOut for GIVEN_IN, maxAmountIn for GIVEN_OUT
    uint256 deadline
) external payable returns (uint256 amountCalculated);

struct SingleSwap {
    bytes32 poolId;
    SwapKind kind;
    address assetIn;
    address assetOut;
    uint256 amount;
    bytes userData;      // Usually empty ""
}
```

### Example: Single Swap

```javascript
const VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";

const singleSwap = {
  poolId: "0x8189c4c96826d016a99986394103dfa9ae41e7ee0002000000000000000000aa",
  kind: 0, // GIVEN_IN
  assetIn: GNO_ADDRESS,
  assetOut: WXDAI_ADDRESS,
  amount: ethers.parseUnits("1", 18),
  userData: "0x"
};

const funds = {
  sender: userAddress,
  fromInternalBalance: false,
  recipient: userAddress,
  toInternalBalance: false
};

const minAmountOut = ethers.parseUnits("100", 18); // Slippage protection
const deadline = Math.floor(Date.now() / 1000) + 3600;

await vault.swap(singleSwap, funds, minAmountOut, deadline);
```

---

## Multi-Hop Batch Swap

For complex routes through multiple pools: A → B → C → D

### Vault Function: `batchSwap`

```solidity
function batchSwap(
    SwapKind kind,
    BatchSwapStep[] memory swaps,
    address[] memory assets,
    FundManagement memory funds,
    int256[] memory limits,
    uint256 deadline
) external payable returns (int256[] memory assetDeltas);

struct BatchSwapStep {
    bytes32 poolId;          // Pool to swap through
    uint256 assetInIndex;    // Index in assets array
    uint256 assetOutIndex;   // Index in assets array
    uint256 amount;          // Amount (0 = use output from previous step)
    bytes userData;          // Usually empty ""
}
```

### Key Concepts

1. **`assets` array**: All tokens referenced by index
2. **First step `amount`**: Set to actual input amount
3. **Subsequent step `amount`**: Set to `0` to use output from previous step
4. **`limits` array**: Signed integers for slippage protection
   - Positive = max you'll send
   - Negative = min you'll receive
   - Use `type(int256).max` for intermediates

### Example: 3-Hop Swap (GNO → WXDAI → USDC → sDAI)

From `GnosisFlashArbitrageV4.sol`:

```solidity
function _swapGnoToSdaiV2(uint256 amount) internal {
    // Define all assets in order
    address[] memory assets = new address[](4);
    assets[0] = gnoToken;                                    // Index 0
    assets[1] = 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d; // WXDAI (Index 1)
    assets[2] = 0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83; // USDC (Index 2)
    assets[3] = sdaiToken;                                   // Index 3

    // Define swap steps
    IBalancerV2Vault.BatchSwapStep[] memory swaps = new IBalancerV2Vault.BatchSwapStep[](3);
    
    // Step 1: GNO → WXDAI
    swaps[0] = IBalancerV2Vault.BatchSwapStep({
        poolId: 0x8189c4c96826d016a99986394103dfa9ae41e7ee0002000000000000000000aa,
        assetInIndex: 0,     // GNO
        assetOutIndex: 1,    // WXDAI
        amount: amount,      // Exact input amount
        userData: ""
    });
    
    // Step 2: WXDAI → USDC
    swaps[1] = IBalancerV2Vault.BatchSwapStep({
        poolId: 0x2086f52651837600180de173b09470f54ef7491000000000000000000000004f,
        assetInIndex: 1,     // WXDAI
        assetOutIndex: 2,    // USDC
        amount: 0,           // Use ALL output from step 1
        userData: ""
    });

    // Step 3: USDC → sDAI
    swaps[2] = IBalancerV2Vault.BatchSwapStep({
        poolId: 0x7644fa5d0ea14fcf3e813fdf93ca9544f8567655000000000000000000000066,
        assetInIndex: 2,     // USDC
        assetOutIndex: 3,    // sDAI
        amount: 0,           // Use ALL output from step 2
        userData: ""
    });

    // Fund management
    IBalancerV2Vault.FundManagement memory funds = IBalancerV2Vault.FundManagement({
        sender: address(this),
        fromInternalBalance: false,
        recipient: payable(address(this)),
        toInternalBalance: false
    });

    // Limits: positive = max send, use max for intermediates
    int256[] memory limits = new int256[](4);
    limits[0] = int256(amount);      // Max GNO to send
    limits[1] = type(int256).max;    // WXDAI (intermediate)
    limits[2] = type(int256).max;    // USDC (intermediate)
    limits[3] = type(int256).max;    // sDAI output (no min set here)

    // Approve and execute
    IERC20(gnoToken).approve(address(balancerV2Vault), amount);
    balancerV2Vault.batchSwap(
        IBalancerV2Vault.SwapKind.GIVEN_IN,
        swaps,
        assets,
        funds,
        limits,
        block.timestamp
    );
}
```

### Visual Representation

```
┌─────────────────────────────────────────────────────────────────┐
│                    BATCH SWAP: GNO → sDAI                       │
└─────────────────────────────────────────────────────────────────┘

assets[] = [GNO, WXDAI, USDC, sDAI]
             0     1      2     3

Step 1: Pool 0x8189...   GNO(0) ──────▶ WXDAI(1)   amount: 1 ETH
                              │
Step 2: Pool 0x2086...        └────────▶ USDC(2)   amount: 0 (use step1 output)
                                    │
Step 3: Pool 0x7644...              └──▶ sDAI(3)   amount: 0 (use step2 output)
```

---

## Complete ABIs

### Vault (V2)

```javascript
const BALANCER_V2_VAULT_ABI = [
  // Single swap
  `function swap(
    (bytes32 poolId, uint8 kind, address assetIn, address assetOut, uint256 amount, bytes userData) singleSwap,
    (address sender, bool fromInternalBalance, address recipient, bool toInternalBalance) funds,
    uint256 limit,
    uint256 deadline
  ) external payable returns (uint256)`,

  // Multi-hop batch swap
  `function batchSwap(
    uint8 kind,
    (bytes32 poolId, uint256 assetInIndex, uint256 assetOutIndex, uint256 amount, bytes userData)[] swaps,
    address[] assets,
    (address sender, bool fromInternalBalance, address recipient, bool toInternalBalance) funds,
    int256[] limits,
    uint256 deadline
  ) external payable returns (int256[])`,

  // Query (dry run without execution)
  `function queryBatchSwap(
    uint8 kind,
    (bytes32 poolId, uint256 assetInIndex, uint256 assetOutIndex, uint256 amount, bytes userData)[] swaps,
    address[] assets,
    (address sender, bool fromInternalBalance, address recipient, bool toInternalBalance) funds
  ) external returns (int256[])`,

  // Pool info
  `function getPoolTokens(bytes32 poolId) external view returns (
    address[] tokens,
    uint256[] balances,
    uint256 lastChangeBlock
  )`,

  // Pool registration
  `function getPool(bytes32 poolId) external view returns (address, uint8)`
];
```

### SwapKind Constants

```javascript
const SwapKind = {
  GIVEN_IN: 0,   // Exact input, variable output
  GIVEN_OUT: 1   // Variable input, exact output
};
```

---

## Live Examples

### Example 1: GNO → sDAI (3-hop) on Gnosis Chain

**Tokens:**
| Token | Address | Decimals |
|-------|---------|----------|
| GNO | `0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb` | 18 |
| WXDAI | `0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d` | 18 |
| USDC | `0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83` | 6 |
| sDAI | `0xaf204776c7245bF4147c2612BF6e5972Ee483701` | 18 |

**Pool IDs:**
| Route | Pool ID |
|-------|---------|
| GNO ↔ WXDAI | `0x8189c4c96826d016a99986394103dfa9ae41e7ee0002000000000000000000aa` |
| WXDAI ↔ USDC | `0x2086f52651837600180de173b09470f54ef7491000000000000000000000004f` |
| USDC ↔ sDAI | `0x7644fa5d0ea14fcf3e813fdf93ca9544f8567655000000000000000000000066` |

### Example 2: Reverse Path (sDAI → GNO)

```solidity
// sDAI → USDC → WXDAI → GNO
address[] memory assets = new address[](4);
assets[0] = sdaiToken;  // Index 0 (input)
assets[1] = USDC;       // Index 1
assets[2] = WXDAI;      // Index 2
assets[3] = gnoToken;   // Index 3 (output)

// Note: Steps reference the NEW indices
swaps[0] = { poolId: sDAI_USDC_POOL, assetInIndex: 0, assetOutIndex: 1, amount: inputAmount, userData: "" };
swaps[1] = { poolId: USDC_WXDAI_POOL, assetInIndex: 1, assetOutIndex: 2, amount: 0, userData: "" };
swaps[2] = { poolId: WXDAI_GNO_POOL, assetInIndex: 2, assetOutIndex: 3, amount: 0, userData: "" };
```

---

### Example 3: GHO → AAVE (3-hop) on Ethereum Mainnet ✅ VERIFIED

**TX:** [`0x56a9a03afe84c964bffc2d395df57a70f04eee0519b207cb01f974ae161b3e94`](https://etherscan.io/tx/0x56a9a03afe84c964bffc2d395df57a70f04eee0519b207cb01f974ae161b3e94)

**Result:** 1 GHO ($1.00) → 0.006281 AAVE ($0.99)

**Tokens:**
| Token | Symbol | Address | Decimals |
|-------|--------|---------|----------|
| GHO | GHO | `0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f` | 18 |
| GYD | (intermediate) | `0xe07F9D810a48ab5c3c914BA3cA53AF14E4491e8A` | 18 |
| wstETH | (intermediate) | `0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0` | 18 |
| AAVE | AAVE | `0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9` | 18 |

**Pool IDs:**
| Route | Pool ID |
|-------|---------|
| GHO ↔ GYD | `0xaa7a70070e7495fe86c67225329dbd39baa2f63b000200000000000000000663` |
| GYD ↔ wstETH | `0xc8cf54b0b70899ea846b70361e62f3f5b22b1f4b0002000000000000000006c7` |
| wstETH ↔ AAVE | `0x3de27efa2f1aa663ae5d458857e731c129069f29000200000000000000000588` |

**Calldata Breakdown:**
```javascript
// Assets array (order matters!)
const assets = [
  "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f",  // [0] GHO (input)
  "0xe07F9D810a48ab5c3c914BA3cA53AF14E4491e8A",  // [1] GYD (intermediate)
  "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",  // [2] wstETH (intermediate)
  "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9"   // [3] AAVE (output)
];

// Swap steps
const swaps = [
  {
    poolId: "0xaa7a70070e7495fe86c67225329dbd39baa2f63b000200000000000000000663",
    assetInIndex: 0,                    // GHO
    assetOutIndex: 1,                   // GYD
    amount: 1000000000000000000n,       // 1 GHO (first step has amount)
    userData: "0x"
  },
  {
    poolId: "0xc8cf54b0b70899ea846b70361e62f3f5b22b1f4b0002000000000000000006c7",
    assetInIndex: 1,                    // GYD
    assetOutIndex: 2,                   // wstETH
    amount: 0n,                         // Use output from step 1
    userData: "0x"
  },
  {
    poolId: "0x3de27efa2f1aa663ae5d458857e731c129069f29000200000000000000000588",
    assetInIndex: 2,                    // wstETH
    assetOutIndex: 3,                   // AAVE
    amount: 0n,                         // Use output from step 2
    userData: "0x"
  }
];

// Limits (slippage protection)
const limits = [
  1000000000000000000n,   // [0] Max GHO to send (1 GHO)
  0n,                      // [1] GYD intermediate
  0n,                      // [2] wstETH intermediate  
  -6250363691911400n       // [3] Min AAVE to receive (negative = output)
];

// Fund management
const funds = {
  sender: userAddress,
  fromInternalBalance: false,
  recipient: userAddress,
  toInternalBalance: false
};

// Execute
await vault.batchSwap(
  0,                         // GIVEN_IN
  swaps,
  assets,
  funds,
  limits,
  9007199254740991n         // Max safe integer deadline
);
```

**Visual Path:**
```
GHO ──[Pool 0xaa7a]──► GYD ──[Pool 0xc8cf]──► wstETH ──[Pool 0x3de2]──► AAVE
 1.0                                                                   0.00628
```

## JavaScript Implementation

### Complete Multi-Hop Swap Function

```javascript
const { ethers } = require("ethers");

const VAULT_ADDRESS = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";

const VAULT_ABI = [
  `function batchSwap(
    uint8 kind,
    (bytes32 poolId, uint256 assetInIndex, uint256 assetOutIndex, uint256 amount, bytes userData)[] swaps,
    address[] assets,
    (address sender, bool fromInternalBalance, address recipient, bool toInternalBalance) funds,
    int256[] limits,
    uint256 deadline
  ) external payable returns (int256[])`
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)"
];

/**
 * Execute a multi-hop batch swap on Balancer V2
 * @param signer - Ethers signer
 * @param route - Array of { poolId, tokenIn, tokenOut }
 * @param amountIn - Input amount (BigInt)
 * @param minAmountOut - Minimum output (slippage protection)
 */
async function batchSwapV2(signer, route, amountIn, minAmountOut) {
  const userAddress = await signer.getAddress();
  
  // Build assets array (unique tokens in order)
  const assets = [route[0].tokenIn];
  for (const step of route) {
    if (!assets.includes(step.tokenOut)) {
      assets.push(step.tokenOut);
    }
  }
  
  // Build swaps array
  const swaps = route.map((step, i) => ({
    poolId: step.poolId,
    assetInIndex: assets.indexOf(step.tokenIn),
    assetOutIndex: assets.indexOf(step.tokenOut),
    amount: i === 0 ? amountIn : 0n,  // Only first step has amount
    userData: "0x"
  }));
  
  // Fund management
  const funds = {
    sender: userAddress,
    fromInternalBalance: false,
    recipient: userAddress,
    toInternalBalance: false
  };
  
  // Limits: max send for input, max for intermediates, min receive for output
  const limits = assets.map((_, i) => {
    if (i === 0) return amountIn;  // Max input
    if (i === assets.length - 1) return -minAmountOut;  // Min output (negative)
    return ethers.MaxInt256;  // Intermediates
  });
  
  // Approve input token
  const inputToken = new ethers.Contract(assets[0], ERC20_ABI, signer);
  const currentAllowance = await inputToken.allowance(userAddress, VAULT_ADDRESS);
  if (currentAllowance < amountIn) {
    console.log("Approving token to Vault...");
    await (await inputToken.approve(VAULT_ADDRESS, ethers.MaxUint256)).wait();
  }
  
  // Execute swap
  const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, signer);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  
  console.log("Executing batch swap...");
  console.log(`  Route: ${assets.map(a => a.slice(0, 10)).join(" → ")}`);
  
  const tx = await vault.batchSwap(
    0,  // GIVEN_IN
    swaps,
    assets,
    funds,
    limits,
    deadline
  );
  
  const receipt = await tx.wait();
  console.log(`  TX: ${tx.hash}`);
  return receipt;
}

// Usage example: GNO → sDAI on Gnosis
async function exampleGnoToSdai(signer) {
  const route = [
    {
      poolId: "0x8189c4c96826d016a99986394103dfa9ae41e7ee0002000000000000000000aa",
      tokenIn: "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb",  // GNO
      tokenOut: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d" // WXDAI
    },
    {
      poolId: "0x2086f52651837600180de173b09470f54ef7491000000000000000000000004f",
      tokenIn: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d",  // WXDAI
      tokenOut: "0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83" // USDC
    },
    {
      poolId: "0x7644fa5d0ea14fcf3e813fdf93ca9544f8567655000000000000000000000066",
      tokenIn: "0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83",  // USDC
      tokenOut: "0xaf204776c7245bF4147c2612BF6e5972Ee483701" // sDAI
    }
  ];

  const amountIn = ethers.parseUnits("1", 18);  // 1 GNO
  const minAmountOut = ethers.parseUnits("100", 18);  // Min 100 sDAI

  await batchSwapV2(signer, route, amountIn, minAmountOut);
}
```

---

## Query Before Swap (Dry Run)

Query to simulate swap without executing:

```javascript
const QUERY_ABI = [
  `function queryBatchSwap(
    uint8 kind,
    (bytes32 poolId, uint256 assetInIndex, uint256 assetOutIndex, uint256 amount, bytes userData)[] swaps,
    address[] assets,
    (address sender, bool fromInternalBalance, address recipient, bool toInternalBalance) funds
  ) external returns (int256[])`
];

async function querySwap(provider, route, amountIn) {
  const vault = new ethers.Contract(VAULT_ADDRESS, QUERY_ABI, provider);
  
  // Build assets and swaps same as above...
  
  const deltas = await vault.queryBatchSwap.staticCall(
    0,  // GIVEN_IN
    swaps,
    assets,
    funds  // No limits/deadline for query
  );
  
  // deltas[0] = positive = amount sent
  // deltas[last] = negative = amount received
  console.log(`Input: ${deltas[0]}`);
  console.log(`Output: ${-deltas[deltas.length - 1]}`);
  
  return deltas;
}
```

---

## Comparison: V2 vs V3

| Feature | Balancer V2 | Balancer V3 |
|---------|-------------|-------------|
| **Pool Identifier** | `bytes32 poolId` | `address pool` |
| **Single Swap** | `swap()` | `swapSingleTokenExactIn()` |
| **Multi-Hop** | `batchSwap()` | `swapExactIn()` with steps |
| **Token References** | Index in `assets[]` | Direct addresses |
| **Boosted Pools** | Not applicable | Uses `isBuffer` flag |
| **Approval Pattern** | Direct to Vault | Via Permit2 |
| **Vault Address** | Same on all chains | Different per chain |
| **Query Function** | `queryBatchSwap()` | `quote()` |

### When to Use V2 vs V3

| Use V2 | Use V3 |
|--------|--------|
| Gnosis Chain (most pools) | Ethereum Mainnet (newer pools) |
| Legacy pool integrations | Boosted/ERC-4626 pools |
| Flash loans (Gnosis) | Permit2 approval pattern |
| Multi-hop through existing V2 pools | New deployments |

---

## Approval Pattern (V2 vs V3)

### V2: Direct Approval to Vault

```javascript
// Simple: just approve the Vault
await token.approve(VAULT_ADDRESS, amount);
await vault.swap(...);
```

### V3: Permit2 Flow

```javascript
// Two-step: Token → Permit2 → Router
await token.approve(PERMIT2, MaxUint256);
await permit2.approve(token, ROUTER, amount, expiration);
await router.swapSingleTokenExactIn(...);
```

---

## Finding Pool IDs

### From Subgraph

```graphql
{
  pools(where: { tokensList_contains: ["0xTokenA", "0xTokenB"] }) {
    id
    name
    tokens {
      address
      symbol
    }
  }
}
```

### From Balancer UI

1. Go to balancer.fi/pools
2. Find pool
3. Pool ID is in URL or pool details

### Common Gnosis Chain Pools

| Pool | ID |
|------|-----|
| GNO/WXDAI | `0x8189c4c96826d016a99986394103dfa9ae41e7ee0002000000000000000000aa` |
| WXDAI/USDC | `0x2086f52651837600180de173b09470f54ef7491000000000000000000000004f` |
| USDC/sDAI | `0x7644fa5d0ea14fcf3e813fdf93ca9544f8567655000000000000000000000066` |

---

## Test Scripts

Ready-to-use scripts demonstrating Balancer V2 batch swaps with gas cost checking:

### GHO → AAVE (Forward)

**Script:** [`scripts/execute-balancer-v2-swap.js`](file:///home/arthur/futarchy-arb/scripts/execute-balancer-v2-swap.js)

```bash
node scripts/execute-balancer-v2-swap.js
```

**Verified TX:** [`0xf708ea9c3e326b4030d3d3c3cf65652ca5df0cd7ae31afd83af485a762ad8f68`](https://etherscan.io/tx/0xf708ea9c3e326b4030d3d3c3cf65652ca5df0cd7ae31afd83af485a762ad8f68)

| Input | Output | Gas Used | Gas Cost |
|-------|--------|----------|----------|
| 1 GHO | 0.006256 AAVE | ~316k | ~$0.13 |

---

### AAVE → GHO (Reverse)

**Script:** [`scripts/execute-balancer-v2-reverse.js`](file:///home/arthur/futarchy-arb/scripts/execute-balancer-v2-reverse.js)

```bash
node scripts/execute-balancer-v2-reverse.js
```

**Verified TX:** [`0xaa6cfbeb2a2ec90c2074cacfd829df23c52a5ab01b829fa35b36500d41423428`](https://etherscan.io/tx/0xaa6cfbeb2a2ec90c2074cacfd829df23c52a5ab01b829fa35b36500d41423428)

| Input | Output | Gas Used | Gas Cost |
|-------|--------|----------|----------|
| 0.012 AAVE | 1.89 GHO | ~316k | ~$0.16 |

---

### Round-Trip Analysis

```
Forward:  2 GHO  → 0.01254 AAVE
Reverse:  0.012 AAVE → 1.89 GHO
─────────────────────────────────
Slippage + Fees: ~0.11 GHO (~5.5%)
Total Gas: ~$0.30
```

> [!TIP]
> These scripts include gas threshold checks. Set `MAX_SWAP_COST_USD` and `MAX_APPROVAL_COST_USD` in the script to control execution based on gas prices.

---

## Summary

| Task | Function | Key Parameters |
|------|----------|----------------|
| Single A→B swap | `vault.swap()` | poolId, assetIn, assetOut, amount |
| Multi-hop A→B→C | `vault.batchSwap()` | swaps[], assets[], limits[] |
| Dry run query | `vault.queryBatchSwap()` | Same as batchSwap, no limits |
| Get pool tokens | `vault.getPoolTokens()` | poolId |

