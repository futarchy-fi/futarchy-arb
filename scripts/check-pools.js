const { ethers } = require("hardhat");

const VAULT = "0xba12222222228d8ba445958a75a0704d566bf2c8";

const POOLS = [
    { name: "GNO/WXDAI", id: "0x8189c4c96826d016a99986394103dfa9ae41e7ee0002000000000000000000aa" },
    { name: "WXDAI/USDC", id: "0x2086f52651837600180de173b09470f54ef7491000000000000000000000004f" },
    { name: "USDC/sDAI", id: "0x7644fa5d0ea14fcf3e813fdf93ca9544f8567655000000000000000000000066" }
];

async function main() {
    console.log("🔍 Checking Balancer Pools on Gnosis...\n");
    const [signer] = await ethers.getSigners();

    // Create contract instance manually
    const vault = new ethers.Contract(VAULT, [
        "function getPoolTokens(bytes32 poolId) external view returns (address[] memory tokens, uint256[] memory balances, uint256 lastChangeBlock)"
    ], signer);

    for (const pool of POOLS) {
        try {
            console.log(`Checking ${pool.name}...`);
            const result = await vault.getPoolTokens(pool.id);
            console.log(`✅ Found!`);
            const tokens = result[0];
            const balances = result[1];
            tokens.forEach((t, i) => {
                console.log(`     - ${t} (${ethers.formatEther(balances[i])})`);
            });
        } catch (e) {
            console.log(`❌ FAILED: ${e.reason || e.message.split('(')[0]}`);
        }
        console.log("");
    }
}

main().catch(console.error);
