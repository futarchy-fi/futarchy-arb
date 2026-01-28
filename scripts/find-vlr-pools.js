/**
 * Find Best Pool for VLR Flash Loan
 * 
 * Discovers all Uniswap V3 pools containing VLR and checks their VLR balance.
 * The pool with the most VLR is the best source for flash loans.
 */

require('dotenv').config();
const { ethers } = require('ethers');

// ============================================================================
// CONFIGURATION
// ============================================================================

const RPC_URL = process.env.MAINNET_RPC_URL || 'https://ethereum.publicnode.com';

// Token addresses
const VLR = '0x4e107a0000DB66f0E9Fd2039288Bf811dD1f9c74';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const DAI = '0x6B175474E89094C44Da98b954EescdeCB5BE3830';
const USDS = '0xdC035D45d973E3EC169d2276DDab16f1e407384F';

// Uniswap V3 Factory
const FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';

// Fee tiers to check
const FEE_TIERS = [100, 500, 3000, 10000];

// Common tokens to pair with VLR
const PAIR_TOKENS = [
    { symbol: 'USDC', address: USDC, decimals: 6 },
    { symbol: 'USDT', address: USDT, decimals: 6 },
    { symbol: 'WETH', address: WETH, decimals: 18 },
    { symbol: 'DAI', address: DAI, decimals: 18 },
    { symbol: 'USDS', address: USDS, decimals: 18 },
];

// ============================================================================
// ABIs
// ============================================================================

const FACTORY_ABI = [
    'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)'
];

const POOL_ABI = [
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function fee() view returns (uint24)',
    'function liquidity() view returns (uint128)',
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)'
];

const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)'
];

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║  VLR Pool Discovery - Find Best Flash Loan Source              ║');
    console.log('╚════════════════════════════════════════════════════════════════╝\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);
    const vlrContract = new ethers.Contract(VLR, ERC20_ABI, provider);

    const vlrDecimals = await vlrContract.decimals();
    console.log(`🔍 Searching for VLR pools...\n`);
    console.log(`   VLR Address: ${VLR}`);
    console.log(`   VLR Decimals: ${vlrDecimals}\n`);

    const pools = [];

    // Check each pair token and fee tier
    for (const pairToken of PAIR_TOKENS) {
        for (const fee of FEE_TIERS) {
            try {
                const poolAddress = await factory.getPool(VLR, pairToken.address, fee);

                if (poolAddress !== ethers.ZeroAddress) {
                    // Get pool details
                    const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
                    const [token0, token1, liquidity, slot0] = await Promise.all([
                        pool.token0(),
                        pool.token1(),
                        pool.liquidity(),
                        pool.slot0()
                    ]);

                    // Get VLR balance in the pool
                    const vlrBalance = await vlrContract.balanceOf(poolAddress);

                    // Get pair token balance
                    const pairContract = new ethers.Contract(pairToken.address, ERC20_ABI, provider);
                    const pairBalance = await pairContract.balanceOf(poolAddress);

                    pools.push({
                        pair: `VLR/${pairToken.symbol}`,
                        address: poolAddress,
                        fee: fee,
                        feePercent: `${fee / 10000}%`,
                        vlrBalance,
                        vlrBalanceFormatted: ethers.formatUnits(vlrBalance, vlrDecimals),
                        pairBalance,
                        pairBalanceFormatted: ethers.formatUnits(pairBalance, pairToken.decimals),
                        pairSymbol: pairToken.symbol,
                        liquidity,
                        token0,
                        token1,
                        tick: slot0[1]
                    });
                }
            } catch (e) {
                // Pool doesn't exist or error, skip
            }
        }
    }

    if (pools.length === 0) {
        console.log('❌ No VLR pools found!');
        return;
    }

    // Sort by VLR balance (descending)
    pools.sort((a, b) => {
        if (b.vlrBalance > a.vlrBalance) return 1;
        if (b.vlrBalance < a.vlrBalance) return -1;
        return 0;
    });

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 VLR POOLS FOUND (sorted by VLR balance)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    for (let i = 0; i < pools.length; i++) {
        const p = pools[i];
        const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`;

        console.log(`${rank} ${p.pair} (${p.feePercent} fee)`);
        console.log(`   Address:     ${p.address}`);
        console.log(`   VLR Balance: ${parseFloat(p.vlrBalanceFormatted).toLocaleString()} VLR`);
        console.log(`   ${p.pairSymbol} Balance: ${parseFloat(p.pairBalanceFormatted).toLocaleString()} ${p.pairSymbol}`);
        console.log(`   Liquidity:   ${p.liquidity.toString()}`);
        console.log('');
    }

    // Recommendation
    const best = pools[0];
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🎯 RECOMMENDATION FOR FLASH LOAN');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log(`   Best Pool:     ${best.pair} (${best.feePercent})`);
    console.log(`   Pool Address:  ${best.address}`);
    console.log(`   Max VLR Loan:  ${parseFloat(best.vlrBalanceFormatted).toLocaleString()} VLR`);
    console.log(`   Flash Fee:     ${best.feePercent} of borrowed amount`);
    console.log('');

    // Solidity constants
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📝 SOLIDITY CONSTANTS');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('```solidity');
    console.log(`// Best VLR pool for flash loans`);
    console.log(`address constant VLR_${best.pairSymbol}_POOL = ${best.address};`);
    console.log(`uint24 constant VLR_${best.pairSymbol}_FEE = ${best.fee};`);
    console.log('```');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ Error:', error.message);
        process.exit(1);
    });
