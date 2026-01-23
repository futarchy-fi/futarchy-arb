/**
 * Check contract owner and verify access (standalone script)
 */
require('dotenv').config();
const { ethers } = require('ethers');

const CONTRACT_ADDRESS = '0xe0545480aAB67Bc855806b1f64486F5c77F08eCC';
const RPC_URL = process.env.RPC_URL || 'https://rpc.gnosischain.com';

// Minimal ABI for owner check
const ABI = [
    'function owner() view returns (address)',
    'function executeArbitrage(address,address,uint256,uint8,uint256) external returns (tuple(bool,uint256,uint256,uint256,uint256,uint256,uint256,uint256))'
];

async function main() {
    const provider = new ethers.JsonRpcProvider(RPC_URL);

    console.log('='.repeat(60));
    console.log('CONTRACT ACCESS CHECK');
    console.log('='.repeat(60));
    console.log('');
    console.log('Contract Address:', CONTRACT_ADDRESS);

    // Your wallet from private key
    let yourAddress = 'N/A';
    if (process.env.PRIVATE_KEY) {
        const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
        yourAddress = wallet.address;
    }
    console.log('Your Wallet:', yourAddress);
    console.log('');

    // Get contract
    const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

    // Check owner
    const owner = await contract.owner();
    console.log('Contract Owner:', owner);
    console.log('');

    if (yourAddress !== 'N/A') {
        const isOwner = owner.toLowerCase() === yourAddress.toLowerCase();
        console.log('Are you the owner?', isOwner ? '✅ YES' : '❌ NO');
    }
    console.log('');

    console.log('='.repeat(60));
    console.log('ACCESS RULES (from contract source)');
    console.log('='.repeat(60));
    console.log('');
    console.log('✅ executeArbitrage() - ANYONE can call (no onlyOwner)');
    console.log('✅ loadProposal()     - ANYONE can call (view function)');
    console.log('🔒 recoverTokens()   - ONLY owner can call');
    console.log('');
    console.log('The contract is OPEN - any address can execute arbitrage!');
    console.log('Profits are sent to the CALLER (msg.sender).');
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error);
        process.exit(1);
    });
