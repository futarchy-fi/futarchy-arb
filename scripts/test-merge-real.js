/**
 * Test MERGE_SPOT with real on-chain transaction (tiny amount)
 * Usage: node scripts/test-merge-real.js
 */

const { ethers } = require("ethers");
require("dotenv").config();

const CONFIG = {
    rpcUrl: process.env.RPC_URL || "https://ethereum.publicnode.com",
    contractAddress: "0x098321F3f0d20dD4fc9559267a9B1c88AaDd2876",  // AaveFlashArbitrageV2
    proposalAddress: "0xFb45aE9d8e5874e85b8e23D735EB9718EfEF47Fa",
    tokens: {
        GHO: "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f"
    }
};

const CONTRACT_ABI = [
    "function executeArbitrage(address proposalAddress, address borrowToken, uint256 borrowAmount, uint8 direction, uint256 minProfit) external returns (tuple(bool success, uint256 profit, uint256 borrowAmount) result)"
];

async function main() {
    console.log("🧪 TEST: Real MERGE_SPOT Transaction (tiny amount)");
    console.log("═".repeat(60));

    const provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);

    if (!process.env.PRIVATE_KEY_AAVE) {
        console.log("❌ No PRIVATE_KEY_AAVE in .env");
        return;
    }

    const signer = new ethers.Wallet(process.env.PRIVATE_KEY_AAVE, provider);
    console.log(`👤 Wallet: ${signer.address}`);

    const balance = await provider.getBalance(signer.address);
    console.log(`💰 ETH Balance: ${ethers.formatEther(balance)} ETH`);

    const contract = new ethers.Contract(CONFIG.contractAddress, CONTRACT_ABI, signer);

    // MERGE_SPOT = direction 1, borrow GHO
    const borrowAmount = ethers.parseEther("0.1");  // 0.1 GHO (tiny)

    console.log(`\n📤 Sending REAL transaction...`);
    console.log(`   Strategy: MERGE_SPOT (direction=1)`);
    console.log(`   Borrow: 0.1 GHO`);
    console.log(`   Contract: ${CONFIG.contractAddress}`);
    console.log(`   Proposal: ${CONFIG.proposalAddress}`);

    try {
        const tx = await contract.executeArbitrage(
            CONFIG.proposalAddress,
            CONFIG.tokens.GHO,
            borrowAmount,
            1,  // MERGE_SPOT
            0,  // minProfit = 0 for test
            { gasLimit: 3000000 }
        );

        console.log(`\n📝 TX Hash: ${tx.hash}`);
        console.log(`   Etherscan: https://etherscan.io/tx/${tx.hash}`);
        console.log(`\n⏳ Waiting for confirmation...`);

        const receipt = await tx.wait();
        console.log(`\n✅ TX Mined!`);
        console.log(`   Status: ${receipt.status === 1 ? "SUCCESS" : "REVERTED"}`);
        console.log(`   Gas Used: ${receipt.gasUsed.toString()}`);
        console.log(`   Block: ${receipt.blockNumber}`);

    } catch (error) {
        console.log(`\n❌ Transaction Failed!`);
        console.log(`   Error: ${error.message}`);

        // Try to extract revert reason
        if (error.data) {
            console.log(`   Data: ${error.data}`);
        }
        if (error.reason) {
            console.log(`   Reason: ${error.reason}`);
        }
        if (error.transaction) {
            console.log(`   TX Hash: ${error.transaction.hash || 'n/a'}`);
        }
    }
}

main().catch(console.error);
