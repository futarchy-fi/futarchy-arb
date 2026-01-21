/**
 * Test GnosisFlashArbitrageV3 Contract
 */

const { ethers } = require("hardhat");

const CONTRACT = "0x4fa55bd3fa3e66b85a7ac7880a42d8fab272f921";
const PROPOSAL = "0x45e1064348fD8A407D6D1F59Fc64B05F633b28FC";
const GNO = "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb";
const SDAI = "0xaf204776c7245bF4147c2612BF6e5972Ee483701";

async function main() {
    console.log("\n🧪 Testing GnosisFlashArbitrageV3\n");
    console.log("=".repeat(60));

    const [signer] = await ethers.getSigners();
    console.log(`Signer: ${signer.address}`);
    console.log(`Contract: ${CONTRACT}`);
    console.log(`Proposal: ${PROPOSAL}`);

    const contract = await ethers.getContractAt("GnosisFlashArbitrageV3", CONTRACT, signer);

    // Test 1: loadProposal view function
    console.log("\n📍 Test 1: loadProposal()");
    try {
        const info = await contract.loadProposal(PROPOSAL);
        console.log("✅ Proposal loaded successfully!");
        console.log(`   Valid: ${info.isValid}`);
        console.log(`   YES_GNO: ${info.yesGno}`);
        console.log(`   NO_GNO: ${info.noGno}`);
        console.log(`   YES_SDAI: ${info.yesSdai}`);
        console.log(`   NO_SDAI: ${info.noSdai}`);
        console.log(`   YES Pool: ${info.yesPool}`);
        console.log(`   NO Pool: ${info.noPool}`);
    } catch (e) {
        console.log(`❌ Failed: ${e.message.slice(0, 100)}`);
    }

    // Test 2: Check ownership
    console.log("\n📍 Test 2: Check ownership");
    try {
        const owner = await contract.owner();
        console.log(`   Owner: ${owner}`);
        console.log(`   Is caller owner: ${owner.toLowerCase() === signer.address.toLowerCase() ? 'YES ✅' : 'NO ❌'}`);
    } catch (e) {
        console.log(`❌ Failed: ${e.message.slice(0, 100)}`);
    }

    // Test 3: Static call SPOT_SPLIT with tiny amount
    console.log("\n📍 Test 3: Static call SPOT_SPLIT (0.01 GNO)");
    try {
        await contract.executeArbitrage.staticCall(
            PROPOSAL,
            GNO,
            ethers.parseEther("0.01"),
            0, // SPOT_SPLIT
            0  // min profit 0 for testing
        );
        console.log("✅ SPOT_SPLIT static call SUCCEEDED!");
    } catch (e) {
        console.log(`❌ Failed: ${e.reason || e.message.slice(0, 150)}`);
    }

    // Test 4: Static call MERGE_SPOT with tiny amount
    console.log("\n📍 Test 4: Static call MERGE_SPOT (1 sDAI)");
    try {
        await contract.executeArbitrage.staticCall(
            PROPOSAL,
            SDAI,
            ethers.parseEther("1"),
            1, // MERGE_SPOT
            0  // min profit 0 for testing
        );
        console.log("✅ MERGE_SPOT static call SUCCEEDED!");
    } catch (e) {
        console.log(`❌ Failed: ${e.reason || e.message.slice(0, 150)}`);
    }

    // Test 5: Check Balancer V3 Vault
    console.log("\n📍 Test 5: Check V3 Vault");
    try {
        const vault = await contract.balancerVault();
        console.log(`   V3 Vault: ${vault}`);
    } catch (e) {
        console.log(`❌ Failed: ${e.message.slice(0, 100)}`);
    }

    console.log("\n" + "=".repeat(60));
    console.log("Tests complete!\n");
}

main()
    .then(() => process.exit(0))
    .catch(console.error);
