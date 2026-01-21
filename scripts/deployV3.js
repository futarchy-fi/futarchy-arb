const { ethers } = require("hardhat");
require("dotenv").config();

async function main() {
    console.log("🚀 Deploying GnosisFlashArbitrageV3 (Balancer V3 Compatible)...\n");

    const [deployer] = await ethers.getSigners();
    console.log("📍 Deployer:", deployer.address);
    console.log("💰 Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "xDAI\n");

    // First get the V3 Vault address from the pool
    const wagnoSdaiPool = new ethers.Contract(
        "0xd1d7fa8871d84d0e77020fc28b7cd5718c446522",
        ["function getVault() view returns (address)"],
        deployer
    );

    const v3VaultAddress = await wagnoSdaiPool.getVault();
    console.log("📍 Balancer V3 Vault:", v3VaultAddress);

    // Contract addresses for Gnosis Chain
    const config = {
        balancerV3Vault: v3VaultAddress,
        balancerV2Vault: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
        swaprRouter: "0xfFB643E73f280B97809A8b41f7232AB401a04ee1",
        futarchyRouter: "0x7495a583ba85875d59407781b4958ED6e0E1228f",
        algebraFactory: "0xA0864cCA6E114013AB0e27cbd5B6f4c8947da766",
        gnoToken: "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb",
        sdaiToken: "0xaf204776c7245bF4147c2612BF6e5972Ee483701",
    };

    console.log("\n📋 Configuration:");
    Object.entries(config).forEach(([k, v]) => console.log(`  - ${k}: ${v}`));
    console.log("");

    // Deploy
    console.log("⏳ Deploying...");
    const Contract = await ethers.getContractFactory("GnosisFlashArbitrageV3");

    const contract = await Contract.deploy(
        config.balancerV3Vault,
        config.balancerV2Vault,
        config.swaprRouter,
        config.futarchyRouter,
        config.algebraFactory,
        config.gnoToken,
        config.sdaiToken
    );

    await contract.waitForDeployment();
    const contractAddress = await contract.getAddress();

    console.log("\n✅ GnosisFlashArbitrageV3 deployed!");
    console.log("📍 Address:", contractAddress);

    // Verification command
    console.log("\n🔍 Verify with:");
    console.log(`npx hardhat verify --network gnosis ${contractAddress} \\`);
    console.log(
        `  "${config.balancerV3Vault}" "${config.balancerV2Vault}" "${config.swaprRouter}" "${config.futarchyRouter}" \\`
    );
    console.log(`  "${config.algebraFactory}" "${config.gnoToken}" "${config.sdaiToken}"`);

    console.log("\n📖 Usage:");
    console.log(`
// SPOT_SPLIT: Borrow GNO, split, sell outcomes, merge sDAI, swap back
await contract.executeArbitrage(
    "${process.env.FUTARCHY_PROPOSAL_ADDRESS || '0x45e1064348fD8A407D6D1F59Fc64B05F633b28FC'}",  // proposal
    "${config.gnoToken}",  // borrow GNO
    ethers.parseEther("10"),  // 10 GNO
    0,  // SPOT_SPLIT
    ethers.parseEther("0.1")  // min 0.1 GNO profit
);

// MERGE_SPOT: Borrow sDAI, split, buy outcomes, merge GNO, swap back  
await contract.executeArbitrage(
    "${process.env.FUTARCHY_PROPOSAL_ADDRESS || '0x45e1064348fD8A407D6D1F59Fc64B05F633b28FC'}",
    "${config.sdaiToken}",  // borrow sDAI
    ethers.parseEther("1000"),  // 1000 sDAI
    1,  // MERGE_SPOT
    ethers.parseEther("10")  // min 10 sDAI profit
);
`);

    return { contractAddress, config };
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Deployment failed:", error);
        process.exit(1);
    });
