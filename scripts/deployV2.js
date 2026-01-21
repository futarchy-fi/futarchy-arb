const { ethers } = require("hardhat");
require("dotenv").config();

async function main() {
    console.log("🚀 Deploying GnosisFlashArbitrageV2 to Gnosis Chain...\n");

    const [deployer] = await ethers.getSigners();
    console.log("📍 Deployer address:", deployer.address);
    console.log("💰 Deployer balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "xDAI\n");

    // VERIFIED Contract addresses for Gnosis Chain
    const config = {
        balancerVault: process.env.BALANCER_VAULT_ADDRESS || "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
        swaprRouter: process.env.SWAPR_ROUTER_ADDRESS || "0xfFB643E73f280B97809A8b41f7232AB401a04ee1",
        futarchyRouter: process.env.FUTARCHY_ROUTER_ADDRESS || "0x7495a583ba85875d59407781b4958ED6e0E1228f",
        // Algebra Factory on Gnosis (VERIFIED from SDK)
        algebraFactory: process.env.ALGEBRA_FACTORY_ADDRESS || "0xA0864cCA6E114013AB0e27cbd5B6f4c8947da766",
        gnoToken: process.env.GNO_ADDRESS || "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb",
        sdaiToken: process.env.SDAI_ADDRESS || "0xaf204776c7245bF4147c2612BF6e5972Ee483701",
    };

    console.log("📋 Configuration:");
    console.log("  - Balancer Vault:", config.balancerVault);
    console.log("  - Swapr Router:", config.swaprRouter);
    console.log("  - Futarchy Router:", config.futarchyRouter);
    console.log("  - Algebra Factory:", config.algebraFactory);
    console.log("  - GNO Token:", config.gnoToken);
    console.log("  - sDAI Token:", config.sdaiToken);
    console.log("");

    // Deploy V2 contract
    console.log("⏳ Deploying GnosisFlashArbitrageV2...");
    const Contract = await ethers.getContractFactory("GnosisFlashArbitrageV2");

    const contract = await Contract.deploy(
        config.balancerVault,
        config.swaprRouter,
        config.futarchyRouter,
        config.algebraFactory,
        config.gnoToken,
        config.sdaiToken
    );

    await contract.waitForDeployment();
    const contractAddress = await contract.getAddress();

    console.log("\n✅ GnosisFlashArbitrageV2 deployed successfully!");
    console.log("📍 Contract Address:", contractAddress);
    console.log("");

    // Deployment info
    const deploymentInfo = {
        network: "gnosis",
        chainId: 100,
        contractName: "GnosisFlashArbitrageV2",
        contractAddress: contractAddress,
        deployer: deployer.address,
        config: config,
        timestamp: new Date().toISOString(),
        blockNumber: await ethers.provider.getBlockNumber()
    };

    console.log("📄 Deployment Info:");
    console.log(JSON.stringify(deploymentInfo, null, 2));
    console.log("");

    // Verification command
    console.log("🔍 To verify the contract, run:");
    console.log(`npx hardhat verify --network gnosis ${contractAddress} \\`);
    console.log(`  "${config.balancerVault}" \\`);
    console.log(`  "${config.swaprRouter}" \\`);
    console.log(`  "${config.futarchyRouter}" \\`);
    console.log(`  "${config.algebraFactory}" \\`);
    console.log(`  "${config.gnoToken}" \\`);
    console.log(`  "${config.sdaiToken}"`);
    console.log("");

    // Usage example
    console.log("📖 Usage Example:");
    console.log(`
// 1. Analyze a proposal for arbitrage opportunities
const proposalInfo = await contract.loadProposal("0x...");
console.log("YES_GNO:", proposalInfo.yesGno);
console.log("NO_GNO:", proposalInfo.noGno);
console.log("YES Pool:", proposalInfo.yesPool);
console.log("NO Pool:", proposalInfo.noPool);

// 2. Get full analysis with pool prices
const [proposal, yesPool, noPool] = await contract.analyzeArbitrageOpportunity("0x...");

// 3. Execute arbitrage (profits auto-sent to caller)
await contract.executeProposalArbitrage(
    "0x...",                // proposal address
    "${config.sdaiToken}",  // borrow sDAI
    ethers.parseEther("1000"),  // borrow amount
    0,  // ArbitrageDirection.YES_TO_NO
    ethers.parseEther("1")  // min profit
);
`);

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
