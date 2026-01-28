/**
 * investigate-vlr-prices.js
 * 
 * Investigates VLR/USDS pool prices to determine if arbitrage is profitable.
 * Checks both SPOT_SPLIT and MERGE_SPOT strategies.
 * 
 * Usage: node scripts/investigate-vlr-prices.js
 */

const { ethers } = require('ethers');
require('dotenv').config();

// ═════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═════════════════════════════════════════════════════════════════════

const RPC_URL = process.env.MAINNET_RPC_URL || 'https://ethereum.publicnode.com';

// Tokens
const VLR = '0x4e107a0000DB66f0E9Fd2039288Bf811dD1f9c74';
const USDS = '0xdC035D45d973E3EC169d2276DDab16f1e407384F';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

// Outcome Tokens
const YES_VLR = '0x354582ff9f500f05b506666b75B33dbc90A8708d';
const NO_VLR = '0x4B53aE333bB337c0C8123aD84CE2F541ed53746E';
const YES_USDS = '0xa51aFa14963FaE9696b6844D652196959Eb5b9F6';
const NO_USDS = '0x1a9c528Bc34a7267b1c51a8CD3fad9fC99136171';

// Pools
const YES_POOL = '0x425d5D868B9C0fA9Ff7B6c8A46eA62f973D3e974';  // YES_VLR/YES_USDS
const NO_POOL = '0x488580A26a2976D2562eD5aAa9c5238B13C407DA';   // NO_VLR/NO_USDS
const VLR_USDC_POOL = '0xb382646C447007a23Eab179957235DC3FC51606c';
const USDS_USDC_POOL = '0x8AEE53B873176D9F938D24a53A8aE5cF36276464';

// ABIs
const POOL_ABI = [
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function liquidity() view returns (uint128)'
];

const ERC20_ABI = [
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function balanceOf(address) view returns (uint256)'
];

// ═════════════════════════════════════════════════════════════════════
// PRICE CALCULATION
// ═════════════════════════════════════════════════════════════════════

function sqrtPriceX96ToPrice(sqrtPriceX96, token0Decimals, token1Decimals) {
    // sqrtPriceX96 = sqrt(token1/token0) * 2^96
    // price = (sqrtPriceX96 / 2^96)^2 = token1/token0
    const sqrtPrice = Number(sqrtPriceX96) / (2 ** 96);
    const price = sqrtPrice * sqrtPrice;
    // Adjust for decimals: price is in token1/token0, so adjust accordingly
    const decimalAdjustment = 10 ** (token0Decimals - token1Decimals);
    return price * decimalAdjustment;
}

// ═════════════════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════════════════

