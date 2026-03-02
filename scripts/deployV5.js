const { ethers } = require("hardhat");
require("dotenv").config();

/**
 * Deploy GnosisFlashArbitrageV5 - PERMISSIONLESS, direct spot pool swap
 *
 * Key difference from V4:
 * - Replaces Balancer V2 3-hop (GNO->WXDAI->USDC->sDAI) with direct
 *   Swapr/Algebra spot pool swap (~0.67% vs ~3% loss)
 */
async function main() {
    console.log("Deploying GnosisFlashArbitrageV5 (direct spot pool)...\n");

    const [deployer] = await ethers.getSigners();
    console.log("Deployer:", deployer.address);
    console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "xDAI\n");

    // Get the V3 Vault address from an existing Balancer V3 pool
    const wagnoSdaiPool = new ethers.Contract(
        "0xd1d7fa8871d84d0e77020fc28b7cd5718c446522",
        ["function getVault() view returns (address)"],
        deployer
    );

    const v3VaultAddress = await wagnoSdaiPool.getVault();
    console.log("Balancer V3 Vault:", v3VaultAddress);

    // Contract addresses for Gnosis Chain
    const config = {
        balancerV3Vault: v3VaultAddress,
        swaprRouter: "0xfFB643E73f280B97809A8b41f7232AB401a04ee1",
        futarchyRouter: "0x7495a583ba85875d59407781b4958ED6e0E1228f",
        algebraFactory: "0xA0864cCA6E114013AB0e27cbd5B6f4c8947da766",
        gnoToken: "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb",
        sdaiToken: "0xaf204776c7245bF4147c2612BF6e5972Ee483701",
        spotPool: "0x80086B6A53249277961c8672F0C22B3f54AC85FB",  // GNO/sDAI Swapr pool
    };

    console.log("\nConfiguration:");
    Object.entries(config).forEach(([k, v]) => console.log(`  - ${k}: ${v}`));
    console.log("");

    // Deploy
    console.log("Deploying GnosisFlashArbitrageV5...");
    const Contract = await ethers.getContractFactory("GnosisFlashArbitrageV5");

    const contract = await Contract.deploy(
        config.balancerV3Vault,
        config.swaprRouter,
        config.futarchyRouter,
        config.algebraFactory,
        config.gnoToken,
        config.sdaiToken,
        config.spotPool
    );

    await contract.waitForDeployment();
    const contractAddress = await contract.getAddress();

    console.log("\nGnosisFlashArbitrageV5 deployed!");
    console.log("Address:", contractAddress);
    console.log("\nThis contract is PERMISSIONLESS - anyone can execute arbitrage!");

    // Save to last_deployment_v5.txt
    const fs = require("fs");
    const path = require("path");
    fs.writeFileSync(
        path.join(__dirname, "../last_deployment_v5.txt"),
        contractAddress
    );
    console.log("Saved to last_deployment_v5.txt");

    // Verification command
    console.log("\nVerify with:");
    console.log(`npx hardhat verify --network gnosis ${contractAddress} \\`);
    console.log(
        `  "${config.balancerV3Vault}" "${config.swaprRouter}" "${config.futarchyRouter}" "${config.algebraFactory}" \\`
    );
    console.log(`  "${config.gnoToken}" "${config.sdaiToken}" "${config.spotPool}"`);

    return { contractAddress, config };
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("Deployment failed:", error);
        process.exit(1);
    });
