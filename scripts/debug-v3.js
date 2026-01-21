/**
 * Debug V3 Contract
 */

const { ethers } = require("hardhat");

const CONTRACT = "0x075899a15c56a83ff1874e91df316d902de115f7";
const PROPOSAL = "0x45e1064348fD8A407D6D1F59Fc64B05F633b28FC";
const GNO = "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb";

async function main() {
    console.log("\n🔍 Debug V3 Contract\n");

    const [signer] = await ethers.getSigners();
    const contract = await ethers.getContractAt("GnosisFlashArbitrageV3", CONTRACT, signer);

    // Test 1: Can we load proposal?
    console.log("📍 Test 1: loadProposal()");
    try {
        const info = await contract.loadProposal(PROPOSAL);
        console.log(`   Valid: ${info.isValid}`);
        console.log(`   YES Pool: ${info.yesPool}`);
    } catch (e) {
        console.log(`   ❌ Failed: ${e.message.slice(0, 80)}`);
    }

    // Test 2: Check owner
    console.log("\n📍 Test 2: owner()");
    try {
        const owner = await contract.owner();
        console.log(`   Owner: ${owner}`);
        console.log(`   Is signer owner: ${owner.toLowerCase() === signer.address.toLowerCase()}`);
    } catch (e) {
        console.log(`   ❌ Failed: ${e.message.slice(0, 80)}`);
    }

    // Test 3: Check V3 Vault
    console.log("\n📍 Test 3: balancerVault()");
    try {
        const vault = await contract.balancerVault();
        console.log(`   Vault: ${vault}`);
    } catch (e) {
        console.log(`   ❌ Failed: ${e.message.slice(0, 80)}`);
    }

    // Test 4: Try static call with more details
    console.log("\n📍 Test 4: executeArbitrage staticCall with try/catch details");
    const amount = ethers.parseEther("0.001");
    try {
        const result = await contract.executeArbitrage.staticCall(
            PROPOSAL, GNO, amount, 0, 0
        );
        console.log("   ✅ SUCCESS!");
        console.log(`   Profit: ${result.profit}`);
    } catch (error) {
        console.log(`   ❌ Failed`);
        console.log(`   Error code: ${error.code}`);
        console.log(`   Reason: ${error.reason}`);
        console.log(`   Message: ${error.message.slice(0, 200)}`);

        // Try to decode the error
        if (error.data) {
            console.log(`   Error data: ${error.data}`);
        }
    }

    console.log("\nDone!");
}

main().then(() => process.exit(0)).catch(console.error);
