/**
 * Test V3 Contract with Result Struct
 * Shows profit + all leftovers sent to user
 */

const { ethers } = require("hardhat");

const CONTRACT = "0x833C9a4A9F635d314654f97495f64A3efFebd0dC";
const PROPOSAL = "0x45e1064348fD8A407D6D1F59Fc64B05F633b28FC";
const GNO = "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb";

async function main() {
    console.log("\n🧪 Testing V3 Contract with Result Struct\n");
    console.log("=".repeat(60));

    const [signer] = await ethers.getSigners();
    console.log(`Signer: ${signer.address}`);
    console.log(`Contract: ${CONTRACT}`);

    const contract = await ethers.getContractAt("GnosisFlashArbitrageV3", CONTRACT, signer);

    const amount = ethers.parseEther("0.000001");  // 0.000001 GNO
    console.log(`\nTesting SPOT_SPLIT with: ${ethers.formatEther(amount)} GNO`);

    console.log("\n⏳ Running static call...");

    try {
        // Static call returns the ArbitrageResult struct!
        const result = await contract.executeArbitrage.staticCall(
            PROPOSAL,
            GNO,
            amount,
            0,  // SPOT_SPLIT
            0   // min profit 0 for testing
        );

        console.log("\n✅ STATIC CALL SUCCEEDED!");
        console.log("\n📊 ArbitrageResult:");
        console.log(`   Success: ${result.success}`);
        console.log(`   Profit (GNO): ${ethers.formatEther(result.profit)}`);
        console.log(`\n   📦 Leftovers sent to caller:`);
        console.log(`   ├─ YES_GNO:  ${ethers.formatEther(result.leftoverYesGno)}`);
        console.log(`   ├─ NO_GNO:   ${ethers.formatEther(result.leftoverNoGno)}`);
        console.log(`   ├─ YES_SDAI: ${ethers.formatEther(result.leftoverYesSdai)}`);
        console.log(`   ├─ NO_SDAI:  ${ethers.formatEther(result.leftoverNoSdai)}`);
        console.log(`   ├─ GNO:      ${ethers.formatEther(result.leftoverGno)}`);
        console.log(`   └─ sDAI:     ${ethers.formatEther(result.leftoverSdai)}`);

        // Summary
        const profitNum = Number(ethers.formatEther(result.profit));
        const inputNum = Number(ethers.formatEther(amount));
        const profitPercent = (profitNum / inputNum) * 100;

        console.log(`\n   💰 Total Profit: ${profitNum.toFixed(8)} GNO (${profitPercent.toFixed(2)}%)`);

    } catch (error) {
        console.log(`\n❌ Static call FAILED!`);
        console.log(`   Reason: ${error.reason || error.message.slice(0, 200)}`);
    }

    console.log("\n" + "=".repeat(60));
}

main().then(() => process.exit(0)).catch(console.error);
