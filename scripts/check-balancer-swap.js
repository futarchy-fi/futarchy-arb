/**
 * Check Balancer V2 Swap Cost: GHO <-> AAVE (3-hop path)
 * Path: GHO -> GYD -> wstETH -> AAVE
 * 
 * Uses queryBatchSwap to simulate without executing
 */

const { ethers } = require("ethers");
require("dotenv").config();

const RPC = process.env.RPC_URL || "https://ethereum.publicnode.com";

// Balancer V2 Vault
const VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";

// Tokens
const GHO = "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f";
const GYD = "0xe07F9D810a48ab5c3c914BA3cA53AF14E4491e8A";
const wstETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
const AAVE = "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9";

// Pool IDs
const GHO_GYD_POOL = "0xaa7a70070e7495fe86c67225329dbd39baa2f63b000200000000000000000663";
const GYD_WSTETH_POOL = "0xc8cf54b0b70899ea846b70361e62f3f5b22b1f4b0002000000000000000006c7";
const WSTETH_AAVE_POOL = "0x3de27efa2f1aa663ae5d458857e731c129069f29000200000000000000000588";

// Minimal ABI for queryBatchSwap
const VAULT_ABI = [
    "function queryBatchSwap(uint8 kind, tuple(bytes32 poolId, uint256 assetInIndex, uint256 assetOutIndex, uint256 amount, bytes userData)[] swaps, address[] assets, tuple(address sender, bool fromInternalBalance, address recipient, bool toInternalBalance) funds) external returns (int256[] memory assetDeltas)"
];

async function main() {
    const provider = new ethers.JsonRpcProvider(RPC);
    const vault = new ethers.Contract(VAULT, VAULT_ABI, provider);

    console.log("╔════════════════════════════════════════════════════════════════╗");
    console.log("║  BALANCER V2 SWAP COST ANALYSIS (GHO <-> AAVE)                 ║");
    console.log("╚════════════════════════════════════════════════════════════════╝\n");

    // Test amounts
    const testAmounts = ["1", "5", "10", "50", "100", "158"];

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📊 GHO -> AAVE (3-hop: GHO -> GYD -> wstETH -> AAVE)");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    for (const amt of testAmounts) {
        await quoteGhoToAave(vault, amt);
    }

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📊 AAVE -> GHO (3-hop: AAVE -> wstETH -> GYD -> GHO)");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    const aaveAmounts = ["0.01", "0.05", "0.1", "0.5", "1"];
    for (const amt of aaveAmounts) {
        await quoteAaveToGho(vault, amt);
    }
}

async function quoteGhoToAave(vault, amountStr) {
    const amount = ethers.parseEther(amountStr);

    // Path: GHO -> GYD -> wstETH -> AAVE
    const assets = [GHO, GYD, wstETH, AAVE];
    const swaps = [
        { poolId: GHO_GYD_POOL, assetInIndex: 0, assetOutIndex: 1, amount: amount, userData: "0x" },
        { poolId: GYD_WSTETH_POOL, assetInIndex: 1, assetOutIndex: 2, amount: 0, userData: "0x" },
        { poolId: WSTETH_AAVE_POOL, assetInIndex: 2, assetOutIndex: 3, amount: 0, userData: "0x" }
    ];
    const funds = {
        sender: ethers.ZeroAddress,
        fromInternalBalance: false,
        recipient: ethers.ZeroAddress,
        toInternalBalance: false
    };

    try {
        const deltas = await vault.queryBatchSwap.staticCall(0, swaps, assets, funds);
        const ghoIn = Number(ethers.formatEther(deltas[0]));
        const aaveOut = -Number(ethers.formatEther(deltas[3])); // Negative means received

        const effectivePrice = ghoIn / aaveOut;
        const spotPrice = 158; // Current AAVE/GHO price
        const slippage = ((effectivePrice - spotPrice) / spotPrice) * 100;

        console.log(`   ${amountStr.padStart(6)} GHO -> ${aaveOut.toFixed(6)} AAVE`);
        console.log(`          Effective: ${effectivePrice.toFixed(2)} GHO/AAVE | Spot: ${spotPrice} | Slippage: ${slippage.toFixed(2)}%\n`);
    } catch (e) {
        console.log(`   ${amountStr} GHO: ❌ Error - ${e.message.slice(0, 50)}`);
    }
}

async function quoteAaveToGho(vault, amountStr) {
    const amount = ethers.parseEther(amountStr);

    // Path: AAVE -> wstETH -> GYD -> GHO
    const assets = [AAVE, wstETH, GYD, GHO];
    const swaps = [
        { poolId: WSTETH_AAVE_POOL, assetInIndex: 0, assetOutIndex: 1, amount: amount, userData: "0x" },
        { poolId: GYD_WSTETH_POOL, assetInIndex: 1, assetOutIndex: 2, amount: 0, userData: "0x" },
        { poolId: GHO_GYD_POOL, assetInIndex: 2, assetOutIndex: 3, amount: 0, userData: "0x" }
    ];
    const funds = {
        sender: ethers.ZeroAddress,
        fromInternalBalance: false,
        recipient: ethers.ZeroAddress,
        toInternalBalance: false
    };

    try {
        const deltas = await vault.queryBatchSwap.staticCall(0, swaps, assets, funds);
        const aaveIn = Number(ethers.formatEther(deltas[0]));
        const ghoOut = -Number(ethers.formatEther(deltas[3]));

        const effectivePrice = ghoOut / aaveIn;
        const spotPrice = 158;
        const slippage = ((spotPrice - effectivePrice) / spotPrice) * 100;

        console.log(`   ${amountStr.padStart(6)} AAVE -> ${ghoOut.toFixed(2)} GHO`);
        console.log(`          Effective: ${effectivePrice.toFixed(2)} GHO/AAVE | Spot: ${spotPrice} | Slippage: ${slippage.toFixed(2)}%\n`);
    } catch (e) {
        console.log(`   ${amountStr} AAVE: ❌ Error - ${e.message.slice(0, 50)}`);
    }
}

main().catch(console.error);
