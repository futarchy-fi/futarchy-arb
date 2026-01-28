# Balancer V3 Ultimate Low-Level Guide

> **Pure contract-level interactions** — No SDK, No API, just ABIs and direct calls.

---

## Table of Contents

1. [Contract Addresses](#contract-addresses)
2. [When to Use Which Router](#when-to-use-which-router)
3. [Direct Pools (Standard Swap)](#direct-pools-standard-swap)
4. [Boosted Pools (Wrapped Tokens)](#boosted-pools-wrapped-tokens)
5. [Flash Loans (V2 vs V3)](#flash-loans-v2-vs-v3)
6. [Complete ABIs](#complete-abis)
7. [Permit2 Integration](#permit2-integration)
8. [Live Examples](#live-examples)
9. [Troubleshooting](#troubleshooting)

---

## Contract Addresses

### Ethereum Mainnet

| Contract | Address | Purpose |
|----------|---------|---------|
| **Vault** | `0xbA1333333333a1BA1108E8412f11850A5C319bA9` | Core (holds all tokens) |
| **Router** | `0xAE563E3f8219521950555F5962419C8919758Ea2` | Standard swaps (direct pools) |
| **BatchRouter** | `0x136f1EFcC3f8f88516B9E94110D56FDBfB1778d1` | Multi-step swaps (boosted) |
| **CompositeLiquidityRouter** | `0xb21A277415c8A9A8c1F32f2388C9B6F8A6C8BB3C` | Liquidity with underlying |
| **Permit2** | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Gasless approvals |

---

## When to Use Which Router

```
┌─────────────────────────────────────────────────────────────────┐
│                    WHAT TYPE OF POOL?                           │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │                               │
              ▼                               ▼
     ┌─────────────────┐            ┌─────────────────┐
     │  DIRECT POOL    │            │  BOOSTED POOL   │
     │  (raw tokens)   │            │  (wrapped ERC-4626) │
     └─────────────────┘            └─────────────────┘
              │                               │
              ▼                               ▼
     ┌─────────────────┐            ┌─────────────────┐
     │   Use Router    │            │ Use BatchRouter │
     │ swapSingleToken │            │  swapExactIn    │
     │    ExactIn()    │            │  with buffers   │
     └─────────────────┘            └─────────────────┘
```

### How to Identify Pool Type

```javascript
// Check if pool tokens are ERC-4626 (wrapped)
async function isERC4626(tokenAddress, provider) {
  const contract = new ethers.Contract(tokenAddress, [
    "function asset() view returns (address)"
  ], provider);
  
  try {
    const underlying = await contract.asset();
    return { isWrapped: true, underlying };
  } catch {
    return { isWrapped: false, underlying: null };
  }
}

// Get pool tokens from Vault
async function getPoolTokens(vault, poolAddress) {
  const tokens = await vault.getPoolTokens(poolAddress);
  return tokens; // Array of token addresses
}
```

---

## Direct Pools (Standard Swap)

### What You Need

| Requirement | How to Get |
|-------------|-----------|
| **Pool address** | From Balancer UI, subgraph, or factory events |
| **TokenIn address** | Known |
| **TokenOut address** | Known |
| **Amount** | User input |

### Router: `swapSingleTokenExactIn`

```solidity
function swapSingleTokenExactIn(
    address pool,           // Pool address
    IERC20 tokenIn,         // Input token
    IERC20 tokenOut,        // Output token
    uint256 exactAmountIn,  // Exact input amount
    uint256 minAmountOut,   // Minimum output (slippage protection)
    uint256 deadline,       // Unix timestamp
    bool wethIsEth,         // true if wrapping/unwrapping ETH
    bytes calldata userData // Usually empty "0x"
) external payable returns (uint256 amountOut)
```

### Complete Direct Swap Example

```javascript
const { ethers } = require("ethers");

// Contract Setup
const ROUTER = "0xAE563E3f8219521950555F5962419C8919758Ea2";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const ROUTER_ABI = [
  `function swapSingleTokenExactIn(
    address pool,
    address tokenIn,
    address tokenOut,
    uint256 exactAmountIn,
    uint256 minAmountOut,
    uint256 deadline,
    bool wethIsEth,
    bytes userData
  ) external payable returns (uint256)`
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)"
];

const PERMIT2_ABI = [
  "function allowance(address, address, address) view returns (uint160, uint48, uint48)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)"
];

async function directPoolSwap(signer, params) {
  const { 
    pool, 
    tokenIn, 
    tokenOut, 
    amountIn, 
    slippagePercent 
  } = params;

  // Step 1: Approve tokenIn to Permit2 (one-time)
  const token = new ethers.Contract(tokenIn, ERC20_ABI, signer);
  const permit2 = new ethers.Contract(PERMIT2, PERMIT2_ABI, signer);
  
  const allowance = await token.allowance(signer.address, PERMIT2);
  if (allowance < amountIn) {
    console.log("Approving token to Permit2...");
    const tx1 = await token.approve(PERMIT2, ethers.MaxUint256);
    await tx1.wait();
  }

  // Step 2: Approve Permit2 to Router (one-time per token/router)
  const [p2Amount, p2Exp] = await permit2.allowance(signer.address, tokenIn, ROUTER);
  if (p2Amount < amountIn || p2Exp <= Math.floor(Date.now()/1000)) {
    console.log("Approving Permit2 to Router...");
    const tx2 = await permit2.approve(
      tokenIn,
      ROUTER,
      ethers.MaxUint256 >> 96n,  // Max amount (fits uint160)
      281474976710655n           // Max expiration (fits uint48)
    );
    await tx2.wait();
  }

  // Step 3: Execute swap
  const router = new ethers.Contract(ROUTER, ROUTER_ABI, signer);
  const minAmountOut = amountIn * BigInt(100 - slippagePercent) / 100n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);

  console.log("Executing swap...");
  const tx3 = await router.swapSingleTokenExactIn(
    pool,
    tokenIn,
    tokenOut,
    amountIn,
    minAmountOut,
    deadline,
    false,  // wethIsEth
    "0x"    // userData
  );
  
  const receipt = await tx3.wait();
  console.log(`Swap complete! TX: ${tx3.hash}`);
  return receipt;
}
```

---

## Boosted Pools (Wrapped Tokens)

### What You Need

| Requirement | How to Get |
|-------------|-----------|
| **Pool address** | From Balancer UI/subgraph |
| **TokenIn (raw)** | Known (e.g., GHO) |
| **TokenOut (raw)** | Known (e.g., USDC) |
| **Wrapped TokenIn** | Query pool tokens, then `asset()` to match |
| **Wrapped TokenOut** | Query pool tokens, then `asset()` to match |
| **Amount** | User input |

### Identifying Wrapped Tokens

```javascript
async function findWrappedTokens(poolAddress, tokenIn, tokenOut, provider) {
  // Get pool tokens from Vault
  const vault = new ethers.Contract(
    "0xbA1333333333a1BA1108E8412f11850A5C319bA9",
    ["function getPoolTokens(address) view returns (address[])"],
    provider
  );
  
  const poolTokens = await vault.getPoolTokens(poolAddress);
  
  let wrappedIn = null;
  let wrappedOut = null;
  
  for (const wToken of poolTokens) {
    const result = await isERC4626(wToken, provider);
    if (result.isWrapped) {
      if (result.underlying.toLowerCase() === tokenIn.toLowerCase()) {
        wrappedIn = wToken;
      }
      if (result.underlying.toLowerCase() === tokenOut.toLowerCase()) {
        wrappedOut = wToken;
      }
    }
  }
  
  return { wrappedIn, wrappedOut };
}
```

### BatchRouter: `swapExactIn`

```solidity
struct SwapPathStep {
    address pool;       // Pool/buffer address
    address tokenOut;   // Output of this step
    bool isBuffer;      // true = wrap/unwrap via ERC-4626 buffer
}

struct SwapPathExactAmountIn {
    address tokenIn;              // Starting token
    SwapPathStep[] steps;         // Path steps
    uint256 exactAmountIn;        // Input amount
    uint256 minAmountOut;         // Minimum output
}

function swapExactIn(
    SwapPathExactAmountIn[] calldata paths,
    uint256 deadline,
    bool wethIsEth,
    bytes calldata userData
) external payable returns (
    uint256[] pathAmountsOut,
    address[] tokensOut,
    uint256[] amountsOut
)
```

### 3-Step Boosted Swap Path

```
Step 1 (WRAP):   tokenIn  → wrappedIn   | isBuffer = true  | pool = wrappedIn
Step 2 (SWAP):   wrappedIn → wrappedOut | isBuffer = false | pool = poolAddress
Step 3 (UNWRAP): wrappedOut → tokenOut  | isBuffer = true  | pool = wrappedOut
```

### Complete Boosted Swap Example

```javascript
const BATCH_ROUTER = "0x136f1EFcC3f8f88516B9E94110D56FDBfB1778d1";

const BATCH_ROUTER_ABI = [
  `function swapExactIn(
    (
      address tokenIn,
      (
        address pool,
        address tokenOut,
        bool isBuffer
      )[] steps,
      uint256 exactAmountIn,
      uint256 minAmountOut
    )[] paths,
    uint256 deadline,
    bool wethIsEth,
    bytes userData
  ) external payable returns (uint256[], address[], uint256[])`
];

async function boostedPoolSwap(signer, params) {
  const {
    pool,
    tokenIn,      // Raw (e.g., GHO)
    tokenOut,     // Raw (e.g., USDC)
    wrappedIn,    // ERC-4626 (e.g., waGHO)
    wrappedOut,   // ERC-4626 (e.g., waUSDC)
    amountIn,
    slippagePercent
  } = params;

  // Step 1: Approve tokenIn to Permit2
  const token = new ethers.Contract(tokenIn, ERC20_ABI, signer);
  const permit2 = new ethers.Contract(PERMIT2, PERMIT2_ABI, signer);
  
  const allowance = await token.allowance(signer.address, PERMIT2);
  if (allowance < amountIn) {
    console.log("Approving token to Permit2...");
    await (await token.approve(PERMIT2, ethers.MaxUint256)).wait();
  }

  // Step 2: Approve Permit2 to BatchRouter
  const [p2Amount, p2Exp] = await permit2.allowance(signer.address, tokenIn, BATCH_ROUTER);
  if (p2Amount < amountIn || p2Exp <= Math.floor(Date.now()/1000)) {
    console.log("Approving Permit2 to BatchRouter...");
    await (await permit2.approve(
      tokenIn,
      BATCH_ROUTER,
      ethers.MaxUint256 >> 96n,
      281474976710655n
    )).wait();
  }

  // Step 3: Build 3-step path
  const paths = [{
    tokenIn: tokenIn,
    steps: [
      {
        pool: wrappedIn,      // Wrap buffer
        tokenOut: wrappedIn,
        isBuffer: true        // WRAP: tokenIn → wrappedIn
      },
      {
        pool: pool,           // Boosted pool
        tokenOut: wrappedOut,
        isBuffer: false       // SWAP: wrappedIn → wrappedOut
      },
      {
        pool: wrappedOut,     // Unwrap buffer
        tokenOut: tokenOut,
        isBuffer: true        // UNWRAP: wrappedOut → tokenOut
      }
    ],
    exactAmountIn: amountIn,
    minAmountOut: amountIn * BigInt(100 - slippagePercent) / 100n
  }];

  // Step 4: Execute swap
  const batchRouter = new ethers.Contract(BATCH_ROUTER, BATCH_ROUTER_ABI, signer);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);

  console.log("Executing boosted swap...");
  console.log(`  Path: ${tokenIn} → [wrap] → ${wrappedIn} → [pool] → ${wrappedOut} → [unwrap] → ${tokenOut}`);
  
  const tx = await batchRouter.swapExactIn(
    paths,
    deadline,
    false,
    "0x",
    { gasLimit: 500000n }
  );
  
  const receipt = await tx.wait();
  console.log(`Swap complete! TX: ${tx.hash}`);
  return receipt;
}
```

---

## Flash Loans (V2 vs V3)

Flash loans allow you to borrow tokens without collateral, as long as you repay within the same transaction.

### V2 vs V3 Comparison

| Feature | Balancer V2 | Balancer V3 |
|---------|-------------|-------------|
| **Contract** | Vault `0xBA12222222228d8Ba445958a75a0704d566BF2C8` | Vault `0xbA1333333333a1BA1108E8412f11850A5C319bA9` |
| **Function** | `flashLoan(recipient, tokens, amounts, userData)` | `unlock(data)` + transient storage |
| **Callback** | `receiveFlashLoan(tokens, amounts, feeAmounts, userData)` | Custom via reentrancy |
| **Fee** | **0%** (FREE!) | **0%** (FREE!) |
| **Multi-token** | ✅ Yes | ✅ Yes |
| **Liquidity** | Very deep (legacy pools) | Growing (new pools) |

### When to Use V2 vs V3

```
┌─────────────────────────────────────────────────────────────────┐
│                    WHICH VAULT HAS YOUR TOKEN?                   │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │                               │
              ▼                               ▼
     ┌─────────────────┐            ┌─────────────────┐
     │  V2 Vault has   │            │  V3 Vault has   │
     │  more liquidity │            │  more liquidity │
     └─────────────────┘            └─────────────────┘
              │                               │
              ▼                               ▼
     ┌─────────────────┐            ┌─────────────────┐
     │  Use V2 Flash   │            │  Use V3 Flash   │
     │  flashLoan()    │            │  unlock()       │
     └─────────────────┘            └─────────────────┘
```

### Check Token Availability

```javascript
const { ethers } = require('ethers');

const V2_VAULT = '0xBA12222222228d8Ba445958a75a0704d566BF2C8';
const V3_VAULT = '0xbA1333333333a1BA1108E8412f11850A5C319bA9';
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

async function checkFlashLoanAvailability(tokenAddress, provider) {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    
    const v2Balance = await token.balanceOf(V2_VAULT);
    const v3Balance = await token.balanceOf(V3_VAULT);
    
    console.log('V2 Vault balance:', ethers.formatEther(v2Balance));
    console.log('V3 Vault balance:', ethers.formatEther(v3Balance));
    
    return {
        v2Available: v2Balance,
        v3Available: v3Balance,
        recommended: v2Balance > v3Balance ? 'V2' : 'V3'
    };
}
```

---

### Balancer V2 Flash Loans

**Best for**: Tokens with deep V2 liquidity (AAVE, GHO, VLR, etc.)

#### V2 Interface

```solidity
interface IBalancerV2Vault {
    function flashLoan(
        IFlashLoanRecipient recipient,
        IERC20[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}

interface IFlashLoanRecipient {
    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external;
}
```

#### V2 Solidity Example

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IBalancerV2Vault {
    function flashLoan(
        address recipient,
        IERC20[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}

contract BalancerV2FlashExample {
    IBalancerV2Vault constant VAULT = IBalancerV2Vault(0xBA12222222228d8Ba445958a75a0704d566BF2C8);
    
    function executeFlashLoan(address token, uint256 amount) external {
        IERC20[] memory tokens = new IERC20[](1);
        tokens[0] = IERC20(token);
        
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;
        
        // userData can encode any info needed in callback
        bytes memory userData = abi.encode(msg.sender, amount);
        
        VAULT.flashLoan(address(this), tokens, amounts, userData);
    }
    
    // Callback - called by Vault during flashLoan
    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,  // Always 0 for Balancer V2!
        bytes memory userData
    ) external {
        require(msg.sender == address(VAULT), "Only Vault");
        
        // You now have the borrowed tokens!
        // Do your arbitrage, liquidation, etc. here
        
        // ... your logic ...
        
        // Repay: transfer back to Vault (fees are 0, so just principal)
        for (uint256 i = 0; i < tokens.length; i++) {
            tokens[i].transfer(address(VAULT), amounts[i] + feeAmounts[i]);
        }
    }
}
```

---

### Balancer V3 Flash Loans

**Best for**: New pools, tokens primarily in V3 ecosystem

V3 uses a different pattern with `unlock()` and transient storage:

#### V3 Interface

```solidity
interface IBalancerV3Vault {
    function unlock(bytes calldata data) external returns (bytes memory);
    function sendTo(IERC20 token, address to, uint256 amount) external;
    function settle(IERC20 token, uint256 amount) external returns (uint256);
}
```

#### V3 Solidity Example

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IBalancerV3Vault {
    function unlock(bytes calldata data) external returns (bytes memory);
    function sendTo(IERC20 token, address to, uint256 amount) external;
    function settle(IERC20 token, uint256 amount) external returns (uint256);
}

contract BalancerV3FlashExample {
    IBalancerV3Vault constant VAULT = IBalancerV3Vault(0xbA1333333333a1BA1108E8412f11850A5C319bA9);
    
    function executeFlashLoan(address token, uint256 amount) external {
        // Encode the operation for the callback
        bytes memory data = abi.encode(token, amount, msg.sender);
        
        // unlock() will call back into this contract
        VAULT.unlock(data);
    }
    
    // Called by Vault during unlock()
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(VAULT), "Only Vault");
        
        (address token, uint256 amount, address caller) = abi.decode(data, (address, uint256, address));
        
        // 1. Request tokens from Vault
        VAULT.sendTo(IERC20(token), address(this), amount);
        
        // 2. You now have the borrowed tokens!
        // Do your arbitrage, liquidation, etc. here
        
        // ... your logic ...
        
        // 3. Repay: approve and settle
        IERC20(token).approve(address(VAULT), amount);
        VAULT.settle(IERC20(token), amount);
        
        return "";
    }
}
```

---

### Real Example: VLR Flash Loan Availability

```javascript
// Check VLR availability in both vaults
const VLR = '0x4e107a0000DB66f0E9Fd2039288Bf811dD1f9c74';

async function main() {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const result = await checkFlashLoanAvailability(VLR, provider);
    
    // Result (as of Jan 2026):
    // V2 Vault: 211,475,944 VLR  ✅ Use this!
    // V3 Vault: 1,304 VLR        ❌ Too small
}
```

> **Tip**: For most established tokens (VLR, AAVE, GHO, etc.), Balancer V2 has significantly more liquidity due to legacy pools.

---

## Complete ABIs

### Router (Direct Pools)

```javascript
const ROUTER_ABI = [
  // Swaps
  "function swapSingleTokenExactIn(address pool, address tokenIn, address tokenOut, uint256 exactAmountIn, uint256 minAmountOut, uint256 deadline, bool wethIsEth, bytes userData) external payable returns (uint256)",
  "function swapSingleTokenExactOut(address pool, address tokenIn, address tokenOut, uint256 exactAmountOut, uint256 maxAmountIn, uint256 deadline, bool wethIsEth, bytes userData) external payable returns (uint256)",
  
  // Queries (read-only simulation)
  "function querySwapSingleTokenExactIn(address pool, address tokenIn, address tokenOut, uint256 exactAmountIn, address sender, bytes userData) external returns (uint256)",
  "function querySwapSingleTokenExactOut(address pool, address tokenIn, address tokenOut, uint256 exactAmountOut, address sender, bytes userData) external returns (uint256)",
  
  // Metadata
  "function version() view returns (string)",
  "function getPermit2() view returns (address)"
];
```

### BatchRouter (Boosted Pools)

```javascript
const BATCH_ROUTER_ABI = [
  // Exact In (you specify input amount)
  `function swapExactIn(
    (
      address tokenIn,
      (address pool, address tokenOut, bool isBuffer)[] steps,
      uint256 exactAmountIn,
      uint256 minAmountOut
    )[] paths,
    uint256 deadline,
    bool wethIsEth,
    bytes userData
  ) external payable returns (uint256[], address[], uint256[])`,
  
  // Exact Out (you specify output amount)
  `function swapExactOut(
    (
      address tokenIn,
      (address pool, address tokenOut, bool isBuffer)[] steps,
      uint256 maxAmountIn,
      uint256 exactAmountOut
    )[] paths,
    uint256 deadline,
    bool wethIsEth,
    bytes userData
  ) external payable returns (uint256[], address[], uint256[])`,
  
  // Metadata
  "function version() view returns (string)"
];
```

### Vault

```javascript
const VAULT_ABI = [
  // Pool info
  "function getPoolTokens(address pool) view returns (address[])",
  "function getPoolTokenInfo(address pool) view returns (address[], uint256[], uint256[])",
  
  // Pool registration check
  "function isPoolRegistered(address pool) view returns (bool)"
];
```

### Permit2

```javascript
const PERMIT2_ABI = [
  // Check allowance
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  
  // Approve (no signature needed - on-chain)
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  
  // Transfer (used internally by routers)
  "function transferFrom(address from, address to, uint160 amount, address token)"
];
```

### ERC-4626 (Wrapped Tokens)

```javascript
const ERC4626_ABI = [
  // Identify underlying asset
  "function asset() view returns (address)",
  
  // Wrap (deposit underlying, get shares)
  "function deposit(uint256 assets, address receiver) returns (uint256 shares)",
  
  // Unwrap (burn shares, get underlying)
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)",
  
  // Conversion
  "function convertToShares(uint256 assets) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)"
];
```

---

## Permit2 Integration

### Approval Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    APPROVAL FLOW                                 │
└─────────────────────────────────────────────────────────────────┘

  Step 1: ERC20 → Permit2 (one-time, max approval)
  ┌──────────┐                 ┌──────────┐
  │  Token   │────approve()───▶│ Permit2  │
  │  (GHO)   │   MaxUint256    │          │
  └──────────┘                 └──────────┘

  Step 2: Permit2 → Router (per router, also one-time)
  ┌──────────┐                 ┌──────────┐
  │ Permit2  │────approve()───▶│  Router  │
  │          │   token, amount │          │
  └──────────┘                 └──────────┘
```

### Code Pattern

```javascript
async function ensureApprovals(signer, tokenIn, amountIn, routerAddress) {
  const token = new ethers.Contract(tokenIn, ERC20_ABI, signer);
  const permit2 = new ethers.Contract(PERMIT2, PERMIT2_ABI, signer);

  // Check + approve ERC20 → Permit2
  const erc20Allowance = await token.allowance(signer.address, PERMIT2);
  if (erc20Allowance < amountIn) {
    const tx1 = await token.approve(PERMIT2, ethers.MaxUint256);
    await tx1.wait();
    console.log("✅ ERC20 → Permit2 approved");
  }

  // Check + approve Permit2 → Router
  const [p2Amount, p2Exp] = await permit2.allowance(signer.address, tokenIn, routerAddress);
  const now = Math.floor(Date.now() / 1000);
  if (p2Amount < amountIn || p2Exp <= now) {
    const tx2 = await permit2.approve(
      tokenIn,
      routerAddress,
      ethers.MaxUint256 >> 96n,  // uint160 max
      281474976710655n           // uint48 max (~8900 years)
    );
    await tx2.wait();
    console.log("✅ Permit2 → Router approved");
  }
}
```

---

## Live Examples

### Example 1: GHO → USDC (Boosted Pool) ✅ VERIFIED

**Pool:** `0x85b2b559bc2d21104c4defdd6efca8a20343361d` (Aave GHO/USDT/USDC)

| Token | Address | Type |
|-------|---------|------|
| GHO | `0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f` | Raw |
| USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | Raw |
| waGHO | `0xC71Ea051a5F82c67ADcF634c36FFE6334793D24C` | Wrapped |
| waUSDC | `0xD4fa2D31b7968E448877f69A96DE69f5de8cD23E` | Wrapped |

**Successful TX:** [`0x2a23457da2eaabe2bfde96b1b7a79d19a29413bf5a2aad685d0bca22f6403542`](https://etherscan.io/tx/0x2a23457da2eaabe2bfde96b1b7a79d19a29413bf5a2aad685d0bca22f6403542)

```javascript
// Boosted swap call
const paths = [{
  tokenIn: "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f", // GHO
  steps: [
    { pool: "0xC71Ea051a5F82c67ADcF634c36FFE6334793D24C", tokenOut: "0xC71Ea051a5F82c67ADcF634c36FFE6334793D24C", isBuffer: true },  // GHO → waGHO
    { pool: "0x85b2b559bc2d21104c4defdd6efca8a20343361d", tokenOut: "0xD4fa2D31b7968E448877f69A96DE69f5de8cD23E", isBuffer: false }, // waGHO → waUSDC
    { pool: "0xD4fa2D31b7968E448877f69A96DE69f5de8cD23E", tokenOut: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", isBuffer: true }   // waUSDC → USDC
  ],
  exactAmountIn: ethers.parseUnits("1", 18),  // 1 GHO
  minAmountOut: ethers.parseUnits("0.96", 6)  // ~0.96 USDC (3% slippage)
}];

await batchRouter.swapExactIn(paths, deadline, false, "0x");
```

### Example 2: Direct Pool Swap (Hypothetical)

If pool contains raw tokens (no ERC-4626):

```javascript
// Simple direct swap
await router.swapSingleTokenExactIn(
  "0xPoolAddress...",
  "0xTokenIn...",
  "0xTokenOut...",
  ethers.parseUnits("100", 18),  // amount
  ethers.parseUnits("99", 18),   // minOut
  deadline,
  false,
  "0x"
);
```

---

## Troubleshooting

### Error: `Token not found in pool`

**Cause:** Sent raw token to boosted pool expecting wrapped tokens.

**Solution:** Use BatchRouter with buffer steps:
```javascript
// ❌ Wrong
router.swapSingleTokenExactIn(pool, GHO, USDC, amount, ...);

// ✅ Correct
batchRouter.swapExactIn([{
  tokenIn: GHO,
  steps: [
    { pool: waGHO, tokenOut: waGHO, isBuffer: true },
    { pool: pool, tokenOut: waUSDC, isBuffer: false },
    { pool: waUSDC, tokenOut: USDC, isBuffer: true }
  ],
  ...
}], deadline, false, "0x");
```

### Error: `Insufficient allowance`

**Cause:** Permit2 not approved to spend tokens.

**Solution:** Ensure both approvals:
```javascript
// 1. Token → Permit2
await token.approve(PERMIT2, MaxUint256);

// 2. Permit2 → Router
await permit2.approve(token, router, amount, expiration);
```

### Error: `Deadline exceeded`

**Cause:** Transaction pending too long.

**Solution:** Set longer deadline:
```javascript
const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour
```

### Error: `Query failed / execution reverted`

**Cause:** Wrong pool for tokens, or pool doesn't have liquidity.

**Solution:** Verify pool contains your tokens:
```javascript
const tokens = await vault.getPoolTokens(pool);
console.log(tokens); // Check if your tokens (or wrappers) are here
```

---

## Decision Flowchart

```
START: I want to swap TokenA → TokenB on Balancer V3
                    │
                    ▼
         ┌──────────────────────┐
         │ Do I know the pool?  │
         └──────────────────────┘
                    │
         ┌──────────┴──────────┐
         │                     │
         ▼                     ▼
        YES                   NO
         │                     │
         ▼                     ▼
  ┌──────────────┐      Query subgraph or
  │ Get pool     │      Balancer UI for pools
  │ tokens from  │      containing TokenA/TokenB
  │ Vault        │            │
  └──────────────┘            │
         │                    │
         ▼                    ▼
  ┌─────────────────────────────────────┐
  │  For each pool token, check:        │
  │  isERC4626(token) → asset()         │
  └─────────────────────────────────────┘
                    │
         ┌──────────┴──────────┐
         │                     │
         ▼                     ▼
   Pool has raw tokens    Pool has wrapped tokens
   (TokenA, TokenB)       (waTokenA, waTokenB)
         │                     │
         ▼                     ▼
   Use ROUTER             Use BATCH_ROUTER
   swapSingleTokenExactIn   swapExactIn with
                           3-step buffer path
```

---

## Summary Table

| Scenario | Router | Function | Approvals |
|----------|--------|----------|-----------|
| Direct pool (raw tokens) | Router | `swapSingleTokenExactIn` | Token → Permit2 → Router |
| Boosted pool (wrapped) | BatchRouter | `swapExactIn` with buffers | Token → Permit2 → BatchRouter |
| Add liquidity (raw) | CompositeLiquidityRouter | `addLiquidityUnbalancedToERC4626Pool` | Token → Permit2 → CompositeRouter |
| Add liquidity (wrapped) | Router | `addLiquidityUnbalanced` | Token → Permit2 → Router |
