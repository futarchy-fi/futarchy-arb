/**
 * Quick simulation test for V5 contract on Gnosis.
 * Uses staticCall to check if MERGE_SPOT with 50 sDAI is now profitable.
 *
 * Usage: npx hardhat run scripts/test-v5-simulation.js --network gnosis
 */
const { ethers } = require("hardhat");

const V5_ADDRESS = "0x59D327033035E16cEB95cd554D26886B59E4086e";
const PROPOSAL = "0x47c80f5f701ebc5f25cab64e660f0577890729c2";  // GIP-149
const SDAI = "0xaf204776c7245bF4147c2612BF6e5972Ee483701";
const GNO = "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb";

const ARB_FAILED_IFACE = new ethers.Interface([
    "error ArbitrageFailed(uint256 balanceAfter, uint256 borrowAmount, string reason)"
]);

async function testDirection(contract, label, borrowToken, amount, direction) {
    const amountWei = ethers.parseEther(amount);
    console.log(`\n${label}: ${amount} ${borrowToken === SDAI ? 'sDAI' : 'GNO'}`);
    console.log("-".repeat(50));

    try {
        const result = await contract.executeArbitrage.staticCall(
            PROPOSAL, borrowToken, amountWei, direction, 0
        );
        const profit = ethers.formatEther(result.profit);
        const pct = (parseFloat(profit) / parseFloat(amount) * 100).toFixed(4);
        console.log(`  SUCCESS! Profit: ${profit} (${pct}%)`);
        console.log(`  Leftovers: yesGno=${ethers.formatEther(result.leftoverYesGno)} noGno=${ethers.formatEther(result.leftoverNoGno)}`);
        console.log(`             yesSdai=${ethers.formatEther(result.leftoverYesSdai)} noSdai=${ethers.formatEther(result.leftoverNoSdai)}`);
        console.log(`             gno=${ethers.formatEther(result.leftoverGno)} sdai=${ethers.formatEther(result.leftoverSdai)}`);
        return { success: true, profit: parseFloat(profit) };
    } catch (e) {
        const revertData = e.data || e.error?.data;
        if (revertData && revertData !== "0x") {
            try {
                const decoded = ARB_FAILED_IFACE.parseError(revertData);
                const delta = ethers.formatEther(decoded.args[0] - decoded.args[1]);
                console.log(`  ArbitrageFailed: ${decoded.args[2]} (delta=${delta})`);
                return { success: false, delta: parseFloat(delta) };
            } catch (_) {}
        }
        console.log(`  Reverted: ${e.message?.slice(0, 150)}`);
        return { success: false };
    }
}

async function main() {
    const [signer] = await ethers.getSigners();
    const contract = await ethers.getContractAt("GnosisFlashArbitrageV5", V5_ADDRESS, signer);

    console.log("V5 Contract Simulation Test");
    console.log("=".repeat(50));
    console.log(`Contract: ${V5_ADDRESS}`);
    console.log(`Signer: ${signer.address}`);

    // Test MERGE_SPOT at various sizes
    const sdaiAmounts = ["10", "25", "50", "100", "200"];
    for (const amt of sdaiAmounts) {
        await testDirection(contract, "MERGE_SPOT", SDAI, amt, 1);
    }

    // Test SPOT_SPLIT at various sizes
    const gnoAmounts = ["0.05", "0.1", "0.25", "0.5"];
    for (const amt of gnoAmounts) {
        await testDirection(contract, "SPOT_SPLIT", GNO, amt, 0);
    }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
