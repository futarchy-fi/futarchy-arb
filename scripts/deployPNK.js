const { ethers } = require("hardhat");
require("dotenv").config();

/**
 * Deploy PNKFlashArbitrage — permissionless PNK/sDAI arbitrage contract.
 *
 * Route: WETH ↔ PNK (DXswap V2) and WETH ↔ WXDAI (Honeyswap) ↔ sDAI (ERC4626).
 * Always flash borrows WETH from Balancer V3.
 */
async function main() {
    console.log("Deploying PNKFlashArbitrage...\n");

    const [deployer] = await ethers.getSigners();
    console.log("Deployer:", deployer.address);
    console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "xDAI\n");

    // Fetch Balancer V3 Vault address dynamically from a known V3 pool
    const wagnoSdaiPool = new ethers.Contract(
        "0xd1d7fa8871d84d0e77020fc28b7cd5718c446522",
        ["function getVault() view returns (address)"],
        deployer
    );
    const balancerV3Vault = await wagnoSdaiPool.getVault();
    console.log("Balancer V3 Vault:", balancerV3Vault);

    const config = {
        balancerV3Vault,
        swaprRouter:    "0xfFB643E73f280B97809A8b41f7232AB401a04ee1",
        futarchyRouter: "0x7495a583ba85875d59407781b4958ED6e0E1228f",
        algebraFactory: "0xA0864cCA6E114013AB0e27F5bA6F12EC24B2A078",
        pnkToken:       "0x37b60f4E9A31A64cCc0024dce7D0fD07eAA0F7B3",
        sdaiToken:      "0xaf204776c7245bF4147c2612BF6e5972Ee483701",
        wethToken:      "0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1",
        wxdaiToken:     "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d",
        dxswapPair:     "0x2613Cb099C12CECb1bd290Fd0eF6833949374165",   // PNK/WETH
        wethWxdaiPair:  "0x7bea4af5d425f2d4485bdad1859c88617df31a67",   // WETH/WXDAI Honeyswap
    };

    console.log("\nConfiguration:");
    Object.entries(config).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
    console.log("");

    console.log("Deploying...");
    const Contract = await ethers.getContractFactory("PNKFlashArbitrage");

    const contract = await Contract.deploy(
        config.balancerV3Vault,
        config.swaprRouter,
        config.futarchyRouter,
        config.algebraFactory,
        config.pnkToken,
        config.sdaiToken,
        config.wethToken,
        config.wxdaiToken,
        config.dxswapPair,
        config.wethWxdaiPair
    );

    await contract.waitForDeployment();
    const contractAddress = await contract.getAddress();

    console.log("\nPNKFlashArbitrage deployed!");
    console.log("Address:", contractAddress);

    const fs = require("fs");
    const path = require("path");
    fs.writeFileSync(
        path.join(__dirname, "../last_deployment_pnk.txt"),
        contractAddress
    );
    console.log("Saved to last_deployment_pnk.txt");

    console.log("\nVerify with:");
    console.log(`npx hardhat verify --network gnosis ${contractAddress} \\`);
    console.log(`  "${config.balancerV3Vault}" "${config.swaprRouter}" "${config.futarchyRouter}" "${config.algebraFactory}" \\`);
    console.log(`  "${config.pnkToken}" "${config.sdaiToken}" "${config.wethToken}" "${config.wxdaiToken}" \\`);
    console.log(`  "${config.dxswapPair}" "${config.wethWxdaiPair}"`);

    const proposalAddr = process.env.PNK_PROPOSAL_ADDRESS || "0xb607bd7c7201e966e6a150cd6ef1d08db55cad5d";
    console.log(`\nUsage (PERMISSIONLESS):
// SPOT_SPLIT: Borrow WETH → PNK → split → sell outcomes → merge sDAI → WXDAI → WETH
await contract.executeArbitrage(
    "${proposalAddr}",
    ethers.parseEther("0.1"),    // borrow 0.1 WETH
    0,                            // SPOT_SPLIT
    ethers.parseEther("0.001")   // min profit 0.001 WETH
);

// MERGE_SPOT: Borrow WETH → WXDAI → sDAI → split → buy outcomes → merge PNK → WETH
await contract.executeArbitrage(
    "${proposalAddr}",
    ethers.parseEther("0.1"),    // borrow 0.1 WETH
    1,                            // MERGE_SPOT
    ethers.parseEther("0.001")   // min profit 0.001 WETH
);
`);

    return { contractAddress, config };
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("Deployment failed:", error);
        process.exit(1);
    });
