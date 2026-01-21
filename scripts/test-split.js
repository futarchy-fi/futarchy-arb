/**
 * Test Futarchy Router splitPosition with static call
 */

const { ethers } = require("hardhat");

const FUTARCHY_ROUTER = "0x7495a583ba85875d59407781b4958ED6e0E1228f";
const PROPOSAL = "0x45e1064348fD8A407D6D1F59Fc64B05F633b28FC";
const GNO = "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb";

async function main() {
    console.log("\n🧪 Testing Futarchy Router splitPosition (Static Call)\n");
    console.log("=".repeat(60));

    const [signer] = await ethers.getSigners();
    console.log(`Signer: ${signer.address}`);

    const router = new ethers.Contract(FUTARCHY_ROUTER, [
        "function splitPosition(address proposal, address collateralToken, uint256 amount) external"
    ], signer);

    const amount = ethers.parseEther("0.00001");  // 0.00001 GNO
    console.log(`\nProposal: ${PROPOSAL}`);
    console.log(`Collateral: ${GNO} (GNO)`);
    console.log(`Amount: ${ethers.formatEther(amount)} GNO`);

    // Test as static call (simulate without executing)
    console.log("\n📍 Testing staticCall...");

    try {
        await router.splitPosition.staticCall(PROPOSAL, GNO, amount);
        console.log("✅ splitPosition static call SUCCEEDED!");
        console.log("   The function can be called successfully");
        console.log("   (Note: actual execution would require GNO balance and approval)");
    } catch (error) {
        console.log("❌ splitPosition static call FAILED:");
        console.log(`   Reason: ${error.reason || error.message.slice(0, 100)}`);

        // Common reasons:
        if (error.message.includes("insufficient")) {
            console.log("   → Likely need more GNO balance");
        }
        if (error.message.includes("allowance")) {
            console.log("   → Need to approve router to spend GNO");
        }
        if (error.message.includes("revert")) {
            console.log("   → Contract reverted (check proposal validity)");
        }
    }

    // Also check if we have GNO balance
    console.log("\n📍 Checking GNO balance...");
    const gno = new ethers.Contract(GNO, [
        "function balanceOf(address) view returns (uint256)"
    ], signer);

    const balance = await gno.balanceOf(signer.address);
    console.log(`   GNO Balance: ${ethers.formatEther(balance)} GNO`);
    console.log(`   Have enough: ${balance >= amount ? 'YES ✅' : 'NO ❌'}`);

    // Check allowance
    console.log("\n📍 Checking GNO allowance to router...");
    const gnoFull = new ethers.Contract(GNO, [
        "function allowance(address owner, address spender) view returns (uint256)"
    ], signer);

    const allowance = await gnoFull.allowance(signer.address, FUTARCHY_ROUTER);
    console.log(`   Allowance: ${ethers.formatEther(allowance)} GNO`);
    console.log(`   Enough allowance: ${allowance >= amount ? 'YES ✅' : 'NO ❌'}`);

    console.log("\n" + "=".repeat(60));
    console.log("Done!\n");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("Error:", error);
        process.exit(1);
    });
