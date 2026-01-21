/**
 * Find Maximum Profitable Trade Size
 */

const { ethers } = require("hardhat");

const CONTRACT = "0x5649CA18945a8cf36945aA2674f74db3634157cC";
const PROPOSAL = "0x45e1064348fD8A407D6D1F59Fc64B05F633b28FC";
const GNO = "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb";

async function main() {
    console.log("\n🔍 Finding Maximum Profitable Trade Size\n");
    console.log("=".repeat(60));

    const [signer] = await ethers.getSigners();
    const contract = await ethers.getContractAt("GnosisFlashArbitrageV3", CONTRACT, signer);

    // Test various amounts
    const amounts = ["0.01", "0.1", "0.5", "1", "2", "5"];

    console.log("Testing amounts...\n");

    for (const amtStr of amounts) {
        const amount = ethers.parseEther(amtStr);

        try {
            const result = await contract.executeArbitrage.staticCall(
                PROPOSAL, GNO, amount, 0, 0
            );

            const profitNum = Number(ethers.formatEther(result.profit));
            const inputNum = Number(amtStr);
            const profitPercent = (profitNum / inputNum) * 100;

            console.log(`✅ ${amtStr.padStart(5)} GNO → Profit: ${profitNum.toFixed(6)} GNO (${profitPercent.toFixed(2)}%)`);

        } catch (error) {
            let reason = "Unknown";
            if (error.message.includes("Insufficient to repay")) {
                reason = "Can't repay flash loan - slippage too high";
            } else if (error.message.includes("Profit below")) {
                reason = "Profit below minimum";
            } else if (error.message.includes("liquidity")) {
                reason = "Pool liquidity insufficient";
            } else if (error.data && error.data.length > 10) {
                // Decode error string from hex data
                try {
                    const iface = new ethers.Interface(["error Error(string)"]);
                    const decoded = iface.parseError(error.data);
                    reason = decoded.args[0];
                } catch {
                    reason = "Slippage/liquidity issue";
                }
            }
            console.log(`❌ ${amtStr.padStart(5)} GNO → FAILED: ${reason}`);
        }
    }

    console.log("\n" + "=".repeat(60));
}

main().then(() => process.exit(0)).catch(console.error);
