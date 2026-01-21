/**
 * 🚀 Real Arbitrage Execution
 * 
 * Strategy: SPOT_SPLIT (Borrow GNO)
 * Amount: 2 GNO
 */

const { ethers } = require("hardhat");

const CONFIG = {
    contractAddress: "0x5649CA18945a8cf36945aA2674f74db3634157cC",
    proposalAddress: "0x45e1064348fD8A407D6D1F59Fc64B05F633b28FC",
    gnoAddress: "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb",

    // Trade Params
    amount: "0.000001",
    minProfit: "0", // 0 for debugging
    direction: 0       // SPOT_SPLIT
};

async function main() {
    console.log("\n🚀 PREPARING REAL ARBITRAGE EXECUTION\n");
    console.log("=".repeat(60));

    const [signer] = await ethers.getSigners();
    console.log(`👤 Signer: ${signer.address}`);
    console.log(`💰 Balance: ${ethers.formatEther(await ethers.provider.getBalance(signer.address))} xDAI`);

    const contract = await ethers.getContractAt("GnosisFlashArbitrageV3", CONFIG.contractAddress, signer);

    const borrowAmount = ethers.parseEther(CONFIG.amount);
    const minProfit = ethers.parseEther(CONFIG.minProfit);

    console.log(`\nStrategy:   SPOT_SPLIT (Borrow GNO)`);
    console.log(`Amount:     ${CONFIG.amount} GNO`);
    console.log(`Min Profit: ${CONFIG.minProfit} GNO`);

    // 1. Static Call Simulation
    console.log("\n⏳ Simulating trade (Static Call)...");
    try {
        const result = await contract.executeArbitrage.staticCall(
            CONFIG.proposalAddress,
            CONFIG.gnoAddress,
            borrowAmount,
            CONFIG.direction,
            minProfit
        );

        console.log("✅ Simulation SUCCEEDED!");
        console.log(`   Estimated Profit: ${ethers.formatEther(result.profit)} GNO`);

    } catch (error) {
        console.log("⚠️  Simulation FAILED (Continuing anyway for debugging)...");
        const reason = error.data ? decodeError(error.data) : error.message;
        console.log(`   Reason: ${reason}`);
    }

    // 2. Real Execution
    // To prevent accidental runs, this requires an environment variable
    if (process.env.CONFIRM !== "true") {
        console.log("\n⚠️  SAFETY CHECK: Real execution requires CONFIRM=true environment variable.");
        console.log("   Run with: $env:CONFIRM=\"true\"; npx hardhat run scripts/real-execute.js --network gnosis");
        return;
    }

    console.log("\n🔥 EXECUTING REAL TRANSACTION...");
    try {
        const tx = await contract.executeArbitrage(
            CONFIG.proposalAddress,
            CONFIG.gnoAddress,
            borrowAmount,
            CONFIG.direction,
            minProfit,
            { gasLimit: 2000000 } // Higher gas limit for safety
        );

        console.log(`📝 TX Hash: ${tx.hash}`);
        console.log("   Waiting for confirmation...");

        const receipt = await tx.wait();
        console.log(`\n✅ TRANSACTION MINED!`);
        console.log(`   Block: ${receipt.blockNumber}`);
        console.log(`   Gas Used: ${receipt.gasUsed.toString()}`);
        console.log(`   Status: ${receipt.status === 1 ? 'Success' : 'Failed'}`);

        // Check for ArbitrageExecuted event
        const event = receipt.logs.find(log => log.address.toLowerCase() === CONFIG.contractAddress.toLowerCase());
        if (event) {
            console.log("\n🎉 Arbitrage event detected in logs!");
        }

    } catch (error) {
        console.log("\n❌ Transaction FAILED!");
        console.log(`   Message: ${error.message}`);
    }

    console.log("\n" + "=".repeat(60));
}

function decodeError(data) {
    try {
        const iface = new ethers.Interface(["error Error(string)"]);
        const decoded = iface.parseError(data);
        return decoded.args[0];
    } catch {
        return data;
    }
}

main().then(() => process.exit(0)).catch(console.error);
