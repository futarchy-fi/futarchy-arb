const hre = require("hardhat");

/**
 * 🚀 Deploy V3 with Explicit V2 & V3 Vaults
 */

const CONFIG = {
    // Known Addresses on Gnosis - ALL LOWERCASE TO AVOID CHECKSUM ERRORS
    BALANCER_V2_VAULT: "0xba12222222228d8ba445958a75a0704d566bf2c8",
    SWAPR_ROUTER: "0xffb643e73f280b97809a8b41f7232ab401a04ee1",
    FUTARCHY_ROUTER: "0x7495a583ba85875d59407781b4958ed6e0e1228f",
    ALGEBRA_FACTORY: "0xa0864cca6e114013ab0e27cbd5b6f4c8947da766",
    GNO: "0x9c58bacc331c9aa871afd802db6379a98e80cedb",
    SDAI: "0xaf204776c7245bf4147c2612bf6e5972ee483701",

    // This pool is on Balancer V3, so we can ask it for the V3 Vault address
    POOL_FOR_V3_DISCOVERY: "0x165507e2cc823f46554f7fbc9367f4b6a68f8425",

    // Fallback if discovery fails (Recovered correct address)
    FALLBACK_V3_VAULT: "0xba1333333333a1ba1108e8412f11850a5c319ba9"
};

async function main() {
    console.log("\n🚀 DEPLOYING GnosisFlashArbitrageV3 (Dual Vaults)...");

    const [deployer] = await hre.ethers.getSigners();
    console.log(`   Deployer: ${deployer.address}`);

    // 1. Find V3 Vault
    let balancerV3Vault = CONFIG.FALLBACK_V3_VAULT; // Default to fallback

    try {
        console.log(`\n🔍 Detecting Balancer V3 Vault from pool ${CONFIG.POOL_FOR_V3_DISCOVERY}...`);
        const poolContract = await hre.ethers.getContractAt(
            ["function getVault() view returns (address)"],
            CONFIG.POOL_FOR_V3_DISCOVERY
        );
        const discovered = await poolContract.getVault();
        if (discovered && discovered !== hre.ethers.ZeroAddress) {
            balancerV3Vault = discovered;
            console.log(`   ✅ Found V3 Vault: ${balancerV3Vault}`);
        } else {
            console.log(`   ⚠️  getVault() returned empty. Using fallback.`);
        }
    } catch (e) {
        console.error(`   ⚠️  Failed to find V3 Vault (using fallback): ${e.message}`);
    }

    // Safety check
    if (balancerV3Vault.toLowerCase() === CONFIG.BALANCER_V2_VAULT.toLowerCase()) {
        console.warn("\n⚠️  WARNING: Detected V3 Vault matches V2 Vault address!");
        console.warn("    This is likely WRONG. Balancer V2 and V3 are usually separate.");
        console.warn(`    V3 detected: ${balancerV3Vault}`);
    } else {
        console.log(`\n   ✅ V3 Vault: ${balancerV3Vault}`);
        console.log(`   ✅ V2 Vault: ${CONFIG.BALANCER_V2_VAULT}`);
    }

    // 2. Deploy
    const GnosisFlashArbitrageV3 = await hre.ethers.getContractFactory("GnosisFlashArbitrageV3");

    console.log("\n📝 Constructor Arguments:");
    console.log(`   1. V3 Vault:   ${balancerV3Vault}`);
    console.log(`   2. V2 Vault:   ${CONFIG.BALANCER_V2_VAULT}`);
    console.log(`   3. Swapr:      ${CONFIG.SWAPR_ROUTER}`);
    console.log(`   4. Futarchy:   ${CONFIG.FUTARCHY_ROUTER}`);
    console.log(`   5. Factory:    ${CONFIG.ALGEBRA_FACTORY}`);
    console.log(`   6. GNO:        ${CONFIG.GNO}`);
    console.log(`   7. sDAI:       ${CONFIG.SDAI}`);

    const contract = await GnosisFlashArbitrageV3.deploy(
        balancerV3Vault,
        CONFIG.BALANCER_V2_VAULT,
        CONFIG.SWAPR_ROUTER,
        CONFIG.FUTARCHY_ROUTER,
        CONFIG.ALGEBRA_FACTORY,
        CONFIG.GNO,
        CONFIG.SDAI
    );

    console.log(`\n⏳ Waiting for deployment...`);
    await contract.waitForDeployment();

    const address = await contract.getAddress();
    console.log(`\n✅ DEPLOYED TO: ${address}`);

    // Save to file for other scripts
    const fs = require("fs");
    fs.writeFileSync("transaction_hash.txt", address);
    fs.writeFileSync("last_deployment.txt", address);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
