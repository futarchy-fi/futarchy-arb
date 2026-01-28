/**
 * test-vlr-tx.js
 * 
 * Sends a single transaction to test the VLR arbitrage contract on-chain.
 * This will show the revert reason in the transaction trace.
 * 
 * Usage: node scripts/test-vlr-tx.js
 */

const { ethers } = require('ethers');
require('dotenv').config();

const CONTRACT = '0xC6BF0047710cD512b24a5E9472CA1665d70171b0';
const ABI = [
    'function executeArbitrage(uint256 borrowAmount, uint8 direction, uint256 minProfit) external returns (tuple(bool success, uint256 profit, uint256 borrowAmount) result)'
];

async function main() {
    const provider = new ethers.JsonRpcProvider(process.env.MAINNET_RPC_URL || 'https://ethereum.publicnode.com');
    const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const contract = new ethers.Contract(CONTRACT, ABI, signer);

    console.log('═'.repeat(60));
    console.log('🧪 VLR Arbitrage Test Transaction');
    console.log('═'.repeat(60));
    console.log(`\nWallet: ${signer.address}`);

    const balance = await provider.getBalance(signer.address);
    console.log(`Balance: ${ethers.formatEther(balance)} ETH`);

    const feeData = await provider.getFeeData();
    console.log(`Gas Price: ${ethers.formatUnits(feeData.gasPrice, 'gwei')} Gwei`);

    console.log('\n📤 Sending SPOT_SPLIT transaction with 1000 VLR...');
    console.log('   (This may revert - check Etherscan for details)\n');

    try {
        const tx = await contract.executeArbitrage(
            ethers.parseEther('1000'),  // 1000 VLR
            0,  // SPOT_SPLIT
            0,  // minProfit = 0 (we want to see the revert)
            { gasLimit: 2000000 }
        );

        console.log(`✅ TX Submitted: ${tx.hash}`);
        console.log(`   https://etherscan.io/tx/${tx.hash}`);

        console.log('\n⏳ Waiting for confirmation...');
        const receipt = await tx.wait();

        console.log(`\n✅ TX Mined!`);
        console.log(`   Status: ${receipt.status === 1 ? 'SUCCESS' : 'REVERTED'}`);
        console.log(`   Gas Used: ${receipt.gasUsed.toString()}`);

    } catch (e) {
        console.log('❌ Transaction Error:', e.message);

        // Try to extract more info
        if (e.transaction) {
            console.log(`\n   TX Hash: ${e.transaction.hash || 'N/A'}`);
        }
        if (e.receipt) {
            console.log(`   https://etherscan.io/tx/${e.receipt.hash}`);
        }
    }

    console.log('\n' + '═'.repeat(60));
}

main().catch(console.error);
