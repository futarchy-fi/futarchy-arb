/**
 * Debug Script for AAVE/GHO Arbitrage V6
 * 
 * V6 Features:
 * - Dynamic token loading
 * - Correct GHO/USDC fee tier (0.05%)
 * - Universal Router + Permit2
 */

require("dotenv").config();
const { ethers } = require("ethers");

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
    contract: "0xBc69Db11D5Eb837926E8f5Bb6Dd20069193919AE",
    proposal: "0xfb45ae9d8e5874e85b8e23d735eb9718efef47fa",

    rpc: process.env.MAINNET_RPC_URL || "https://ethereum.publicnode.com",
};

// Hardcoded tokens for balance checks
const TOKENS = {
    AAVE: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
    GHO: "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f",
    YES_AAVE: "0x63Ad5275380416b3700B84BFaD3B74ED812dfAE4",
    NO_AAVE: "0xf7c5a22Aeeb87c8E06b1a2bF40ab46c1e944f837",
    YES_GHO: "0x01917fD18c1019389cC89457c53E6631A13c1e9D",
    NO_GHO: "0xA31EF4bEfE367064fB0D8863A3E0AAD50054B917",
};

// V6 uses the updated signature with proposal address
const V6_ABI = [
    "function executeArbitrage(address proposalAddress, uint256 borrowAmount, uint8 direction, uint256 minProfit) external returns (tuple(bool success, uint256 profit, uint256 borrowAmount, uint256 gasUsed))",
    "function admin() view returns (address)",
];

const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
];

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    console.log("══════════════════════════════════════════════════════════════════════");
    console.log("🔍 AAVE/GHO ARBITRAGE V6 DEBUG");
    console.log("══════════════════════════════════════════════════════════════════════");
    console.log("");
    console.log("Contract:", CONFIG.contract);
    console.log("Proposal:", CONFIG.proposal);
    console.log("");

    const provider = new ethers.JsonRpcProvider(CONFIG.rpc);
    const contract = new ethers.Contract(CONFIG.contract, V6_ABI, provider);

    // Test contract
    console.log("📋 STEP 1: Contract Verification");
    try {
        const admin = await contract.admin();
        console.log("✅ Contract deployed. Admin:", admin);
    } catch (e) {
        console.log("❌ Contract error:", e.message.slice(0, 80));
        return;
    }

    // Check token balances
    console.log("\n📋 STEP 2: Token Balances");
    for (const [name, address] of Object.entries(TOKENS)) {
        const token = new ethers.Contract(address, ERC20_ABI, provider);
        const balance = await token.balanceOf(CONFIG.contract);
        console.log(`   ${name}: ${ethers.formatUnits(balance, 18)}`);
    }

    // Test strategies with staticCall
    console.log("\n📋 STEP 3: Testing executeArbitrage (staticCall)");
    console.log("──────────────────────────────────────────────────────────────────────");

    const testAmounts = [
        ethers.parseEther("0.1"),
        ethers.parseEther("1.0"),
    ];

    for (const amount of testAmounts) {
        const amountStr = ethers.formatEther(amount);

        // Test SPOT_SPLIT (direction = 0)
        // Should be PROFITABLE now!
        try {
            const result = await contract.executeArbitrage.staticCall(
                CONFIG.proposal,
                amount,
                0,  // SPOT_SPLIT
                0,  // minProfit = 0
                { gasLimit: 5000000 }
            );
            console.log(`✅ ${amountStr} AAVE SPOT_SPLIT: PROFIT = ${ethers.formatEther(result.profit)} AAVE`);
        } catch (e) {
            const reason = parseError(e);
            console.log(`❌ ${amountStr} AAVE SPOT_SPLIT: ${reason}`);
        }

        // Test MERGE_SPOT (direction = 1)
        // Should be UNPROFITABLE
        try {
            const result = await contract.executeArbitrage.staticCall(
                CONFIG.proposal,
                amount,
                1,  // MERGE_SPOT
                0,  // minProfit = 0
                { gasLimit: 5000000 }
            );
            console.log(`✅ ${amountStr} AAVE MERGE_SPOT: PROFIT = ${ethers.formatEther(result.profit)} AAVE`);
        } catch (e) {
            const reason = parseError(e);
            console.log(`❌ ${amountStr} AAVE MERGE_SPOT: ${reason}`);
        }
    }
}

function parseError(e) {
    if (e.data) {
        if (e.data.startsWith("0x08c379a0")) { // Error(string)
            try {
                return `Error: "${ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + e.data.slice(10))[0]}"`;
            } catch { return "Error(string)"; }
        }
        if (e.data.startsWith("0x3566cf0d")) { // ArbitrageFailed
            try {
                // Decode manually: uint256, uint256, string
                // The issue is AbiCoder needs strict types
                // Let's just return the raw hex or part of it
                return "ArbitrageFailed (insufficient profit/balance)";
            } catch { return "ArbitrageFailed"; }
        }
    }
    return e.message?.slice(0, 100);
}

main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
