/**
 * Estimate Deployment Gas for AaveFlashArbitrageV1
 * 
 * Usage: node scripts/estimate-deployment-gas.js
 */

const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const RPC_URL = "https://ethereum.publicnode.com";

async function main() {
    console.log("╔════════════════════════════════════════════════════════════════╗");
    console.log("║  ESTIMATING DEPLOYMENT COST: AaveFlashArbitrageV1              ║");
    console.log("╚════════════════════════════════════════════════════════════════╝\n");

    const provider = new ethers.JsonRpcProvider(RPC_URL);

    // 1. Get Bytecode & ABI (Assume compiled by Hardhat already)
    const artifactPath = path.join(__dirname, "../artifacts/contracts/AaveFlashArbitrageV1.sol/AaveFlashArbitrageV1.json");

    if (!fs.existsSync(artifactPath)) {
        console.error("❌ Artifact not found! Please run 'npx hardhat compile' first.");
        process.exit(1);
    }

    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, provider);

    // 2. Define Constructor Arguments
    const args = [
        "0xbA1333333333a1BA1108E8412f11850A5C319bA9", // Balancer V3 Vault
        "0xBA12222222228d8Ba445958a75a0704d566BF2C8", // Balancer V2 Vault
        "0xE592427A0AEce92De3Edee1F18E0157C05861564", // Uniswap V3 Router
        "0x1F98431c8aD98523631AE4a59f267346ea31F984", // Uniswap V3 Factory (Official)
        "0xAc9Bf8EbA6Bd31f8E8c76f8E8B2AAd0BD93f98Dc"  // Futarchy Router (Mainnet)
    ];

    // 3. Create Deployment Transaction
    const deployTx = await factory.getDeployTransaction(...args);

    // 4. Estimate Gas
    try {
        // Note: We need a "from" address to estimate gas, use random address or 0x0
        // Balancer V3 deployment might check code size or other things, but generic estimate works
        const gasEstimate = await provider.estimateGas({
            ...deployTx,
            from: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" // Vitalik's address as placeholder
        });

        // Get current gas price
        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice;
        const ethPrice = 3300; // Approx ETH price in USD

        const totalCostWei = gasEstimate * gasPrice;
        const totalCostEth = ethers.formatEther(totalCostWei);
        const totalCostUsd = parseFloat(totalCostEth) * ethPrice;

        console.log(`\n📊 RESULTS:`);
        console.log(`   Gas Units:   ${gasEstimate.toString()} gas`);
        console.log(`   Gas Price:   ${ethers.formatUnits(gasPrice, "gwei")} gwei`);
        console.log(`   Cost (ETH):  ${totalCostEth} ETH`);
        console.log(`   Cost (USD):  $${totalCostUsd.toFixed(2)} (@ $${ethPrice}/ETH)`);

    } catch (error) {
        console.error("\n❌ Estimation Failed:", error.message);
        if (error.data) {
            console.error("   Error Data:", error.data);
        }
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
