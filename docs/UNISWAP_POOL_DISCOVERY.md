# Uniswap V3 Pool Discovery

How to find existing Uniswap V3 pools for a given token pair.

---

## Quick Reference

### Factory Addresses (getPool)

| Chain | Chain ID | Pool Factory Address |
|-------|----------|----------------------|
| **Ethereum Mainnet** | 1 | `0x1F98431c8aD98523631AE4a59f267346ea31F984` |
| **Polygon** | 137 | `0x1F98431c8aD98523631AE4a59f267346ea31F984` |
| **Gnosis (Swapr)** | 100 | *Uses Algebra - see below* |

### Position Manager Addresses (for liquidity)

| Chain | Chain ID | Position Manager (NFPM) |
|-------|----------|-------------------------|
| **Ethereum Mainnet** | 1 | `0xC36442b4a4522E871399CD717aBDD847Ab11FE88` |
| **Polygon** | 137 | `0xC36442b4a4522E871399CD717aBDD847Ab11FE88` |
| **Gnosis (Swapr)** | 100 | `0x91fd594c46d8b01e62dbdebed2401dde01817834` |

---

## Finding a Pool by Tokens

### Uniswap V3 Factory (Ethereum, Polygon)

```javascript
import { ethers } from "ethers";

const FACTORY_ADDRESS = "0x1F98431c8aD98523631AE4a59f267346ea31F984";

const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)"
];

async function findPool(provider, tokenA, tokenB, feeTier = 3000) {
  const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);
  
  const poolAddress = await factory.getPool(tokenA, tokenB, feeTier);
  
  if (poolAddress === ethers.ZeroAddress) {
    console.log("Pool does not exist");
    return null;
  }
  
  return poolAddress;
}

// Example: Find WETH/USDC pool with 0.3% fee
const pool = await findPool(
  provider,
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
  3000 // 0.3% fee
);
```

### Common Fee Tiers

| Fee Tier | Value | Description |
|----------|-------|-------------|
| 0.01% | `100` | Stable pairs (USDC/USDT) |
| 0.05% | `500` | Stable/liquid pairs |
| 0.30% | `3000` | **Most common (default)** |
| 1.00% | `10000` | Exotic pairs |

### CLI Usage (refactorCreateProposal)

The CLI defaults to **fee tier 3000** (0.3%). Override in your config:

```json
{
  "chainId": 1,
  "amm": "uniswap",
  "feeTier": 500,    // Use 0.05% instead of default 0.3%
  "proposalAddress": "0x...",
  "marketName": "My Market"
} //THe futarchy proposals default right now uses 500
```

