const { ethers } = require("hardhat");
require("dotenv").config();

async function main() {
    console.log("🚀 Deploying GnosisFlashArbitrage to Gnosis Chain...\n");

    // Get deployer
    const [deployer] = await ethers.getSigners();
    console.log("📍 Deployer address:", deployer.address);
    console.log("💰 Deployer balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "xDAI\n");

    // Contract addresses from .env (VERIFIED on Gnosis Chain)
    const config = {
        balancerVault: process.env.BALANCER_VAULT_ADDRESS || "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
        swaprRouter: process.env.SWAPR_ROUTER_ADDRESS || "0xfFB643E73f280B97809A8b41f7232AB401a04ee1",
        futarchyRouter: process.env.FUTARCHY_ROUTER_ADDRESS || "0x7495a583ba85875d59407781b4958ED6e0E1228f",
        gnoToken: process.env.GNO_ADDRESS || "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb",
        sdaiToken: process.env.SDAI_ADDRESS || "0xAf204776C7245bF4147C2612Bf6E5972Ee483701",
        wagnoToken: process.env.WAGNO_ADDRESS || "0x7c16F0185A26Db0AE7A9377F23BC18ea7Ce5D644",
        // Balancer Pool ID (WAGNO/sDAI pool) - verified pool address padded to 32 bytes
        balancerPoolId: process.env.BALANCER_POOL_ID || "0x000000000000000000000000d1d7fa8871d84d0e77020fc28b7cd5718c446522"
    };

    console.log("📋 Configuration:");
    console.log("  - Balancer Vault:", config.balancerVault);
    console.log("  - Swapr Router:", config.swaprRouter);
    console.log("  - Futarchy Router:", config.futarchyRouter);
    console.log("  - GNO Token:", config.gnoToken);
    console.log("  - sDAI Token:", config.sdaiToken);
    console.log("  - WAGNO Token:", config.wagnoToken);
    console.log("  - Balancer Pool ID:", config.balancerPoolId);
    console.log("");

    // Deploy contract
    console.log("⏳ Deploying contract...");
    const GnosisFlashArbitrage = await ethers.getContractFactory("GnosisFlashArbitrage");

    const contract = await GnosisFlashArbitrage.deploy(
        config.balancerVault,
        config.swaprRouter,
        config.futarchyRouter,
        config.gnoToken,
        config.sdaiToken,
        config.wagnoToken,
        config.balancerPoolId
    );

    await contract.waitForDeployment();
    const contractAddress = await contract.getAddress();

    console.log("\n✅ GnosisFlashArbitrage deployed successfully!");
    console.log("📍 Contract Address:", contractAddress);
    console.log("");

    // Save deployment info
    const deploymentInfo = {
        network: "gnosis",
        chainId: 100,
        contractAddress: contractAddress,
        deployer: deployer.address,
        config: config,
        timestamp: new Date().toISOString(),
        blockNumber: await ethers.provider.getBlockNumber()
    };

    console.log("📄 Deployment Info:");
    console.log(JSON.stringify(deploymentInfo, null, 2));
    console.log("");

    // Verification instructions
    console.log("🔍 To verify the contract, run:");
    console.log(`npx hardhat verify --network gnosis ${contractAddress} \\`);
    console.log(`  "${config.balancerVault}" \\`);
    console.log(`  "${config.swaprRouter}" \\`);
    console.log(`  "${config.futarchyRouter}" \\`);
    console.log(`  "${config.gnoToken}" \\`);
    console.log(`  "${config.sdaiToken}" \\`);
    console.log(`  "${config.wagnoToken}" \\`);
    console.log(`  "${config.balancerPoolId}"`);
    console.log("");

    return deploymentInfo;
}

main()
    .then((info) => {
        console.log("🎉 Deployment complete!");
        process.exit(0);
    })
    .catch((error) => {
        console.error("❌ Deployment failed:", error);
        process.exit(1);
    });
