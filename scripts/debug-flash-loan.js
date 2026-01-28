/**
 * Debug: Test V3 Flash Loan in isolation
 * Just borrow and repay, no swaps
 */

const { ethers } = require("ethers");
require("dotenv").config();

// Minimal contract to test V3 flash loan only
const SIMPLE_FLASH_ABI = [
    "function executeArbitrage(address proposalAddress, address borrowToken, uint256 borrowAmount, uint8 direction, uint256 minProfit) external returns (tuple(bool success, uint256 profit, uint256 borrowAmount) result)"
];

const GHO = "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f";
const AAVE = "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9";

async function main() {
    console.log("🔍 DEBUG: Test Flash Loan in Isolation\n");

    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || "https://ethereum.publicnode.com");

    if (!process.env.PRIVATE_KEY_AAVE) {
        console.log("❌ No PRIVATE_KEY_AAVE");
        return;
    }

    const signer = new ethers.Wallet(process.env.PRIVATE_KEY_AAVE, provider);
    console.log(`👤 Wallet: ${signer.address}`);

    // Check GHO token info
    const ghoAbi = [
        "function name() view returns (string)",
        "function symbol() view returns (string)",
        "function balanceOf(address) view returns (uint256)",
        "function totalSupply() view returns (uint256)"
    ];

    const gho = new ethers.Contract(GHO, ghoAbi, provider);

    console.log("\n📋 GHO Token:");
    console.log(`   Name: ${await gho.name()}`);
    console.log(`   Symbol: ${await gho.symbol()}`);
    console.log(`   Total Supply: ${ethers.formatEther(await gho.totalSupply())}`);

    // Check V3 Vault GHO balance
    const v3Vault = "0xbA1333333333a1BA1108E8412f11850A5C319bA9";
    const v3GhoBalance = await gho.balanceOf(v3Vault);
    console.log(`   V3 Vault Balance: ${ethers.formatEther(v3GhoBalance)} GHO`);

    // Check if there's enough GHO for flash loan
    if (v3GhoBalance < ethers.parseEther("1")) {
        console.log("\n⚠️  V3 Vault has low GHO balance!");
    }

    // Check AAVE token in V3 Vault
    const aaveToken = new ethers.Contract(AAVE, ghoAbi, provider);
    const v3AaveBalance = await aaveToken.balanceOf(v3Vault);
    console.log(`   V3 Vault AAVE Balance: ${ethers.formatEther(v3AaveBalance)} AAVE`);

    // Try to simulate the call
    const contract = new ethers.Contract(
        "0x098321F3f0d20dD4fc9559267a9B1c88AaDd2876",
        SIMPLE_FLASH_ABI,
        signer
    );

    console.log("\n🔬 Simulating executeArbitrage with 0.01 GHO...");

    try {
        // Use staticCall to simulate without sending
        const result = await contract.executeArbitrage.staticCall(
            "0xFb45aE9d8e5874e85b8e23D735EB9718EfEF47Fa", // proposal
            GHO,           // borrowToken
            ethers.parseEther("0.01"),  // borrowAmount - very small
            1,             // MERGE_SPOT
            0              // minProfit
        );
        console.log("   ✅ Simulation passed!");
        console.log(`   Result: ${JSON.stringify(result)}`);
    } catch (e) {
        console.log(`   ❌ Simulation failed: ${e.message.slice(0, 200)}`);

        // Try with AAVE instead
        console.log("\n🔬 Trying with AAVE instead...");
        try {
            const result = await contract.executeArbitrage.staticCall(
                "0xFb45aE9d8e5874e85b8e23D735EB9718EfEF47Fa",
                AAVE,
                ethers.parseEther("0.001"),
                0,  // SPOT_SPLIT
                0
            );
            console.log("   ✅ AAVE simulation passed!");
        } catch (e2) {
            console.log(`   ❌ AAVE simulation also failed: ${e2.message.slice(0, 200)}`);
        }
    }
}

main().catch(console.error);
