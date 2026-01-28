/**
 * Test JUST the Permit2 + Universal Router swap
 * You already have YES_VLR from the split
 */

const { ethers } = require('ethers');
require('dotenv').config();

const YES_VLR = '0x354582ff9f500f05b506666b75B33dbc90A8708d';
const YES_USDS = '0xa51aFa14963FaE9696b6844D652196959Eb5b9F6';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const UNIVERSAL_ROUTER = '0x66a9893cc07d91d95644aedd05d03f95e1dba8af';
const QUOTER_V2 = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';

const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function approve(address, uint256) returns (bool)',
    'function allowance(address, address) view returns (uint256)'
];

const PERMIT2_ABI = [
    'function approve(address token, address spender, uint160 amount, uint48 expiration) external',
    'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)'
];

const UNIVERSAL_ROUTER_ABI = [
    'function execute(bytes commands, bytes[] inputs, uint256 deadline) external payable'
];

const QUOTER_ABI = [
    'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)'
];

const MAX_UINT160 = BigInt('0xffffffffffffffffffffffffffffffffffffffff');
const MAX_UINT48 = 281474976710655n;

// Universal Router Commands
const V3_SWAP_EXACT_IN = 0x00;

// MSG_SENDER in Universal Router (means "me, the router")
const ADDRESS_THIS = '0x0000000000000000000000000000000000000001';
// Actual user gets tokens at the end
const MSG_SENDER = '0x0000000000000000000000000000000000000002';

async function main() {
    const provider = new ethers.JsonRpcProvider('https://eth.llamarpc.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    console.log('═'.repeat(60));
    console.log('🧪 TEST: Permit2 + Universal Router Swap');
    console.log('═'.repeat(60));
    console.log('Wallet:', wallet.address);

    const yesVlr = new ethers.Contract(YES_VLR, ERC20_ABI, wallet);
    const yesUsds = new ethers.Contract(YES_USDS, ERC20_ABI, wallet);
    const permit2 = new ethers.Contract(PERMIT2, PERMIT2_ABI, wallet);
    const universalRouter = new ethers.Contract(UNIVERSAL_ROUTER, UNIVERSAL_ROUTER_ABI, wallet);
    const quoter = new ethers.Contract(QUOTER_V2, QUOTER_ABI, provider);

    // Check balances
    const yesVlrBal = await yesVlr.balanceOf(wallet.address);
    const yesUsdsBefore = await yesUsds.balanceOf(wallet.address);
    console.log('\nYES_VLR balance:', ethers.formatEther(yesVlrBal));
    console.log('YES_USDS before:', ethers.formatEther(yesUsdsBefore));

    if (yesVlrBal < ethers.parseEther('10')) {
        console.log('❌ Need at least 10 YES_VLR');
        return;
    }

    const swapAmount = ethers.parseEther('10'); // Just 10 YES_VLR for test
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

    // Get quote
    console.log('\n📊 Getting quote for 10 YES_VLR → YES_USDS...');
    let expectedOut;
    try {
        const result = await quoter.quoteExactInputSingle.staticCall({
            tokenIn: YES_VLR,
            tokenOut: YES_USDS,
            amountIn: swapAmount,
            fee: 500,
            sqrtPriceLimitX96: 0
        });
        expectedOut = result[0];
        console.log('   Expected:', ethers.formatEther(expectedOut), 'YES_USDS');
    } catch (e) {
        console.log('   Quote failed:', e.message.slice(0, 50));
        return;
    }

    const minOut = (expectedOut * 97n) / 100n; // 3% slippage
    console.log('   Min (3% slippage):', ethers.formatEther(minOut), 'YES_USDS');

    // Check approvals
    console.log('\n📝 Checking approvals...');

    // 1. ERC20 → Permit2
    const erc20Allowance = await yesVlr.allowance(wallet.address, PERMIT2);
    console.log('   YES_VLR → Permit2:', erc20Allowance >= swapAmount ? '✅ OK' : '❌ Need approve');

    if (erc20Allowance < swapAmount) {
        console.log('   Approving YES_VLR to Permit2 (MAX)...');
        const tx = await yesVlr.approve(PERMIT2, ethers.MaxUint256);
        await tx.wait();
        console.log('   ✅ Approved');
    }

    // 2. Permit2 → Universal Router
    const p2Allowance = await permit2.allowance(wallet.address, YES_VLR, UNIVERSAL_ROUTER);
    console.log('   Permit2 → Router:', p2Allowance[0] >= swapAmount ? '✅ OK' : '❌ Need approve');

    if (p2Allowance[0] < swapAmount) {
        console.log('   Approving Permit2 to Router...');
        const tx = await permit2.approve(YES_VLR, UNIVERSAL_ROUTER, MAX_UINT160, MAX_UINT48);
        await tx.wait();
        console.log('   ✅ Approved');
    }

    // Build swap - send output directly to wallet (no SWEEP needed!)
    console.log('\n📝 Executing swap via Universal Router...');

    const path = ethers.solidityPacked(['address', 'uint24', 'address'], [YES_VLR, 500, YES_USDS]);

    // V3_SWAP_EXACT_IN params: recipient, amountIn, amountOutMinimum, path, payerIsUser
    // Send to wallet.address directly (NOT MSG_SENDER, and no SWEEP)
    const swapParams = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address', 'uint256', 'uint256', 'bytes', 'bool'],
        [wallet.address, swapAmount, minOut, path, true]
    );

    // Just V3_SWAP_EXACT_IN, no SWEEP
    const commands = ethers.hexlify(new Uint8Array([V3_SWAP_EXACT_IN]));

    const tx = await universalRouter.execute(
        commands,
        [swapParams],
        deadline,
        { gasLimit: 400000 }
    );
    console.log('   TX:', tx.hash);
    const receipt = await tx.wait();
    console.log('   Status:', receipt.status === 1 ? '✅ SUCCESS' : '❌ FAILED');

    // Check result
    const yesUsdsAfter = await yesUsds.balanceOf(wallet.address);
    const received = yesUsdsAfter - yesUsdsBefore;
    console.log('\n📊 RESULT:');
    console.log('   YES_USDS received:', ethers.formatEther(received));
    console.log('   Expected:', ethers.formatEther(expectedOut));
}

main().catch(console.error);
