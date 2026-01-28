# Uniswap V3 Ultimate Guide

> **Comprehensive guide for interacting with Uniswap V3 in smart contracts**
> For Futarchy arbitrage and flash loan strategies on Ethereum Mainnet

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Core Contracts](#core-contracts)
3. [Pool Discovery](#pool-discovery)
4. [Executing Swaps](#executing-swaps)
5. [Multi-Hop Swaps](#multi-hop-swaps)
6. [Flash Swaps (Uniswap Flash Loans)](#flash-swaps-uniswap-flash-loans)
7. [Finding Best Pool for Flash Loans](#finding-best-pool-for-flash-loans)
8. [Integration with Flash Loans](#integration-with-flash-loans)
9. [Verified Paths for VLR/USDS](#verified-paths-for-vlrusds)
10. [Solidity Interfaces](#solidity-interfaces)
11. [Common Patterns](#common-patterns)

---

## Architecture Overview

### No Central Vault

Unlike Balancer, **Uniswap V3 has no central vault**. Each pool is an independent smart contract that holds its own token reserves:

```
┌─────────────────────────────────────────────────────────────┐
│                     UNISWAP V3 ARCHITECTURE                  │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   ┌──────────────┐                                          │
│   │   Factory    │ ←── Creates and tracks all pools         │
│   └──────────────┘                                          │
│          │                                                   │
│          ▼                                                   │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│   │  Pool A/B    │  │  Pool B/C    │  │  Pool A/C    │      │
│   │  (0.05% fee) │  │  (0.3% fee)  │  │  (1% fee)    │      │
│   │              │  │              │  │              │       │
│   │ Holds A + B  │  │ Holds B + C  │  │ Holds A + C  │       │
│   └──────────────┘  └──────────────┘  └──────────────┘      │
│                                                              │
│   ┌──────────────┐                                          │
│   │  SwapRouter  │ ←── Routes swaps through pools           │
│   └──────────────┘                                          │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Key Implications

1. **Direct Pool Interaction**: You can swap directly with a pool or use the router
2. **No Token Locking**: Tokens are held by individual pools, not a shared vault
3. **Fee Tiers**: Same token pair can have multiple pools with different fees
4. **Flash Loans**: Each pool can provide flash loans for its own tokens

---

## Core Contracts

### Mainnet Addresses

| Contract | Address | Description |
|----------|---------|-------------|
| **Factory** | `0x1F98431c8aD98523631AE4a59f267346ea31F984` | Creates/tracks pools |
| **SwapRouter** | `0xE592427A0AEce92De3Edee1F18E0157C05861564` | Basic swap routing |
| **SwapRouter02** | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` | Enhanced router |
| **QuoterV2** | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` | Quote swaps off-chain |
| **Permit2** | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Gasless approvals |

### Fee Tiers

| Fee | Basis Points | Tick Spacing | Typical Use Case |
|-----|--------------|--------------|------------------|
| **100** | 0.01% | 1 | Stable pairs (USDC/USDT) |
| **500** | 0.05% | 10 | Stable/correlated pairs |
| **3000** | 0.3% | 60 | Standard pairs |
| **10000** | 1% | 200 | Exotic/volatile pairs |

---

## Pool Discovery

### Finding Pools via Factory

```javascript
const { ethers } = require('ethers');

const FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const FACTORY_ABI = [
    'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)'
];

async function findPool(provider, tokenA, tokenB, fee) {
    const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);
    const pool = await factory.getPool(tokenA, tokenB, fee);
    
    if (pool === ethers.ZeroAddress) {
        return null; // Pool doesn't exist
    }
    return pool;
}

// Example: Find VLR/USDC pool
const VLR = '0x4e107a0000DB66f0E9Fd2039288Bf811dD1f9c74';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

// Check all fee tiers
for (const fee of [100, 500, 3000, 10000]) {
    const pool = await findPool(provider, VLR, USDC, fee);
    if (pool) console.log(`Found pool at ${pool} (fee: ${fee/10000}%)`);
}
```

### Checking Pool Liquidity

```javascript
const POOL_ABI = [
    'function liquidity() view returns (uint128)',
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
    'function token0() view returns (address)',
    'function token1() view returns (address)'
];

async function getPoolInfo(provider, poolAddress) {
    const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
    
    const [liquidity, slot0, token0, token1] = await Promise.all([
        pool.liquidity(),
        pool.slot0(),
        pool.token0(),
        pool.token1()
    ]);
    
    return {
        liquidity,
        sqrtPriceX96: slot0[0],
        tick: slot0[1],
        token0,
        token1,
        hasLiquidity: liquidity > 0n
    };
}
```

---

## Executing Swaps

### Using SwapRouter (exactInputSingle)

The most common method for single-pool swaps:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    
    function exactInputSingle(ExactInputSingleParams calldata params) 
        external payable returns (uint256 amountOut);
}

contract UniswapSwapper {
    ISwapRouter public constant router = 
        ISwapRouter(0xE592427A0AEce92De3Edee1F18E0157C05861564);
    
    function swapExactInput(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 minAmountOut
    ) external returns (uint256 amountOut) {
        // 1. Approve router to spend tokenIn
        IERC20(tokenIn).approve(address(router), amountIn);
        
        // 2. Execute swap
        ISwapRouter.ExactInputSingleParams memory params = 
            ISwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: amountIn,
                amountOutMinimum: minAmountOut,
                sqrtPriceLimitX96: 0  // No price limit
            });
        
        return router.exactInputSingle(params);
    }
}
```

### Key Parameters

| Parameter | Description |
|-----------|-------------|
| `tokenIn` | Token being sold |
| `tokenOut` | Token being bought |
| `fee` | Pool fee tier (100, 500, 3000, 10000) |
| `recipient` | Address receiving output tokens |
| `deadline` | TX revert time (use `block.timestamp` for same-block) |
| `amountIn` | Exact amount of tokenIn to sell |
| `amountOutMinimum` | Minimum acceptable output (slippage protection) |
| `sqrtPriceLimitX96` | Price limit (0 = no limit) |

---

## Multi-Hop Swaps

For swapping through multiple pools (e.g., VLR → USDC → USDS):

### Path Encoding

Uniswap V3 encodes multi-hop paths as:
```
tokenA (20 bytes) + feeAB (3 bytes) + tokenB (20 bytes) + feeBC (3 bytes) + tokenC (20 bytes)
```

### exactInput (Multi-Hop)

```solidity
interface ISwapRouter {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }
    
    function exactInput(ExactInputParams calldata params) 
        external payable returns (uint256 amountOut);
}

contract MultiHopSwapper {
    ISwapRouter public constant router = 
        ISwapRouter(0xE592427A0AEce92De3Edee1F18E0157C05861564);
    
    // VLR → USDC → USDS path
    function encodePath(
        address tokenA,
        uint24 feeAB,
        address tokenB,
        uint24 feeBC,
        address tokenC
    ) public pure returns (bytes memory) {
        return abi.encodePacked(tokenA, feeAB, tokenB, feeBC, tokenC);
    }
    
    function multiHopSwap(
        bytes calldata path,
        uint256 amountIn,
        uint256 minAmountOut
    ) external returns (uint256 amountOut) {
        // Approve router for first token in path
        // (tokenIn is first 20 bytes of path)
        address tokenIn;
        assembly {
            tokenIn := shr(96, calldataload(path.offset))
        }
        IERC20(tokenIn).approve(address(router), amountIn);
        
        ISwapRouter.ExactInputParams memory params = 
            ISwapRouter.ExactInputParams({
                path: path,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: amountIn,
                amountOutMinimum: minAmountOut
            });
        
        return router.exactInput(params);
    }
}
```

### JavaScript Path Encoding

```javascript
function encodePath(tokens, fees) {
    // tokens: [tokenA, tokenB, tokenC, ...]
    // fees: [feeAB, feeBC, ...]
    let encoded = '0x';
    
    for (let i = 0; i < tokens.length; i++) {
        // Add token address (20 bytes)
        encoded += tokens[i].slice(2).toLowerCase();
        
        // Add fee if not last token (3 bytes)
        if (i < fees.length) {
            encoded += fees[i].toString(16).padStart(6, '0');
        }
    }
    
    return encoded;
}

// Example: VLR → USDC → USDS
const path = encodePath(
    [VLR, USDC, USDS],
    [3000, 500]  // VLR-USDC 0.3%, USDC-USDS 0.05%
);
```

---

## Flash Swaps (Uniswap Flash Loans)

### How Flash Swaps Work

Uniswap V3 pools natively support flash loans via the `flash()` function:

```
┌─────────────────────────────────────────────────────────────┐
│                    FLASH SWAP FLOW                           │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   1. Your Contract calls pool.flash(amount0, amount1, data) │
│                          ↓                                   │
│   2. Pool sends you amount0 of token0, amount1 of token1    │
│                          ↓                                   │
│   3. Pool calls your uniswapV3FlashCallback(fee0, fee1, data)│
│                          ↓                                   │
│   4. Your callback does arbitrage/logic                      │
│                          ↓                                   │
│   5. You repay: amount0 + fee0, amount1 + fee1              │
│                          ↓                                   │
│   6. Pool verifies repayment, TX completes                   │
│      (If not repaid → TX REVERTS)                           │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Flash Swap Interface

```solidity
interface IUniswapV3Pool {
    /// @notice Receive token0 and/or token1 and pay it back, plus a fee, 
    /// in the callback
    function flash(
        address recipient,
        uint256 amount0,
        uint256 amount1,
        bytes calldata data
    ) external;
}

interface IUniswapV3FlashCallback {
    /// @notice Called to `msg.sender` after transferring to the recipient 
    /// from IUniswapV3Pool#flash
    function uniswapV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) external;
}
```

### Flash Loan Example

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IUniswapV3Pool {
    function flash(address recipient, uint256 amount0, uint256 amount1, bytes calldata data) external;
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
}

contract UniswapV3FlashLoan {
    
    // The pool we're borrowing from
    IUniswapV3Pool public pool;
    
    constructor(address _pool) {
        pool = IUniswapV3Pool(_pool);
    }
    
    function executeFlashLoan(uint256 amount0, uint256 amount1) external {
        // Encode any data you need in the callback
        bytes memory data = abi.encode(msg.sender);
        
        // Request flash loan
        pool.flash(address(this), amount0, amount1, data);
    }
    
    function uniswapV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) external {
        // SECURITY: Verify caller is the pool
        require(msg.sender == address(pool), "Not the pool");
        
        // Decode data
        address initiator = abi.decode(data, (address));
        
        // Get tokens
        address token0 = pool.token0();
        address token1 = pool.token1();
        
        // Calculate amounts owed (borrowed + fee)
        uint256 amount0Owed = IERC20(token0).balanceOf(address(this)) > 0 
            ? IERC20(token0).balanceOf(address(this)) + fee0 - fee0 // Original amount + fee
            : 0;
        uint256 amount1Owed = IERC20(token1).balanceOf(address(this)) > 0
            ? IERC20(token1).balanceOf(address(this)) + fee1 - fee1
            : 0;
        
        // ═══════════════════════════════════════════════════════════════
        // 🎯 YOUR ARBITRAGE LOGIC HERE
        // ═══════════════════════════════════════════════════════════════
        
        // Example: You now have the borrowed tokens
        // Do swaps, splits, merges, etc.
        
        // ═══════════════════════════════════════════════════════════════
        
        // REPAY: Transfer borrowed amount + fee back to pool
        if (amount0Owed > 0) {
            IERC20(token0).transfer(address(pool), amount0Owed);
        }
        if (amount1Owed > 0) {
            IERC20(token1).transfer(address(pool), amount1Owed);
        }
        
        // If we don't repay enough, the pool will revert the entire TX
    }
}
```

### Flash Loan Fee Calculation

The fee is calculated as:
```
fee = (amount * poolFee) / 1_000_000
```

For example:
- Pool fee: 500 (0.05%)
- Borrowed: 1000 USDC
- Fee: 1000 * 500 / 1,000,000 = 0.5 USDC

---

## Finding Best Pool for Flash Loans

When you need to flash borrow a token, you must find the pool with **the most of that token**. Since Uniswap has no central vault, the token balance varies per pool.

### Strategy Overview

```
┌─────────────────────────────────────────────────────────────┐
│           FINDING BEST FLASH LOAN SOURCE                     │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   1. Identify all pools containing your target token         │
│      └── Check Factory for pools with common pairs           │
│                                                              │
│   2. Query token balance in each pool                        │
│      └── Call token.balanceOf(poolAddress)                  │
│                                                              │
│   3. Compare fees vs liquidity tradeoff                      │
│      └── Lower fee = cheaper, but might have less liquidity │
│                                                              │
│   4. Select pool with MOST token balance                     │
│      └── Max borrowable = token.balanceOf(pool)             │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Key Insight: Token Balance = Max Flash Loan

The maximum you can flash borrow from a pool is simply:
```javascript
maxBorrow = await token.balanceOf(poolAddress);
```

This is **NOT** the `liquidity()` value (which is LP liquidity for swaps), but the actual **token balance** held by the pool contract.

### Decision Matrix

| Factor | Priority | Why? |
|--------|----------|------|
| **Token Balance** | 🔴 Critical | Determines max borrowable amount |
| **Pool Fee** | 🟡 Important | Affects your profit margin |
| **Pair Token Liquidity** | 🟢 Nice to have | Only matters if you also swap |

### JavaScript: Find Best Flash Loan Pool

```javascript
const { ethers } = require('ethers');

const FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const FEE_TIERS = [100, 500, 3000, 10000];

// Common tokens to check for pairs
const COMMON_PAIRS = [
    '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
    '0x6B175474E89094C44Da98b954EescdeCB5BE3830', // DAI
];

const FACTORY_ABI = [
    'function getPool(address, address, uint24) view returns (address)'
];
const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)'
];

async function findBestFlashLoanPool(provider, targetToken) {
    const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);
    const token = new ethers.Contract(targetToken, ERC20_ABI, provider);
    const decimals = await token.decimals();
    
    const pools = [];
    
    // Check each pair and fee tier
    for (const pairToken of COMMON_PAIRS) {
        if (pairToken.toLowerCase() === targetToken.toLowerCase()) continue;
        
        for (const fee of FEE_TIERS) {
            try {
                const poolAddr = await factory.getPool(targetToken, pairToken, fee);
                if (poolAddr === ethers.ZeroAddress) continue;
                
                // Get target token balance in pool
                const balance = await token.balanceOf(poolAddr);
                
                pools.push({
                    address: poolAddr,
                    fee,
                    feePercent: fee / 10000,
                    balance,
                    balanceFormatted: ethers.formatUnits(balance, decimals)
                });
            } catch (e) {
                // Pool doesn't exist
            }
        }
    }
    
    // Sort by balance descending
    pools.sort((a, b) => (b.balance > a.balance ? 1 : -1));
    
    return pools;
}

// Usage
const VLR = '0x4e107a0000DB66f0E9Fd2039288Bf811dD1f9c74';
const pools = await findBestFlashLoanPool(provider, VLR);

console.log('Best pool for VLR flash loan:');
console.log(`  Address: ${pools[0].address}`);
console.log(`  Balance: ${pools[0].balanceFormatted} VLR`);
console.log(`  Fee: ${pools[0].feePercent}%`);
```

### Solidity: Check Pool Balance On-Chain

```solidity
/// @notice Find the pool with most of a target token
/// @param targetToken The token you want to flash borrow
/// @param pairTokens Array of potential pair tokens to check
/// @param fees Array of fee tiers to check
function findBestPool(
    address targetToken,
    address[] calldata pairTokens,
    uint24[] calldata fees
) external view returns (address bestPool, uint256 maxBalance) {
    for (uint i = 0; i < pairTokens.length; i++) {
        for (uint j = 0; j < fees.length; j++) {
            address pool = factory.getPool(targetToken, pairTokens[i], fees[j]);
            if (pool == address(0)) continue;
            
            uint256 balance = IERC20(targetToken).balanceOf(pool);
            if (balance > maxBalance) {
                maxBalance = balance;
                bestPool = pool;
            }
        }
    }
}
```

### Real Example: VLR Pools (Jan 2026)

| Pool | Address | VLR Balance | Fee | Recommendation |
|------|---------|-------------|-----|----------------|
| **VLR/USDC** | `0xb382646C447007a23Eab179957235DC3FC51606c` | **16.2M VLR** | 0.3% | ✅ Best choice |

> **Result**: Only one VLR pool exists, so the choice is simple. For tokens with multiple pools, always check the actual `balanceOf()`.

### Cost Calculation

When borrowing `X` tokens from a pool with fee `F`:

```
FlashFee = X × (F / 1,000,000)

Example (borrow 100,000 VLR from 0.3% pool):
FlashFee = 100,000 × (3000 / 1,000,000) = 300 VLR
```

### Trade-off: Fee vs Availability

| Scenario | Choose Lower Fee Pool | Choose Higher Liquidity Pool |
|----------|----------------------|------------------------------|
| Small borrow, multiple pools | ✅ | ❌ |
| Large borrow near max | ❌ | ✅ |
| Only one pool exists | N/A | Only option |

---

## Integration with Flash Loans

### Comparison: Uniswap vs Aave vs Balancer

| Feature | Uniswap V3 | Aave V3 | Balancer V3 |
|---------|------------|---------|-------------|
| **Mechanism** | Pool's `flash()` | Pool's `flashLoan()` | Vault's `unlock()` |
| **Fee** | Pool fee (0.01-1%) | 0.05% | 0% |
| **Single Token** | ✅ | ✅ | ✅ |
| **Multi Token** | ❌ (per pool) | ✅ | ✅ |
| **Callback** | `uniswapV3FlashCallback` | `executeOperation` | Custom |

### When to Use Uniswap Flash Loans

✅ **Use Uniswap when:**
- You need tokens from a specific pool
- The pool has deep liquidity
- You want to combine flash loan + swap in same pool

❌ **Use Aave/Balancer when:**
- You need multiple tokens atomically
- You want lower/no fees
- You need tokens not in Uniswap pools

---

## Verified Paths for VLR/USDS

Based on the successful CoW Swap transaction, we have verified liquidity:

### Path: USDS → USDC → VLR

```
USDS ──[Uniswap V4]──► USDC ──[Uniswap V3]──► VLR
       (0.0075% fee)          (0.3% fee)
```

### Verified Pool Addresses

| Pool | Address | Fee |
|------|---------|-----|
| **VLR/USDC** | `0xb382646C447007a23Eab179957235DC3FC51606c` | 0.3% (3000) |
| **USDS/USDC** | Via Uniswap V4 Pool Manager | ~0.0075% |

### Token Addresses

| Token | Address | Decimals |
|-------|---------|----------|
| **VLR** | `0x4e107a0000DB66f0E9Fd2039288Bf811dD1f9c74` | 18 |
| **USDS** | `0xdC035D45d973E3EC169d2276DDab16f1e407384F` | 18 |
| **USDC** | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | 6 |

### Exchange Rate (as of Jan 2026)

```
1 USDS ≈ 517 VLR (via USDC intermediary)
```

---

## Solidity Interfaces

### Complete Interface Set

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ═══════════════════════════════════════════════════════════════════════════
// UNISWAP V3 FACTORY
// ═══════════════════════════════════════════════════════════════════════════

interface IUniswapV3Factory {
    function getPool(
        address tokenA,
        address tokenB,
        uint24 fee
    ) external view returns (address pool);
    
    function createPool(
        address tokenA,
        address tokenB,
        uint24 fee
    ) external returns (address pool);
}

// ═══════════════════════════════════════════════════════════════════════════
// UNISWAP V3 POOL
// ═══════════════════════════════════════════════════════════════════════════

interface IUniswapV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function liquidity() external view returns (uint128);
    
    function slot0() external view returns (
        uint160 sqrtPriceX96,
        int24 tick,
        uint16 observationIndex,
        uint16 observationCardinality,
        uint16 observationCardinalityNext,
        uint8 feeProtocol,
        bool unlocked
    );
    
    function flash(
        address recipient,
        uint256 amount0,
        uint256 amount1,
        bytes calldata data
    ) external;
    
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

// ═══════════════════════════════════════════════════════════════════════════
// UNISWAP V3 SWAP ROUTER
// ═══════════════════════════════════════════════════════════════════════════

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    
    function exactInputSingle(ExactInputSingleParams calldata params)
        external payable returns (uint256 amountOut);
    
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }
    
    function exactInput(ExactInputParams calldata params)
        external payable returns (uint256 amountOut);
    
    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }
    
    function exactOutputSingle(ExactOutputSingleParams calldata params)
        external payable returns (uint256 amountIn);
}

// ═══════════════════════════════════════════════════════════════════════════
// UNISWAP V3 FLASH CALLBACK
// ═══════════════════════════════════════════════════════════════════════════

interface IUniswapV3FlashCallback {
    function uniswapV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) external;
}

// ═══════════════════════════════════════════════════════════════════════════
// UNISWAP V3 QUOTER V2
// ═══════════════════════════════════════════════════════════════════════════

interface IQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }
    
    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external returns (
            uint256 amountOut,
            uint160 sqrtPriceX96After,
            uint32 initializedTicksCrossed,
            uint256 gasEstimate
        );
}
```

---

## Common Patterns

### Pattern 1: Safe Approval

```solidity
function _safeApprove(IERC20 token, address spender, uint256 amount) internal {
    uint256 currentAllowance = token.allowance(address(this), spender);
    if (currentAllowance < amount) {
        // Some tokens require setting to 0 first (USDT)
        if (currentAllowance > 0) {
            token.approve(spender, 0);
        }
        token.approve(spender, type(uint256).max);
    }
}
```

### Pattern 2: Swap with Slippage Protection

```solidity
function swapWithSlippage(
    address tokenIn,
    address tokenOut,
    uint24 fee,
    uint256 amountIn,
    uint256 slippageBps  // e.g., 50 = 0.5%
) external returns (uint256 amountOut) {
    // Get quote first
    uint256 expectedOut = quoter.quoteExactInputSingle(
        IQuoterV2.QuoteExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            fee: fee,
            sqrtPriceLimitX96: 0
        })
    );
    
    // Calculate minimum with slippage
    uint256 minOut = expectedOut * (10000 - slippageBps) / 10000;
    
    // Execute swap
    return router.exactInputSingle(
        ISwapRouter.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: fee,
            recipient: msg.sender,
            deadline: block.timestamp,
            amountIn: amountIn,
            amountOutMinimum: minOut,
            sqrtPriceLimitX96: 0
        })
    );
}
```

### Pattern 3: Flash Loan + Arbitrage

```solidity
function executeArbitrage(uint256 borrowAmount) external {
    // Borrow from VLR/USDC pool
    IUniswapV3Pool(VLR_USDC_POOL).flash(
        address(this),
        borrowAmount,  // amount0 (VLR)
        0,             // amount1 (USDC)
        abi.encode(msg.sender)
    );
}

function uniswapV3FlashCallback(
    uint256 fee0,
    uint256 fee1,
    bytes calldata data
) external {
    require(msg.sender == VLR_USDC_POOL, "Invalid caller");
    
    uint256 vlrBalance = IERC20(VLR).balanceOf(address(this));
    
    // 1. Split VLR into YES_VLR + NO_VLR
    futarchyRouter.splitPosition(proposal, VLR, vlrBalance);
    
    // 2. Swap YES_VLR → YES_USDS on Uniswap V3
    _swapUniswapV3(YES_VLR, YES_USDS, yesBalance);
    
    // 3. Swap NO_VLR → NO_USDS on Uniswap V3
    _swapUniswapV3(NO_VLR, NO_USDS, noBalance);
    
    // 4. Merge YES_USDS + NO_USDS → USDS
    futarchyRouter.mergePositions(proposal, USDS, mergeAmount);
    
    // 5. Swap USDS → USDC → VLR to repay
    _multiHopSwap(USDS, VLR, usdsBalance);
    
    // 6. Repay flash loan (borrowed + fee)
    uint256 repayAmount = vlrBalance + fee0;
    IERC20(VLR).transfer(VLR_USDC_POOL, repayAmount);
}
```

---

## Summary

| Topic | Key Points |
|-------|------------|
| **Architecture** | No vault, each pool is independent |
| **Swaps** | Use SwapRouter with `exactInputSingle` or `exactInput` |
| **Multi-hop** | Encode path as `token + fee + token + fee + token` |
| **Flash Loans** | Call `pool.flash()`, implement callback, repay + fee |
| **Fees** | 0.01%, 0.05%, 0.3%, 1% tiers |
| **VLR/USDS** | Route via USDC: VLR ↔ USDC ↔ USDS |

---

## References

- [Uniswap V3 Docs](https://docs.uniswap.org/contracts/v3/overview)
- [Uniswap V3 SDK](https://docs.uniswap.org/sdk/v3/overview)
- [SwapRouter Interface](https://docs.uniswap.org/contracts/v3/reference/periphery/SwapRouter)
- [Flash Swaps](https://docs.uniswap.org/contracts/v3/guides/flash-integrations/flash-callback)
