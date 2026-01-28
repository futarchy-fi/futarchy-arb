/**
 * Debug Balancer V2 3-hop path GHO <-> AAVE
 * Tests each pool individually and the full path
 */

const { ethers } = require("ethers");
require("dotenv").config();

const VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";

// Tokens
const GHO = "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f";
const GYD = "0xe07F9D810a48ab5c3c914BA3cA53AF14E4491e8A";
const WSTETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
const AAVE = "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9";

// Pool IDs
const GHO_GYD_POOL = "0xaa7a70070e7495fe86c67225329dbd39baa2f63b000200000000000000000663";
const GYD_WSTETH_POOL = "0xc8cf54b0b70899ea846b70361e62f3f5b22b1f4b0002000000000000000006c7";
const WSTETH_AAVE_POOL = "0x3de27efa2f1aa663ae5d458857e731c129069f29000200000000000000000588";

const VAULT_ABI = [
    `function getPoolTokens(bytes32 poolId) external view returns (address[] tokens, uint256[] balances, uint256 lastChangeBlock)`,
    `function getPool(bytes32 poolId) external view returns (address, uint8)`,
    `function queryBatchSwap(
        uint8 kind,
        (bytes32 poolId, uint256 assetInIndex, uint256 assetOutIndex, uint256 amount, bytes userData)[] swaps,
        address[] assets,
        (address sender, bool fromInternalBalance, address recipient, bool toInternalBalance) funds
    ) external returns (int256[])`
];

async function main() {
    console.log("🔍 DEBUG: Balancer V2 Path Analysis\n");

    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || "https://ethereum.publicnode.com");
    const vault = new ethers.Contract(VAULT, VAULT_ABI, provider);

    // Check each pool
    console.log("═".repeat(60));
    console.log("POOL ANALYSIS");
    console.log("═".repeat(60));

    const pools = [
        { name: "GHO/GYD", id: GHO_GYD_POOL },
        { name: "GYD/wstETH", id: GYD_WSTETH_POOL },
        { name: "wstETH/AAVE", id: WSTETH_AAVE_POOL }
    ];

    for (const pool of pools) {
        console.log(`\n📊 Pool: ${pool.name}`);
        console.log(`   ID: ${pool.id}`);

        // Extract pool address from ID
        const poolAddress = "0x" + pool.id.slice(2, 42);
        console.log(`   Address: ${poolAddress}`);

        try {
            // Get pool info
            const [poolAddr, specialization] = await vault.getPool(pool.id);
            console.log(`   Registered Address: ${poolAddr}`);
            console.log(`   Specialization: ${specialization}`);

            // Get pool tokens
            const [tokens, balances, lastBlock] = await vault.getPoolTokens(pool.id);
            console.log(`   Tokens:`);
            for (let i = 0; i < tokens.length; i++) {
                const symbol = getSymbol(tokens[i]);
                const balance = ethers.formatEther(balances[i]);
                console.log(`     [${i}] ${symbol}: ${parseFloat(balance).toFixed(6)}`);
            }
            console.log(`   Last Change Block: ${lastBlock}`);
        } catch (e) {
            console.log(`   ❌ Error: ${e.message}`);
        }
    }

    // Test full path query
    console.log("\n" + "═".repeat(60));
    console.log("QUERY TEST: GHO → AAVE");
    console.log("═".repeat(60));

    const testAmount = ethers.parseEther("1"); // 1 GHO
    console.log(`\nInput: 1 GHO`);

    try {
        const assets = [GHO, GYD, WSTETH, AAVE];
        const swaps = [
            { poolId: GHO_GYD_POOL, assetInIndex: 0, assetOutIndex: 1, amount: testAmount, userData: "0x" },
            { poolId: GYD_WSTETH_POOL, assetInIndex: 1, assetOutIndex: 2, amount: 0n, userData: "0x" },
            { poolId: WSTETH_AAVE_POOL, assetInIndex: 2, assetOutIndex: 3, amount: 0n, userData: "0x" }
        ];
        const funds = {
            sender: "0x0000000000000000000000000000000000000001",  // Dummy address for query
            fromInternalBalance: false,
            recipient: "0x0000000000000000000000000000000000000001",
            toInternalBalance: false
        };

        const deltas = await vault.queryBatchSwap.staticCall(0, swaps, assets, funds);

        console.log(`\nDeltas (positive = sent, negative = received):`);
        console.log(`  [0] GHO:    ${ethers.formatEther(deltas[0])}`);
        console.log(`  [1] GYD:    ${ethers.formatEther(deltas[1])}`);
        console.log(`  [2] wstETH: ${ethers.formatEther(deltas[2])}`);
        console.log(`  [3] AAVE:   ${ethers.formatEther(deltas[3])}`);

        const aaveOut = -Number(deltas[3]);
        console.log(`\n✅ Output: ${ethers.formatEther(BigInt(aaveOut))} AAVE`);

    } catch (e) {
        console.log(`\n❌ Query Failed: ${e.message}`);

        // Try to decode revert reason
        if (e.data) {
            console.log(`   Error Data: ${e.data}`);
        }
    }

    // Test individual hops
    console.log("\n" + "═".repeat(60));
    console.log("INDIVIDUAL HOP TESTS");
    console.log("═".repeat(60));

    // Hop 1: GHO → GYD
    await testSingleHop(vault, "GHO → GYD", GHO, GYD, GHO_GYD_POOL, testAmount);

    // Hop 2: GYD → wstETH  
    const gydAmount = ethers.parseEther("0.99"); // Approximate
    await testSingleHop(vault, "GYD → wstETH", GYD, WSTETH, GYD_WSTETH_POOL, gydAmount);

    // Hop 3: wstETH → AAVE
    const wstethAmount = ethers.parseEther("0.0003"); // Approximate
    await testSingleHop(vault, "wstETH → AAVE", WSTETH, AAVE, WSTETH_AAVE_POOL, wstethAmount);
}

async function testSingleHop(vault, name, tokenIn, tokenOut, poolId, amount) {
    console.log(`\n📊 ${name}`);
    try {
        const assets = [tokenIn, tokenOut];
        const swaps = [{ poolId, assetInIndex: 0, assetOutIndex: 1, amount, userData: "0x" }];
        const funds = {
            sender: "0x0000000000000000000000000000000000000001",
            fromInternalBalance: false,
            recipient: "0x0000000000000000000000000000000000000001",
            toInternalBalance: false
        };

        const deltas = await vault.queryBatchSwap.staticCall(0, swaps, assets, funds);
        console.log(`   In:  ${ethers.formatEther(deltas[0])} ${getSymbol(tokenIn)}`);
        console.log(`   Out: ${ethers.formatEther(-deltas[1])} ${getSymbol(tokenOut)}`);
        console.log(`   ✅ Works!`);
    } catch (e) {
        console.log(`   ❌ Failed: ${e.message.slice(0, 100)}`);
    }
}

function getSymbol(addr) {
    const symbols = {
        [GHO.toLowerCase()]: "GHO",
        [GYD.toLowerCase()]: "GYD",
        [WSTETH.toLowerCase()]: "wstETH",
        [AAVE.toLowerCase()]: "AAVE"
    };
    return symbols[addr.toLowerCase()] || addr.slice(0, 10);
}

main().catch(console.error);
