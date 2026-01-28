/**
 * discover-vlr-pools.js
 * 
 * Discovers VLR/USDS proposal outcome tokens and checks if Uniswap V3 pools exist.
 * 
 * Usage: node scripts/discover-vlr-pools.js
 */

const { ethers } = require('ethers');
require('dotenv').config();

// ========================================
// Configuration
// ========================================

const PROPOSAL = '0x4e018f1D8b93B91a0Ce186874eDb53CB6fFfCa62';
const FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const FEE_TIERS = [100, 500, 3000, 10000]; // All possible fee tiers

// Known tokens
const VLR = '0x4e107a0000DB66f0E9Fd2039288Bf811dD1f9c74';
const USDS = '0xdC035D45d973E3EC169d2276DDab16f1e407384F';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

// ========================================
// ABIs
// ========================================

const PROPOSAL_ABI = [
    'function collateralToken1() view returns (address)',
    'function collateralToken2() view returns (address)',
    'function wrappedOutcome(uint256 index) view returns (address wrapped1155, bytes memory data)'
];

const FACTORY_ABI = [
    'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)'
];

const POOL_ABI = [
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function fee() view returns (uint24)',
    'function liquidity() view returns (uint128)'
];

const ERC20_ABI = [
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function balanceOf(address) view returns (uint256)'
];

// ========================================
// Main Discovery
// ========================================

async function main() {
    const provider = new ethers.JsonRpcProvider(process.env.MAINNET_RPC_URL || 'https://ethereum.publicnode.com');

    console.log('═'.repeat(60));
    console.log('🔍 VLR/USDS Proposal Pool Discovery');
    console.log('═'.repeat(60));
    console.log(`\nProposal: ${PROPOSAL}`);

    // ========================================
    // Step 1: Get Proposal Token Info
    // ========================================

    console.log('\n📋 Step 1: Reading Proposal Tokens...\n');

    const proposal = new ethers.Contract(PROPOSAL, PROPOSAL_ABI, provider);

    const collateral1 = await proposal.collateralToken1();
    const collateral2 = await proposal.collateralToken2();

    console.log(`CollateralToken1 (Company): ${collateral1}`);
    console.log(`CollateralToken2 (Currency): ${collateral2}`);

    // Verify they match expected
    console.log(`\n✅ VLR Match: ${collateral1.toLowerCase() === VLR.toLowerCase()}`);
    console.log(`✅ USDS Match: ${collateral2.toLowerCase() === USDS.toLowerCase()}`);

    // ========================================
    // Step 2: Get Wrapped Outcome Tokens
    // ========================================

    console.log('\n📋 Step 2: Getting Wrapped Outcome Tokens...\n');

    const outcomes = [];
    const outcomeNames = ['YES_VLR (idx 0)', 'NO_VLR (idx 1)', 'YES_USDS (idx 2)', 'NO_USDS (idx 3)'];

    for (let i = 0; i < 4; i++) {
        const [wrappedAddress] = await proposal.wrappedOutcome(i);
        outcomes.push(wrappedAddress);
        console.log(`${outcomeNames[i]}: ${wrappedAddress}`);
    }

    const [YES_VLR, NO_VLR, YES_USDS, NO_USDS] = outcomes;

    // ========================================
    // Step 3: Check Uniswap V3 Pools for Outcomes
    // ========================================

    console.log('\n📋 Step 3: Checking Uniswap V3 Pools for Outcome Tokens...\n');

    const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);

    // Check YES_VLR / YES_USDS pool
    console.log('🔍 Checking YES_VLR / YES_USDS pools:');
    await checkAllFeeTiers(factory, provider, YES_VLR, YES_USDS, 'YES_VLR/YES_USDS');

    // Check NO_VLR / NO_USDS pool
    console.log('\n🔍 Checking NO_VLR / NO_USDS pools:');
    await checkAllFeeTiers(factory, provider, NO_VLR, NO_USDS, 'NO_VLR/NO_USDS');

    // ========================================
    // Step 4: Check VLR/USDC Flash Loan Pool
    // ========================================

    console.log('\n📋 Step 4: Checking VLR/USDC Flash Loan Source Pool...\n');
    await checkAllFeeTiers(factory, provider, VLR, USDC, 'VLR/USDC');

    // Get VLR balance in best pool
    const vlrUsdcPool = await factory.getPool(VLR, USDC, 3000);
    if (vlrUsdcPool !== ethers.ZeroAddress) {
        const vlrToken = new ethers.Contract(VLR, ERC20_ABI, provider);
        const vlrBalance = await vlrToken.balanceOf(vlrUsdcPool);
        console.log(`\n💰 VLR in pool: ${ethers.formatEther(vlrBalance)} VLR`);
        console.log(`   (Max flash loan available)`);
    }

    // ========================================
    // Step 5: Check USDS/USDC Routing Pool
    // ========================================

    console.log('\n📋 Step 5: Checking USDS/USDC Routing Pool...\n');
    await checkAllFeeTiers(factory, provider, USDS, USDC, 'USDS/USDC');

    console.log('\n' + '═'.repeat(60));
    console.log('✅ Discovery Complete');
    console.log('═'.repeat(60));
}

async function checkAllFeeTiers(factory, provider, tokenA, tokenB, pairName) {
    let found = false;

    for (const fee of FEE_TIERS) {
        const poolAddress = await factory.getPool(tokenA, tokenB, fee);

        if (poolAddress !== ethers.ZeroAddress) {
            found = true;
            const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
            const liquidity = await pool.liquidity();
            const [token0, token1] = await Promise.all([pool.token0(), pool.token1()]);

            console.log(`\n  ✅ FOUND: ${pairName} @ ${fee / 10000}% fee`);
            console.log(`     Pool: ${poolAddress}`);
            console.log(`     Token0: ${token0}`);
            console.log(`     Token1: ${token1}`);
            console.log(`     Liquidity: ${liquidity.toString()}`);
        }
    }

    if (!found) {
        console.log(`  ❌ NO POOLS FOUND for ${pairName}`);
    }

    return found;
}

main().catch(console.error);
