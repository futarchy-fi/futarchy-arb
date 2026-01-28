/**
 * Manual SPOT_SPLIT Test
 * Execute strategy step-by-step with 100 VLR from wallet
 */

const { ethers } = require('ethers');
require('dotenv').config();

// Addresses
const VLR = '0x4e107a0000DB66f0E9Fd2039288Bf811dD1f9c74';
const USDS = '0xdC035D45d973E3EC169d2276DDab16f1e407384F';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const YES_VLR = '0x354582ff9f500f05b506666b75B33dbc90A8708d';
const NO_VLR = '0x4B53aE333bB337c0C8123aD84CE2F541ed53746E';
const YES_USDS = '0xa51aFa14963FaE9696b6844D652196959Eb5b9F6';
const NO_USDS = '0x1a9c528Bc34a7267b1c51a8CD3fad9fC99136171';
const PROPOSAL = '0x4e018f1D8b93B91a0Ce186874eDb53CB6fFfCa62';
const FUTARCHY_ROUTER = '0xAc9Bf8EbA6Bd31f8E8c76f8E8B2AAd0BD93f98Dc';
const SWAP_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';

const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function approve(address, uint256) returns (bool)',
    'function allowance(address, address) view returns (uint256)'
];

const ROUTER_ABI = [
    'function splitPosition(address proposal, address collateralToken, uint256 amount) external',
    'function mergePositions(address proposal, address collateralToken, uint256 amount) external'
];

const SWAP_ABI = [
    'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
    'function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum)) external payable returns (uint256 amountOut)'
];

