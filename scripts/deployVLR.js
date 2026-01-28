/**
 * deployVLR.js - Deploy VLRFlashArbitrage to Mainnet
 * 
 * Usage:
 *   npx hardhat run scripts/deployVLR.js --network mainnet
 */

const hre = require("hardhat");

async function main() {
    console.log("═".repeat(60));
    console.log("🚀 Deploying VLRFlashArbitrage to Mainnet...");
    console.log("═".repeat(60));

    const [deployer] = await hre.ethers.getSigners();
    console.log(`\nDeployer: ${deployer.address}`);

    const balance = await hre.ethers.provider.getBalance(deployer.address);
    console.log(`Balance: ${hre.ethers.formatEther(balance)} ETH`);

    // Deploy
    console.log("\n📋 Deploying contract...");
    const VLRFlashArbitrage = await hre.ethers.getContractFactory("VLRFlashArbitrage");
    const contract = await VLRFlashArbitrage.deploy();
    await contract.waitForDeployment();

    const address = await contract.getAddress();
    console.log(`\n✅ VLRFlashArbitrage deployed to: ${address}`);

    // Wait for confirmations
    console.log("\n⏳ Waiting for confirmations...");
    await contract.deploymentTransaction().wait(5);
    console.log("✅ 5 confirmations received");

    // Verify
    console.log("\n📋 Verifying on Etherscan...");
    try {
        await hre.run("verify:verify", {
            address: address,
            constructorArguments: [],
        });
        console.log("✅ Verified on Etherscan");
    } catch (error) {
        if (error.message.includes("Already Verified")) {
            console.log("✅ Already verified");
        } else {
            console.log(`⚠️ Verification failed: ${error.message}`);
        }
    }

    console.log("\n" + "═".repeat(60));
    console.log("✅ Deployment Complete!");
    console.log("═".repeat(60));
    console.log(`\nContract Address: ${address}`);
    console.log(`\nNext steps:`);
    console.log(`1. Add to .env: VLR_CONTRACT_ADDRESS=${address}`);
    console.log(`2. Run bot: node scripts/arb-bot-vlr.js`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
