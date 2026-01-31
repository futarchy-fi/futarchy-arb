const hre = require("hardhat");

async function main() {
    console.log("════════════════════════════════════════════════════════════");
    console.log("🚀 Deploying AaveFlashArbitrageV6");
    console.log("════════════════════════════════════════════════════════════");

    const [deployer] = await hre.ethers.getSigners();
    console.log(`Deployer: ${deployer.address}`);
    const balance = await hre.ethers.provider.getBalance(deployer.address);
    console.log(`Balance: ${hre.ethers.formatEther(balance)} ETH`);

    console.log("\n📦 Deploying contract...");
    const Factory = await hre.ethers.getContractFactory("AaveFlashArbitrageV6");
    const contract = await Factory.deploy();

    await contract.waitForDeployment();
    const address = await contract.getAddress();

    console.log("\n════════════════════════════════════════════════════════════");
    console.log("✅ DEPLOYED!");
    console.log("════════════════════════════════════════════════════════════");
    console.log(`Address: ${address}`);

    console.log("\n📋 NEXT STEPS:");
    console.log(`1. Update contract address in scripts: ${address}`);
    console.log(`2. Verify: npx hardhat verify --network mainnet ${address}`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