From [liquidityOrchestrator.js](../futarchy-sdk/refactorCreateProposal/modules/liquidityOrchestrator.js#L115):
```javascript
const globalFeeTier = (config.feeTier || 3000);  // Default to 3000
```

---

## Swapr/Algebra (Gnosis Chain)

Gnosis uses Algebra pools which don't have fee tiers - they use dynamic fees.

```javascript
// Algebra Factory (Swapr on Gnosis)
const ALGEBRA_FACTORY = "0xA0864cCA6E114013AB0e27cbd5B6f4c8947da766";

const ALGEBRA_FACTORY_ABI = [
  "function poolByPair(address tokenA, address tokenB) view returns (address pool)"
];

async function findAlgebraPool(provider, tokenA, tokenB) {
  const factory = new ethers.Contract(ALGEBRA_FACTORY, ALGEBRA_FACTORY_ABI, provider);
  
  const poolAddress = await factory.poolByPair(tokenA, tokenB);
  
  if (poolAddress === ethers.ZeroAddress) {
    return null;
  }
  
  return poolAddress;
}
```

---

## Reading Pool Data

Once you have a pool address, read its current state:

### Uniswap V3 Pool

```javascript
const POOL_ABI = [
  // Get current price and tick
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  
  // Get tokens
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  
  // Get fee and spacing
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  
  // Get liquidity
  "function liquidity() view returns (uint128)"
];

async function getPoolInfo(provider, poolAddress) {
  const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
  
  const [slot0, token0, token1, fee, liquidity] = await Promise.all([
    pool.slot0(),
    pool.token0(),
    pool.token1(),
    pool.fee(),
    pool.liquidity()
  ]);
  
  // Calculate price from sqrtPriceX96
  const sqrtPriceX96 = slot0.sqrtPriceX96;
  const price = (Number(sqrtPriceX96) / (2 ** 96)) ** 2;
  
  return {
    token0,
    token1,
    fee,
    currentTick: slot0.tick,
    price,
    liquidity
  };
}
```

### Algebra Pool (Gnosis)

```javascript
const ALGEBRA_POOL_ABI = [
  // Uses globalState instead of slot0
  "function globalState() view returns (uint160 sqrtPriceX96, int24 tick, uint16 feeZto, uint16 feeOtz, uint16 communityFeeLastTimestamp, bool unlocked)",
  
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function tickSpacing() view returns (int24)",
  "function liquidity() view returns (uint128)"
];

async function getAlgebraPoolInfo(provider, poolAddress) {
  const pool = new ethers.Contract(poolAddress, ALGEBRA_POOL_ABI, provider);
  
  const globalState = await pool.globalState();
  const price = (Number(globalState.sqrtPriceX96) / (2 ** 96)) ** 2;
  
  return {
    token0: await pool.token0(),
    token1: await pool.token1(),
    currentTick: globalState.tick,
    // Algebra has dynamic fees
    feeZtoO: globalState.feeZto,
    feeOtoZ: globalState.feeOtz,
    price,
    liquidity: await pool.liquidity()
  };
}
```

---

## Full Multi-Chain Example

```javascript
const { ethers } = require("ethers");

// Factory addresses by chain
const FACTORIES = {
  1: { // Ethereum
    address: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    type: "uniswap"
  },
  137: { // Polygon
    address: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    type: "uniswap"
  },
  100: { // Gnosis
    address: "0xA0864cCA6E114013AB0e27cbd5B6f4c8947da766",
    type: "algebra"
  }
};

async function findPoolMultiChain(provider, chainId, tokenA, tokenB, feeTier = 3000) {
  const config = FACTORIES[chainId];
  if (!config) throw new Error(`Unsupported chain: ${chainId}`);
  
  const factory = new ethers.Contract(
    config.address,
    config.type === "uniswap"
      ? ["function getPool(address,address,uint24) view returns (address)"]
      : ["function poolByPair(address,address) view returns (address)"],
    provider
  );
  
  const poolAddress = config.type === "uniswap"
    ? await factory.getPool(tokenA, tokenB, feeTier)
    : await factory.poolByPair(tokenA, tokenB);
  
  return poolAddress === ethers.ZeroAddress ? null : poolAddress;
}

// Example usage
const provider = new ethers.JsonRpcProvider("https://ethereum.publicnode.com");
const pool = await findPoolMultiChain(
  provider,
  1, // Ethereum
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
  3000
);
console.log("Pool:", pool);
```

---

## Token Ordering

> **Important**: Uniswap orders tokens by address (lowercase comparison).
> The token with the smaller address becomes `token0`.

```javascript
function getAMMOrder(tokenA, tokenB) {
  const addrA = tokenA.toLowerCase();
  const addrB = tokenB.toLowerCase();
  
  if (addrA < addrB) {
    return { ammToken0: tokenA, ammToken1: tokenB, inverted: false };
  } else {
    return { ammToken0: tokenB, ammToken1: tokenA, inverted: true };
  }
}

// If inverted=true, the pool price is 1/price you expect
```

---

## Related Files

| File | Description |
|------|-------------|
| [`poolManager.js`](../futarchy-sdk/refactorCreateProposal/modules/poolManager.js) | Pool creation and discovery logic |
| [`chains.config.json`](../futarchy-sdk/refactorCreateProposal/config/chains.config.json) | Multi-chain contract addresses |
| [`runtime-chains.config.json`](../futarchy-sdk/runtime-chains.config.json) | Runtime chain configuration |
| [`UNISWAP_SWAP_FLOW.md`](./UNISWAP_SWAP_FLOW.md) | Swap execution documentation |