async function main() {
    const provider = new ethers.JsonRpcProvider('https://eth.llamarpc.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    console.log('═'.repeat(60));
    console.log('🧪 MANUAL SPOT_SPLIT TEST (100 VLR)');
    console.log('═'.repeat(60));
    console.log('Wallet:', wallet.address);

    const vlr = new ethers.Contract(VLR, ERC20_ABI, wallet);
    const yesVlr = new ethers.Contract(YES_VLR, ERC20_ABI, wallet);
    const noVlr = new ethers.Contract(NO_VLR, ERC20_ABI, wallet);
    const yesUsds = new ethers.Contract(YES_USDS, ERC20_ABI, wallet);
    const noUsds = new ethers.Contract(NO_USDS, ERC20_ABI, wallet);
    const usds = new ethers.Contract(USDS, ERC20_ABI, wallet);
    const futarchyRouter = new ethers.Contract(FUTARCHY_ROUTER, ROUTER_ABI, wallet);
    const swapRouter = new ethers.Contract(SWAP_ROUTER, SWAP_ABI, wallet);

    const AMOUNT = ethers.parseEther('100');
    const deadline = Math.floor(Date.now() / 1000) + 600;

    // Check starting balances
    console.log('\n📊 STARTING BALANCES:');
    const startVlr = await vlr.balanceOf(wallet.address);
    console.log('   VLR:', ethers.formatEther(startVlr));

    if (startVlr < AMOUNT) {
        console.log('❌ Not enough VLR! Need 100 VLR');
        return;
    }

    // STEP 1: Approve FutarchyRouter
    console.log('\n📝 STEP 1: Approve FutarchyRouter for VLR...');
    let tx = await vlr.approve(FUTARCHY_ROUTER, AMOUNT);
    await tx.wait();
    console.log('   ✅ Approved');

    // STEP 2: Split VLR → YES_VLR + NO_VLR
    console.log('\n📝 STEP 2: Split 100 VLR → YES_VLR + NO_VLR...');
    tx = await futarchyRouter.splitPosition(PROPOSAL, VLR, AMOUNT, { gasLimit: 500000 });
    await tx.wait();
    const yesVlrBal = await yesVlr.balanceOf(wallet.address);
    const noVlrBal = await noVlr.balanceOf(wallet.address);
    console.log('   ✅ Split complete');
    console.log('   YES_VLR:', ethers.formatEther(yesVlrBal));
    console.log('   NO_VLR:', ethers.formatEther(noVlrBal));

    // STEP 3: Approve + Swap YES_VLR → YES_USDS
    console.log('\n📝 STEP 3: Swap YES_VLR → YES_USDS...');
    tx = await yesVlr.approve(SWAP_ROUTER, yesVlrBal);
    await tx.wait();
    tx = await swapRouter.exactInputSingle({
        tokenIn: YES_VLR,
        tokenOut: YES_USDS,
        fee: 500,
        recipient: wallet.address,
        deadline: deadline,
        amountIn: yesVlrBal,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0
    }, { gasLimit: 300000 });
    await tx.wait();
    const yesUsdsBal = await yesUsds.balanceOf(wallet.address);
    console.log('   ✅ Swapped');
    console.log('   YES_USDS:', ethers.formatEther(yesUsdsBal));

    // STEP 4: Approve + Swap NO_VLR → NO_USDS
    console.log('\n📝 STEP 4: Swap NO_VLR → NO_USDS...');
    tx = await noVlr.approve(SWAP_ROUTER, noVlrBal);
    await tx.wait();
    tx = await swapRouter.exactInputSingle({
        tokenIn: NO_VLR,
        tokenOut: NO_USDS,
        fee: 500,
        recipient: wallet.address,
        deadline: deadline,
        amountIn: noVlrBal,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0
    }, { gasLimit: 300000 });
    await tx.wait();
    const noUsdsBal = await noUsds.balanceOf(wallet.address);
    console.log('   ✅ Swapped');
    console.log('   NO_USDS:', ethers.formatEther(noUsdsBal));

    // STEP 5: Merge YES_USDS + NO_USDS → USDS
    console.log('\n📝 STEP 5: Merge outcomes → USDS...');
    const mergeAmount = yesUsdsBal < noUsdsBal ? yesUsdsBal : noUsdsBal;
    console.log('   Merge amount (MIN):', ethers.formatEther(mergeAmount));
    tx = await yesUsds.approve(FUTARCHY_ROUTER, mergeAmount);
    await tx.wait();
    tx = await noUsds.approve(FUTARCHY_ROUTER, mergeAmount);
    await tx.wait();
    tx = await futarchyRouter.mergePositions(PROPOSAL, USDS, mergeAmount, { gasLimit: 500000 });
    await tx.wait();
    const usdsBal = await usds.balanceOf(wallet.address);
    console.log('   ✅ Merged');
    console.log('   USDS:', ethers.formatEther(usdsBal));

    // STEP 6: Swap USDS → USDC → VLR
    console.log('\n📝 STEP 6: Swap USDS → VLR (via USDC)...');
    tx = await usds.approve(SWAP_ROUTER, usdsBal);
    await tx.wait();
    // Multi-hop: USDS → USDC → VLR
    const path = ethers.solidityPacked(
        ['address', 'uint24', 'address', 'uint24', 'address'],
        [USDS, 500, USDC, 3000, VLR]
    );
    tx = await swapRouter.exactInput({
        path: path,
        recipient: wallet.address,
        deadline: deadline,
        amountIn: usdsBal,
        amountOutMinimum: 0
    }, { gasLimit: 500000 });
    await tx.wait();

    // FINAL: Check result
    console.log('\n═'.repeat(60));
    console.log('📊 FINAL RESULT:');
    const endVlr = await vlr.balanceOf(wallet.address);
    const profit = endVlr - startVlr + AMOUNT; // Add back the 100 we spent
    console.log('   Started with: 100 VLR (spent)');
    console.log('   Ended with:', ethers.formatEther(endVlr - startVlr + AMOUNT), 'VLR');
    console.log('   Net profit:', ethers.formatEther(profit - AMOUNT), 'VLR');

    if (profit > AMOUNT) {
        console.log('   ✅ PROFITABLE!');
    } else {
        console.log('   ❌ LOSS:', ethers.formatEther(AMOUNT - profit), 'VLR');
    }
}

main().catch(console.error);
