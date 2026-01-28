/**
 * Deploy VLRFlashArbitrageV2
 * Uses Universal Router + Permit2
 */

const hre = require("hardhat");

async function main() {
    console.log("Deploying VLRFlashArbitrageV2...");
    console.log("Network:", hre.network.name);

    const [deployer] = await hre.ethers.getSigners();
    console.log("Deployer:", deployer.address);

    const balance = await hre.ethers.provider.getBalance(deployer.address);
    console.log("Balance:", hre.ethers.formatEther(balance), "ETH");

    // Deploy
    const VLRFlashArbitrageV2 = await hre.ethers.getContractFactory("VLRFlashArbitrageV2");
    const contract = await VLRFlashArbitrageV2.deploy();
    await contract.waitForDeployment();

    const address = await contract.getAddress();
    console.log("\n✅ VLRFlashArbitrageV2 deployed to:", address);

    // Wait for confirmations
    console.log("\nWaiting for confirmations...");
    await contract.deploymentTransaction().wait(3);

    // Verify
    console.log("\nVerifying on Etherscan...");
    try {
        await hre.run("verify:verify", {
            address: address,
            constructorArguments: []
        });
        console.log("✅ Verified on Etherscan");
    } catch (e) {
        console.log("Verification failed:", e.message);
    }

    console.log("\n═".repeat(60));
    console.log("DEPLOYMENT COMPLETE");
    console.log("═".repeat(60));
    console.log("Contract:", address);
    console.log("\nUpdate .env with:");
    console.log(`VLR_FLASH_ARBITRAGE_V2_ADDRESS=${address}`);
}

main().catch(console.error);
