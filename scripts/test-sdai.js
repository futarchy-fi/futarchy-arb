/**
 * Test sDAI Borrow (MERGE_SPOT strategy)
 */

const { ethers } = require("hardhat");

const CONTRACT = "0x5649CA18945a8cf36945aA2674f74db3634157cC";
const PROPOSAL = "0x45e1064348fD8A407D6D1F59Fc64B05F633b28FC";
const GNO = "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb";
const SDAI = "0xaf204776c7245bF4147c2612BF6e5972Ee483701";

async function main() {
    console.log("\n🔍 Testing sDAI Borrow (MERGE_SPOT)\n");
    console.log("=".repeat(60));

    const [signer] = await ethers.getSigners();
    const contract = await ethers.getContractAt("GnosisFlashArbitrageV3", CONTRACT, signer);

    // Test various sDAI amounts
    const amounts = ["1", "10", "50", "100", "500"];

    console.log("Testing SDAI amounts (MERGE_SPOT = strategy 1)...\n");

    for (const amtStr of amounts) {
        const amount = ethers.parseEther(amtStr);

        try {
            const result = await contract.executeArbitrage.staticCall(
                PROPOSAL,
                SDAI,    // Borrow sDAI
                amount,
                1,       // MERGE_SPOT
                0        // min profit 0
            );

            const profitNum = Number(ethers.formatEther(result.profit));
            const inputNum = Number(amtStr);
            const profitPercent = (profitNum / inputNum) * 100;

            console.log(`✅ ${amtStr.padStart(5)} sDAI → Profit: ${profitNum.toFixed(4)} sDAI (${profitPercent.toFixed(2)}%)`);

            // Show leftovers if any
            if (result.leftoverYesGno > 0n || result.leftoverNoGno > 0n) {
                console.log(`    Leftovers: YES_GNO=${ethers.formatEther(result.leftoverYesGno)}, NO_GNO=${ethers.formatEther(result.leftoverNoGno)}`);
            }

        } catch (error) {
            let reason = "Unknown";
            if (error.data && error.data.length > 10) {
                try {
                    const iface = new ethers.Interface(["error Error(string)"]);
                    const decoded = iface.parseError(error.data);
                    reason = decoded.args[0];
                } catch {
                    reason = "Slippage/liquidity issue";
                }
            }
            console.log(`❌ ${amtStr.padStart(5)} sDAI → FAILED: ${reason}`);
        }
    }

    console.log("\n" + "=".repeat(60));
}

main().then(() => process.exit(0)).catch(console.error);