async function main() {
    const provider = new ethers.JsonRpcProvider(RPC_URL);

    console.log('═'.repeat(70));
    console.log('📊 VLR/USDS ARBITRAGE PRICE INVESTIGATION');
    console.log('═'.repeat(70));

    // ═══════════════════════════════════════════════════════════════════
    // 1. Get YES_VLR/YES_USDS Pool Price
    // ═══════════════════════════════════════════════════════════════════

    console.log('\n📊 YES Pool (YES_VLR/YES_USDS)');
    console.log('─'.repeat(50));

    const yesPool = new ethers.Contract(YES_POOL, POOL_ABI, provider);
    const [yesSlot0, yesToken0, yesToken1, yesLiquidity] = await Promise.all([
        yesPool.slot0(),
        yesPool.token0(),
        yesPool.token1(),
        yesPool.liquidity()
    ]);

    console.log(`   Token0: ${yesToken0}`);
    console.log(`   Token1: ${yesToken1}`);
    console.log(`   sqrtPriceX96: ${yesSlot0.sqrtPriceX96.toString()}`);
    console.log(`   Tick: ${yesSlot0.tick}`);
    console.log(`   Liquidity: ${yesLiquidity.toString()}`);

    // Both tokens are 18 decimals
    const yesPriceToken1PerToken0 = sqrtPriceX96ToPrice(yesSlot0.sqrtPriceX96, 18, 18);
    const yesPriceToken0PerToken1 = 1 / yesPriceToken1PerToken0;

    // Determine which is which
    const yesVlrIsToken0 = yesToken0.toLowerCase() === YES_VLR.toLowerCase();
    const yesVlrPerYesUsds = yesVlrIsToken0 ? yesPriceToken0PerToken1 : yesPriceToken1PerToken0;
    const yesUsdsPerYesVlr = yesVlrIsToken0 ? yesPriceToken1PerToken0 : yesPriceToken0PerToken1;

    console.log(`\n   💰 YES_VLR/YES_USDS Price:`);
    console.log(`      1 YES_VLR = ${yesUsdsPerYesVlr.toFixed(6)} YES_USDS`);
    console.log(`      1 YES_USDS = ${yesVlrPerYesUsds.toFixed(6)} YES_VLR`);

    // ═══════════════════════════════════════════════════════════════════
    // 2. Get NO_VLR/NO_USDS Pool Price
    // ═══════════════════════════════════════════════════════════════════

    console.log('\n📊 NO Pool (NO_VLR/NO_USDS)');
    console.log('─'.repeat(50));

    const noPool = new ethers.Contract(NO_POOL, POOL_ABI, provider);
    const [noSlot0, noToken0, noToken1, noLiquidity] = await Promise.all([
        noPool.slot0(),
        noPool.token0(),
        noPool.token1(),
        noPool.liquidity()
    ]);

    console.log(`   Token0: ${noToken0}`);
    console.log(`   Token1: ${noToken1}`);
    console.log(`   sqrtPriceX96: ${noSlot0.sqrtPriceX96.toString()}`);
    console.log(`   Tick: ${noSlot0.tick}`);
    console.log(`   Liquidity: ${noLiquidity.toString()}`);

    const noPriceToken1PerToken0 = sqrtPriceX96ToPrice(noSlot0.sqrtPriceX96, 18, 18);
    const noPriceToken0PerToken1 = 1 / noPriceToken1PerToken0;

    // Determine which is which - NO pools have NO_USDS as token0
    const noVlrIsToken0 = noToken0.toLowerCase() === NO_VLR.toLowerCase();
    const noVlrPerNoUsds = noVlrIsToken0 ? noPriceToken0PerToken1 : noPriceToken1PerToken0;
    const noUsdsPerNoVlr = noVlrIsToken0 ? noPriceToken1PerToken0 : noPriceToken0PerToken1;

    console.log(`\n   💰 NO_VLR/NO_USDS Price:`);
    console.log(`      1 NO_VLR = ${noUsdsPerNoVlr.toFixed(6)} NO_USDS`);
    console.log(`      1 NO_USDS = ${noVlrPerNoUsds.toFixed(6)} NO_VLR`);

    // ═══════════════════════════════════════════════════════════════════
    // 3. Get VLR/USDC Spot Price
    // ═══════════════════════════════════════════════════════════════════

    console.log('\n📊 VLR/USDC Pool (Spot Reference)');
    console.log('─'.repeat(50));

    const vlrUsdcPool = new ethers.Contract(VLR_USDC_POOL, POOL_ABI, provider);
    const [vlrUsdcSlot0, vlrUsdcToken0] = await Promise.all([
        vlrUsdcPool.slot0(),
        vlrUsdcPool.token0()
    ]);

    // VLR is 18 decimals, USDC is 6 decimals
    const vlrIsToken0 = vlrUsdcToken0.toLowerCase() === VLR.toLowerCase();
    const vlrUsdcPriceRaw = sqrtPriceX96ToPrice(vlrUsdcSlot0.sqrtPriceX96, vlrIsToken0 ? 18 : 6, vlrIsToken0 ? 6 : 18);
    const vlrPerUsdc = vlrIsToken0 ? (1 / vlrUsdcPriceRaw) : vlrUsdcPriceRaw;
    const usdcPerVlr = vlrIsToken0 ? vlrUsdcPriceRaw : (1 / vlrUsdcPriceRaw);

    console.log(`   1 VLR = ${usdcPerVlr.toFixed(8)} USDC`);
    console.log(`   1 USDC = ${vlrPerUsdc.toFixed(2)} VLR`);

    // ═══════════════════════════════════════════════════════════════════
    // 4. Get USDS/USDC Spot Price
    // ═══════════════════════════════════════════════════════════════════

    console.log('\n📊 USDS/USDC Pool');
    console.log('─'.repeat(50));

    const usdsUsdcPool = new ethers.Contract(USDS_USDC_POOL, POOL_ABI, provider);
    const [usdsUsdcSlot0, usdsUsdcToken0] = await Promise.all([
        usdsUsdcPool.slot0(),
        usdsUsdcPool.token0()
    ]);

    // USDS is 18 decimals, USDC is 6 decimals
    const usdsIsToken0 = usdsUsdcToken0.toLowerCase() === USDS.toLowerCase();
    const usdsUsdcPriceRaw = sqrtPriceX96ToPrice(usdsUsdcSlot0.sqrtPriceX96, usdsIsToken0 ? 18 : 6, usdsIsToken0 ? 6 : 18);

    // Price of USDS in USDC terms
    const usdcPerUsds = usdsIsToken0 ? usdsUsdcPriceRaw : (1 / usdsUsdcPriceRaw);
    const usdsPerUsdc = 1 / usdcPerUsds;

    console.log(`   1 USDS = ${usdcPerUsds.toFixed(6)} USDC`);

    // Calculate VLR/USDS effective rate
    const usdsPerVlr = usdcPerVlr / usdcPerUsds;
    const vlrPerUsds = 1 / usdsPerVlr;

    console.log(`\n   📊 Derived VLR/USDS Spot Rate:`);
    console.log(`   1 VLR = ${usdsPerVlr.toFixed(6)} USDS (via USDC)`);

    // ═══════════════════════════════════════════════════════════════════
    // 5. ARBITRAGE ANALYSIS
    // ═══════════════════════════════════════════════════════════════════

    console.log('\n' + '═'.repeat(70));
    console.log('🎯 ARBITRAGE ANALYSIS');
    console.log('═'.repeat(70));

    // For SPOT_SPLIT: Split 1 VLR → 1 YES_VLR + 1 NO_VLR
    // Sell 1 YES_VLR → get yesUsdsPerYesVlr YES_USDS
    // Sell 1 NO_VLR → get noUsdsPerNoVlr NO_USDS
    // Merge MIN(YES_USDS, NO_USDS) → USDS
    // Convert USDS → VLR

    const minUsdsFromOutcomes = Math.min(yesUsdsPerYesVlr, noUsdsPerNoVlr);
    const maxUsdsFromOutcomes = Math.max(yesUsdsPerYesVlr, noUsdsPerNoVlr);
    const vlrFromMinUsds = minUsdsFromOutcomes * vlrPerUsds;

    console.log('\n📊 SPOT_SPLIT Analysis (Split VLR → Sell Outcomes → Merge to USDS)');
    console.log('─'.repeat(50));
    console.log(`   Input: 1 VLR → Split → 1 YES_VLR + 1 NO_VLR`);
    console.log(`   Swap 1 YES_VLR → ${yesUsdsPerYesVlr.toFixed(6)} YES_USDS`);
    console.log(`   Swap 1 NO_VLR → ${noUsdsPerNoVlr.toFixed(6)} NO_USDS`);
    console.log(`   Merge MIN(${yesUsdsPerYesVlr.toFixed(6)}, ${noUsdsPerNoVlr.toFixed(6)}) = ${minUsdsFromOutcomes.toFixed(6)} USDS`);
    console.log(`   Convert ${minUsdsFromOutcomes.toFixed(6)} USDS → ${vlrFromMinUsds.toFixed(6)} VLR`);
    console.log(`\n   🎯 OUTPUT: ${vlrFromMinUsds.toFixed(6)} VLR from 1 VLR input`);

    const spotSplitProfit = vlrFromMinUsds - 1;
    const spotSplitProfitPct = spotSplitProfit * 100;

    if (spotSplitProfit > 0) {
        console.log(`   ✅ SPOT_SPLIT PROFITABLE: +${spotSplitProfit.toFixed(6)} VLR (${spotSplitProfitPct.toFixed(2)}%)`);
    } else {
        console.log(`   ❌ SPOT_SPLIT NOT PROFITABLE: ${spotSplitProfit.toFixed(6)} VLR (${spotSplitProfitPct.toFixed(2)}%)`);
    }

    // For MERGE_SPOT: Start with 1 VLR, swap to USDS, split, buy VLR outcomes, merge
    // 1 VLR → usdsPerVlr USDS
    // Split USDS → YES_USDS + NO_USDS
    // Buy YES_VLR with YES_USDS: usdsPerVlr * yesVlrPerYesUsds
    // Buy NO_VLR with NO_USDS: usdsPerVlr * noVlrPerNoUsds
    // Merge MIN(YES_VLR, NO_VLR)

    const yesVlrFromUsds = usdsPerVlr * yesVlrPerYesUsds;
    const noVlrFromUsds = usdsPerVlr * noVlrPerNoUsds;
    const minVlrFromOutcomes = Math.min(yesVlrFromUsds, noVlrFromUsds);

    console.log('\n📊 MERGE_SPOT Analysis (Swap VLR → USDS → Buy Outcomes → Merge to VLR)');
    console.log('─'.repeat(50));
    console.log(`   Input: 1 VLR → ${usdsPerVlr.toFixed(6)} USDS`);
    console.log(`   Split ${usdsPerVlr.toFixed(6)} USDS → ${usdsPerVlr.toFixed(6)} YES_USDS + ${usdsPerVlr.toFixed(6)} NO_USDS`);
    console.log(`   Swap ${usdsPerVlr.toFixed(6)} YES_USDS → ${yesVlrFromUsds.toFixed(6)} YES_VLR`);
    console.log(`   Swap ${usdsPerVlr.toFixed(6)} NO_USDS → ${noVlrFromUsds.toFixed(6)} NO_VLR`);
    console.log(`   Merge MIN(${yesVlrFromUsds.toFixed(6)}, ${noVlrFromUsds.toFixed(6)}) = ${minVlrFromOutcomes.toFixed(6)} VLR`);
    console.log(`\n   🎯 OUTPUT: ${minVlrFromOutcomes.toFixed(6)} VLR from 1 VLR input`);

    const mergeSpotProfit = minVlrFromOutcomes - 1;
    const mergeSpotProfitPct = mergeSpotProfit * 100;

    if (mergeSpotProfit > 0) {
        console.log(`   ✅ MERGE_SPOT PROFITABLE: +${mergeSpotProfit.toFixed(6)} VLR (${mergeSpotProfitPct.toFixed(2)}%)`);
    } else {
        console.log(`   ❌ MERGE_SPOT NOT PROFITABLE: ${mergeSpotProfit.toFixed(6)} VLR (${mergeSpotProfitPct.toFixed(2)}%)`);
    }

    // ═══════════════════════════════════════════════════════════════════
    // 6. SUMMARY
    // ═══════════════════════════════════════════════════════════════════

    console.log('\n' + '═'.repeat(70));
    console.log('📋 SUMMARY');
    console.log('═'.repeat(70));

    console.log(`\n   Spot Rate: 1 VLR = ${usdsPerVlr.toFixed(6)} USDS`);
    console.log(`   YES outcome: 1 YES_VLR = ${yesUsdsPerYesVlr.toFixed(6)} YES_USDS`);
    console.log(`   NO outcome:  1 NO_VLR = ${noUsdsPerNoVlr.toFixed(6)} NO_USDS`);
    console.log(`\n   MIN outcome price: ${minUsdsFromOutcomes.toFixed(6)} USDS per VLR outcome`);
    console.log(`   MAX outcome price: ${maxUsdsFromOutcomes.toFixed(6)} USDS per VLR outcome`);

    console.log(`\n   SPOT_SPLIT: ${spotSplitProfit > 0 ? '✅' : '❌'} ${spotSplitProfitPct.toFixed(4)}% (need MIN > spot)`);
    console.log(`   MERGE_SPOT: ${mergeSpotProfit > 0 ? '✅' : '❌'} ${mergeSpotProfitPct.toFixed(4)}% (need MAX < spot)`);

    // Fees consideration
    const flashLoanFee = 0.003;  // 0.3%
    const swapFee = 0.0005 * 4;  // 0.05% × 4 swaps
    const totalFees = flashLoanFee + swapFee;

    console.log(`\n   📊 Fee Estimate: ~${(totalFees * 100).toFixed(2)}%`);
    console.log(`   Net SPOT_SPLIT: ${((spotSplitProfitPct - totalFees * 100)).toFixed(4)}%`);
    console.log(`   Net MERGE_SPOT: ${((mergeSpotProfitPct - totalFees * 100)).toFixed(4)}%`);

    console.log('\n' + '═'.repeat(70));
}

main().catch(console.error);
