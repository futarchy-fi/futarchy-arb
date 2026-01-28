/**
 * Deploy AaveFlashArbitrageV2 to Ethereum Mainnet
 * 
 * Usage: npx hardhat run scripts/deploy-mainnet.js --network mainnet
 */

const { ethers } = require("hardhat");

async function main() {
    console.log("╔════════════════════════════════════════════════════════════════╗");
    console.log("║  DEPLOYING: AaveFlashArbitrageV2                               ║");
    console.log("║  Network: Ethereum Mainnet                                     ║");
    console.log("╚════════════════════════════════════════════════════════════════╝\n");

    const [deployer] = await ethers.getSigners();
    console.log(`👤 Deployer: ${deployer.address}`);

    const balance = await ethers.provider.getBalance(deployer.address);
    console.log(`💰 Balance: ${ethers.formatEther(balance)} ETH\n`);

    // Constructor Arguments (Verified Mainnet Addresses)
    const args = [
        "0xbA1333333333a1BA1108E8412f11850A5C319bA9", // Balancer V3 Vault
        "0xBA12222222228d8Ba445958a75a0704d566BF2C8", // Balancer V2 Vault
        "0xE592427A0AEce92De3Edee1F18E0157C05861564", // Uniswap V3 SwapRouter
        "0x1F98431c8aD98523631AE4a59f267346ea31F984", // Uniswap V3 Factory
        "0xAc9Bf8EbA6Bd31f8E8c76f8E8B2AAd0BD93f98Dc"  // Futarchy Router (Mainnet)
    ];

    console.log("📋 Constructor Arguments:");
    console.log(`   Balancer V3 Vault:    ${args[0]}`);
    console.log(`   Balancer V2 Vault:    ${args[1]}`);
    console.log(`   Uniswap V3 Router:    ${args[2]}`);
    console.log(`   Uniswap V3 Factory:   ${args[3]}`);
    console.log(`   Futarchy Router:      ${args[4]}\n`);

    // Deploy
    console.log("🚀 Deploying contract...");
    const Contract = await ethers.getContractFactory("AaveFlashArbitrageV2");
    const contract = await Contract.deploy(...args);

    await contract.waitForDeployment();
    const address = await contract.getAddress();

    console.log(`\n✅ DEPLOYED: ${address}`);
    console.log(`   TX Hash: ${contract.deploymentTransaction().hash}\n`);

    // Verification Instructions
    console.log("═══════════════════════════════════════════════════════════════════");
    console.log("📝 VERIFICATION COMMAND:");
    console.log("═══════════════════════════════════════════════════════════════════");
    console.log(`npx hardhat verify --network mainnet ${address} \\`);
    console.log(`  "${args[0]}" \\`);
    console.log(`  "${args[1]}" \\`);
    console.log(`  "${args[2]}" \\`);
    console.log(`  "${args[3]}" \\`);
    console.log(`  "${args[4]}"`);
    console.log("═══════════════════════════════════════════════════════════════════\n");

    return address;
}

main()
    .then((address) => {
        console.log(`\n🎉 Deployment successful! Contract: ${address}`);
        process.exit(0);
    })
    .catch((error) => {
        console.error("❌ Deployment failed:", error);
        process.exit(1);
    });
