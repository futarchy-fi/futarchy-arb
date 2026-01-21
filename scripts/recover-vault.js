const { ethers } = require("hardhat");

const OLD_CONTRACT = "0x5649CA18945a8cf36945aA2674f74db3634157cC";

async function main() {
    console.log(`\n🔍 Recovering V3 Vault from ${OLD_CONTRACT}...`);

    const [signer] = await ethers.getSigners();

    // Check Slot 2 (likely location of balancerVault)
    // Layout: Ownable(0), ReentrancyGuard(1), balancerVault(2)
    const slot2 = await ethers.provider.getStorage(OLD_CONTRACT, 2);
    console.log(`   Slot 2: ${slot2}`);

    // Extract address (last 20 bytes)
    const address = "0x" + slot2.slice(-40);
    console.log(`   ✅ Recovered Address: ${address}`);
}

main().catch(console.error);
