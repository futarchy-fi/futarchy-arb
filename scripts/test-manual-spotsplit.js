/**
 * Manual SPOT_SPLIT Test - FIXED with Universal Router + Permit2
 * Uses 50 VLR with 3% slippage protection
 * NO SWEEP command - send directly to recipient
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
const QUOTER_V2 = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const UNIVERSAL_ROUTER = '0x66a9893cc07d91d95644aedd05d03f95e1dba8af';

const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function approve(address, uint256) returns (bool)',
    'function allowance(address, address) view returns (uint256)'
];

const ROUTER_ABI = [
    'function splitPosition(address proposal, address collateralToken, uint256 amount) external',
    'function mergePositions(address proposal, address collateralToken, uint256 amount) external'
];

const PERMIT2_ABI = [
    'function approve(address token, address spender, uint160 amount, uint48 expiration) external',
    'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)'
];

const UNIVERSAL_ROUTER_ABI = [
    'function execute(bytes commands, bytes[] inputs, uint256 deadline) external payable'
];

const QUOTER_ABI = [
    'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
    'function quoteExactInput(bytes path, uint256 amountIn) external returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)'
];

// Constants
const AMOUNT = ethers.parseEther('100');  // 100 VLR
const MAX_UINT160 = BigInt('0xffffffffffffffffffffffffffffffffffffffff');
const MAX_UINT48 = 281474976710655n;
const SLIPPAGE = 3n; // 3% slippage protection
const V3_SWAP_EXACT_IN = 0x00;  // Universal Router command

function withSlippage(amount) {
    return (amount * (100n - SLIPPAGE)) / 100n;
}

async function ensureApprovals(wallet, token, tokenAddress, amount) {
    const permit2 = new ethers.Contract(PERMIT2, PERMIT2_ABI, wallet);

    // Check ERC20 → Permit2
    const erc20Allowance = await token.allowance(wallet.address, PERMIT2);
    if (erc20Allowance < amount) {
        console.log('      Approving to Permit2...');
        const tx = await token.approve(PERMIT2, ethers.MaxUint256);
        await tx.wait();
    }

    // Check Permit2 → Router
    const p2Allowance = await permit2.allowance(wallet.address, tokenAddress, UNIVERSAL_ROUTER);
    if (p2Allowance[0] < amount) {
        console.log('      Approving Permit2 to Router...');
        const tx = await permit2.approve(tokenAddress, UNIVERSAL_ROUTER, MAX_UINT160, MAX_UINT48);
        await tx.wait();
    }
}

async function getQuoteSingle(quoter, tokenIn, tokenOut, fee, amountIn) {
    try {
        const result = await quoter.quoteExactInputSingle.staticCall({
            tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0
        });
        return result[0];
    } catch { return 0n; }
}

async function getQuoteMultiHop(quoter, path, amountIn) {
    try {
        const result = await quoter.quoteExactInput.staticCall(path, amountIn);
        return result[0];
    } catch { return 0n; }
}

async function main() {
    const provider = new ethers.JsonRpcProvider('https://eth.llamarpc.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    console.log('═'.repeat(60));
    console.log('🧪 MANUAL SPOT_SPLIT - 50 VLR + 3% SLIPPAGE');
    console.log('   Using Universal Router + Permit2');
    console.log('═'.repeat(60));
    console.log('Wallet:', wallet.address);

    const vlr = new ethers.Contract(VLR, ERC20_ABI, wallet);
    const yesVlr = new ethers.Contract(YES_VLR, ERC20_ABI, wallet);
    const noVlr = new ethers.Contract(NO_VLR, ERC20_ABI, wallet);
    const yesUsds = new ethers.Contract(YES_USDS, ERC20_ABI, wallet);
    const noUsds = new ethers.Contract(NO_USDS, ERC20_ABI, wallet);
    const usds = new ethers.Contract(USDS, ERC20_ABI, wallet);
    const futarchyRouter = new ethers.Contract(FUTARCHY_ROUTER, ROUTER_ABI, wallet);
    const universalRouter = new ethers.Contract(UNIVERSAL_ROUTER, UNIVERSAL_ROUTER_ABI, wallet);
    const quoter = new ethers.Contract(QUOTER_V2, QUOTER_ABI, provider);

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

    // Record balances BEFORE
    const beforeYesVlr = await yesVlr.balanceOf(wallet.address);
    const beforeNoVlr = await noVlr.balanceOf(wallet.address);
    const beforeYesUsds = await yesUsds.balanceOf(wallet.address);
    const beforeNoUsds = await noUsds.balanceOf(wallet.address);
    const beforeUsds = await usds.balanceOf(wallet.address);
    const beforeVlr = await vlr.balanceOf(wallet.address);

    console.log('\n📊 BEFORE BALANCES:');
    console.log('   VLR:', ethers.formatEther(beforeVlr));

    if (beforeVlr < AMOUNT) {
        console.log('❌ Not enough VLR!');
        return;
    }

    // STEP 1: Approve & Split
    console.log('\n📝 STEP 1: Approve FutarchyRouter for 50 VLR...');
    let tx = await vlr.approve(FUTARCHY_ROUTER, AMOUNT);
    await tx.wait();
    console.log('   ✅ Approved');

    console.log('\n📝 STEP 2: Split 50 VLR → YES_VLR + NO_VLR...');
    tx = await futarchyRouter.splitPosition(PROPOSAL, VLR, AMOUNT, { gasLimit: 1000000 });
    await tx.wait();

    const afterSplitYesVlr = await yesVlr.balanceOf(wallet.address);
    const afterSplitNoVlr = await noVlr.balanceOf(wallet.address);
    const newYesVlr = afterSplitYesVlr - beforeYesVlr;
    const newNoVlr = afterSplitNoVlr - beforeNoVlr;

    console.log('   ✅ Split complete');
    console.log('   NEW YES_VLR:', ethers.formatEther(newYesVlr));
    console.log('   NEW NO_VLR:', ethers.formatEther(newNoVlr));

    // STEP 3: Swap YES_VLR → YES_USDS
    console.log('\n📝 STEP 3: Swap YES_VLR → YES_USDS...');
    const quote1 = await getQuoteSingle(quoter, YES_VLR, YES_USDS, 500, newYesVlr);
    const minOut1 = withSlippage(quote1);
    console.log('   Quote:', ethers.formatEther(quote1), 'YES_USDS');
    console.log('   Min (3% slip):', ethers.formatEther(minOut1));

    await ensureApprovals(wallet, yesVlr, YES_VLR, newYesVlr);

    const path1 = ethers.solidityPacked(['address', 'uint24', 'address'], [YES_VLR, 500, YES_USDS]);
    const swapParams1 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address', 'uint256', 'uint256', 'bytes', 'bool'],
        [wallet.address, newYesVlr, minOut1, path1, true]  // Direct to wallet, no SWEEP
    );

    tx = await universalRouter.execute(
        ethers.hexlify(new Uint8Array([V3_SWAP_EXACT_IN])),
        [swapParams1],
        deadline,
        { gasLimit: 400000 }
    );
    await tx.wait();

    const afterSwap1YesUsds = await yesUsds.balanceOf(wallet.address);
    const gotYesUsds = afterSwap1YesUsds - beforeYesUsds;
    console.log('   ✅ Got YES_USDS:', ethers.formatEther(gotYesUsds));

    // STEP 4: Swap NO_VLR → NO_USDS
    console.log('\n📝 STEP 4: Swap NO_VLR → NO_USDS...');
    const quote2 = await getQuoteSingle(quoter, NO_VLR, NO_USDS, 500, newNoVlr);
    const minOut2 = withSlippage(quote2);
    console.log('   Quote:', ethers.formatEther(quote2), 'NO_USDS');
    console.log('   Min (3% slip):', ethers.formatEther(minOut2));

    await ensureApprovals(wallet, noVlr, NO_VLR, newNoVlr);

    const path2 = ethers.solidityPacked(['address', 'uint24', 'address'], [NO_VLR, 500, NO_USDS]);
    const swapParams2 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address', 'uint256', 'uint256', 'bytes', 'bool'],
        [wallet.address, newNoVlr, minOut2, path2, true]
    );

    tx = await universalRouter.execute(
        ethers.hexlify(new Uint8Array([V3_SWAP_EXACT_IN])),
        [swapParams2],
        deadline,
        { gasLimit: 400000 }
    );
    await tx.wait();

    const afterSwap2NoUsds = await noUsds.balanceOf(wallet.address);
    const gotNoUsds = afterSwap2NoUsds - beforeNoUsds;
    console.log('   ✅ Got NO_USDS:', ethers.formatEther(gotNoUsds));

    // STEP 5: Merge outcomes → USDS
    console.log('\n📝 STEP 5: Merge outcomes → USDS...');
    const mergeAmount = gotYesUsds < gotNoUsds ? gotYesUsds : gotNoUsds;
    console.log('   Merge amount (MIN):', ethers.formatEther(mergeAmount));

    tx = await yesUsds.approve(FUTARCHY_ROUTER, mergeAmount);
    await tx.wait();
    tx = await noUsds.approve(FUTARCHY_ROUTER, mergeAmount);
    await tx.wait();
    tx = await futarchyRouter.mergePositions(PROPOSAL, USDS, mergeAmount, { gasLimit: 500000 });
    await tx.wait();

    const afterMergeUsds = await usds.balanceOf(wallet.address);
    const gotUsds = afterMergeUsds - beforeUsds;
    console.log('   ✅ Got USDS:', ethers.formatEther(gotUsds));

    // STEP 6: Swap USDS → VLR (via USDC)
    console.log('\n📝 STEP 6: Swap USDS → VLR (via USDC)...');
    const path3 = ethers.solidityPacked(
        ['address', 'uint24', 'address', 'uint24', 'address'],
        [USDS, 500, USDC, 3000, VLR]
    );
    const quote3 = await getQuoteMultiHop(quoter, path3, gotUsds);
    const minOut3 = withSlippage(quote3);
    console.log('   Quote:', ethers.formatEther(quote3), 'VLR');
    console.log('   Min (3% slip):', ethers.formatEther(minOut3));

    await ensureApprovals(wallet, usds, USDS, gotUsds);

    const swapParams3 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address', 'uint256', 'uint256', 'bytes', 'bool'],
        [wallet.address, gotUsds, minOut3, path3, true]
    );

    tx = await universalRouter.execute(
        ethers.hexlify(new Uint8Array([V3_SWAP_EXACT_IN])),
        [swapParams3],
        deadline,
        { gasLimit: 500000 }
    );
    await tx.wait();

    // FINAL RESULT
    console.log('\n' + '═'.repeat(60));
    console.log('📊 FINAL RESULT:');
    const finalVlr = await vlr.balanceOf(wallet.address);
    const vlrChange = finalVlr - beforeVlr;

    console.log('   Started with:', ethers.formatEther(beforeVlr), 'VLR');
    console.log('   Spent:        50 VLR (the "loan")');
    console.log('   Got back:    ', ethers.formatEther(vlrChange + AMOUNT), 'VLR');
    console.log('   Net change:  ', ethers.formatEther(vlrChange), 'VLR');

    if (vlrChange > 0n) {
        console.log('   ✅ PROFIT!', ethers.formatEther(vlrChange), 'VLR');
    } else {
        console.log('   ❌ LOSS:', ethers.formatEther(-vlrChange), 'VLR');
    }
}

main().catch(console.error);
