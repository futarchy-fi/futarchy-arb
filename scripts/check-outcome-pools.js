/**
 * Check Uniswap V3 Pool Prices and Liquidity for Outcome Tokens
 * 
 * Pools:
 *   YES_AAVE / YES_GHO: 0xd4776Ea355326C3D9Ab3Ff9417F12D6c8718066F
 *   NO_AAVE / NO_GHO:   0x08D364Bf5ED8698790114a56678d14b5d6a89A77
 */

const { ethers } = require("ethers");
require("dotenv").config();

const RPC = process.env.RPC_URL || "https://ethereum.publicnode.com";

// Verified Pool Addresses
const YES_POOL = "0xd4776Ea355326C3D9Ab3Ff9417F12D6c8718066F";
const NO_POOL = "0x08D364Bf5ED8698790114a56678d14b5d6a89A77";

// Outcome Token Addresses (from verify script)
const YES_AAVE = "0x63Ad5275380416b3700B84BFaD3B74ED812dfAE4";
const NO_AAVE = "0xf7c5a22Aeeb87c8E06b1a2bF40ab46c1e944f837";
const YES_GHO = "0x01917fD18c1019389cC89457c53E6631A13c1e9D";
const NO_GHO = "0xA31EF4bEfE367064fB0D8863A3E0AAD50054B917";

// Uniswap V3 Pool ABI (minimal)
const POOL_ABI = [
    "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
    "function liquidity() external view returns (uint128)",
    "function token0() external view returns (address)",
    "function token1() external view returns (address)",
    "function fee() external view returns (uint24)"
];

// ERC20 ABI
const ERC20_ABI = [
    "function symbol() external view returns (string)",
    "function decimals() external view returns (uint8)",
    "function balanceOf(address) external view returns (uint256)"
];

async function main() {
    const provider = new ethers.JsonRpcProvider(RPC);

    console.log("╔════════════════════════════════════════════════════════════════╗");
    console.log("║  UNISWAP V3 OUTCOME POOL ANALYSIS                              ║");
    console.log("╚════════════════════════════════════════════════════════════════╝\n");

    // Analyze YES Pool
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📊 YES_AAVE / YES_GHO Pool");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    await analyzePool(provider, YES_POOL, "YES");

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📊 NO_AAVE / NO_GHO Pool");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    await analyzePool(provider, NO_POOL, "NO");

    // Check token balances in pools
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("💰 Token Balances in Pools (TVL Proxy)");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    await checkPoolBalances(provider, YES_POOL, YES_AAVE, YES_GHO, "YES");
    await checkPoolBalances(provider, NO_POOL, NO_AAVE, NO_GHO, "NO");
}

async function analyzePool(provider, poolAddress, label) {
    const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);

    try {
        const [slot0, liquidity, token0, token1, fee] = await Promise.all([
            pool.slot0(),
            pool.liquidity(),
            pool.token0(),
            pool.token1()
        ]);

        const sqrtPriceX96 = slot0[0];
        const tick = slot0[1];

        // Decode price from sqrtPriceX96
        // price = (sqrtPriceX96 / 2^96)^2
        const sqrtPrice = Number(sqrtPriceX96) / (2 ** 96);
        const price = sqrtPrice * sqrtPrice;

        // Get token symbols
        const t0 = new ethers.Contract(token0, ERC20_ABI, provider);
        const t1 = new ethers.Contract(token1, ERC20_ABI, provider);
        const [sym0, sym1, dec0, dec1] = await Promise.all([
            t0.symbol(),
            t1.symbol(),
            t0.decimals(),
            t1.decimals()
        ]);

        // Adjust for decimals (both are 18 for these tokens)
        const adjustedPrice = price * (10 ** (Number(dec0) - Number(dec1)));

        console.log(`   Pool: ${poolAddress}`);
        console.log(`   Token0: ${sym0} (${token0.slice(0, 10)}...)`);
        console.log(`   Token1: ${sym1} (${token1.slice(0, 10)}...)`);
        console.log(`   Fee: ${Number(fee) / 10000}%`);
        console.log(`   Tick: ${tick}`);
        console.log(`   Liquidity: ${liquidity.toString()}`);
        console.log(`   ─────────────────────────────────`);
        console.log(`   💱 Price (${sym1}/${sym0}): ${adjustedPrice.toFixed(6)}`);
        console.log(`   💱 Price (${sym0}/${sym1}): ${(1 / adjustedPrice).toFixed(6)}`);

        // Interpretation
        if (label === "YES") {
            console.log(`\n   📈 Interpretation:`);
            console.log(`      1 YES_AAVE = ${adjustedPrice.toFixed(4)} YES_GHO`);
            console.log(`      (If AAVE = 158 GHO, fair value = 158 YES_GHO per YES_AAVE)`);
        } else {
            console.log(`\n   📈 Interpretation:`);
            console.log(`      1 NO_AAVE = ${adjustedPrice.toFixed(4)} NO_GHO`);
        }

    } catch (e) {
        console.log(`   ❌ Error reading pool: ${e.message}`);
    }
}

async function checkPoolBalances(provider, poolAddress, tokenA, tokenB, label) {
    const tA = new ethers.Contract(tokenA, ERC20_ABI, provider);
    const tB = new ethers.Contract(tokenB, ERC20_ABI, provider);

    try {
        const [balA, balB, symA, symB] = await Promise.all([
            tA.balanceOf(poolAddress),
            tB.balanceOf(poolAddress),
            tA.symbol(),
            tB.symbol()
        ]);

        console.log(`   ${label} Pool:`);
        console.log(`      ${symA}: ${ethers.formatEther(balA)} tokens`);
        console.log(`      ${symB}: ${ethers.formatEther(balB)} tokens`);
    } catch (e) {
        console.log(`   ❌ Error: ${e.message}`);
    }
}

main().catch(console.error);
