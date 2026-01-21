/**
 * 🚀 Execute Real Arbitrage Transaction
 * 1. Simulates via staticCall (but ignores failure)
 * 2. Broadcasts REAL transaction with forced gas limit
 */

const { ethers } = require("hardhat");

const CONFIG = {
    CONTRACT: "0xe0545480aAB67Bc855806b1f64486F5c77F08eCC",
    PROPOSAL: "0x45e1064348fD8A407D6D1F59Fc64B05F633b28FC",
    GNO: "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb",

    // Safety Limits
    AMOUNT: "0.000001", // Very small test amount (1u GNO)
    MIN_PROFIT: "0"     // Accept small loss for testing mechanism
};

async function main() {
    console.log("\n🚀 EXECUTING REAL ARBITRAGE TEST (FORCED)");
    console.log("=".repeat(60));

    const [signer] = await ethers.getSigners();
    console.log(`👤 Executor: ${signer.address}`);
    console.log(`📍 Contract: ${CONFIG.CONTRACT}`);
    console.log(`💰 Amount:   ${CONFIG.AMOUNT} GNO`);

    const contract = await ethers.getContractAt("GnosisFlashArbitrageV3", CONFIG.CONTRACT, signer);
    const amountIdx = ethers.parseEther(CONFIG.AMOUNT);

    // ---------------------------------------------------------
    // 1. SIMULATION (Static Call)
    // ---------------------------------------------------------
    console.log("\n1️⃣  Running Simulation (staticCall)...");

    try {
        const result = await contract.executeArbitrage.staticCall(
            CONFIG.PROPOSAL,
            CONFIG.GNO,
            amountIdx,
            0, // SPOT_SPLIT
            0  // minProfit
        );

        console.log("   ✅ Simulation Successful!");
        console.log(`      Profit: ${ethers.formatEther(result.profit)} GNO`);

    } catch (error) {
        console.log(`   ❌ Simulation FAILED! But proceeding as requested...`);
        console.log(`   Reason: ${error.reason || error.message.slice(0, 100)}...`);
        // FORCE CONTINUE
    }

    // ---------------------------------------------------------
    // 2. REAL EXECUTION
    // ---------------------------------------------------------
    console.log("\n2️⃣  Broadcasting REAL Transaction...");

    try {
        const tx = await contract.executeArbitrage(
            CONFIG.PROPOSAL,
            CONFIG.GNO,
            amountIdx,
            0, // SPOT_SPLIT
            0,  // minProfit
            { gasLimit: 2000000 } // Force gas limit to bypass estimation
        );

        console.log(`   🚀 Tx Sent! Hash: ${tx.hash}`);
        console.log("   ⏳ Waiting for confirmation...");

        const receipt = await tx.wait();
        console.log(`   ✅ Transaction Confirmed in Block ${receipt.blockNumber}`);
        console.log(`   🔗 Explorer: https://gnosisscan.io/tx/${tx.hash}`);

    } catch (error) {
        console.log(`   ❌ Transaction FAILED during wait/mining!`);
        console.log(`   Reason: ${error.reason || error.message}`);
        if (error.transactionHash) {
            console.log(`   🔗 Explorer: https://gnosisscan.io/tx/${error.transactionHash}`);
        }
    }

    console.log("\n" + "=".repeat(60));
}

main().then(() => process.exit(0)).catch(console.error);
