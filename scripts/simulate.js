/**
 * Flash Arbitrage Simulation Script v2
 * 
 * CORRECT price calculation for Futarchy outcome tokens:
 * - YES Pool: YES_GNO / YES_SDAI (price = YES_SDAI per YES_GNO)
 * - NO Pool: NO_GNO / NO_SDAI (price = NO_SDAI per NO_GNO)
 * 
 * Key insight: 1 YES_SDAI + 1 NO_SDAI = 1 sDAI (always, by merging)
 * Similarly: 1 YES_GNO + 1 NO_GNO = 1 GNO (always, by merging)
 * 
 * Usage:
 *   node scripts/simulate.js <PROPOSAL_ADDRESS>
 */

const { ethers } = require("hardhat");
require("dotenv").config();

// ============================================================================
// CONFIGURATION
// ============================================================================

const PROPOSAL_ADDRESS = process.argv[2] || process.env.FUTARCHY_PROPOSAL_ADDRESS;

const LOAN_AMOUNTS = ["100", "1000", "5000", "10000"];

// ============================================================================
// ABIs
// ============================================================================

const FUTARCHY_PROPOSAL_ABI = [
    "function collateralToken1() view returns (address)",
    "function collateralToken2() view returns (address)",
    "function wrappedOutcome(uint256 index) view returns (address wrapped1155, bytes data)",
    "function marketName() view returns (string)"
];

const ALGEBRA_FACTORY_ABI = [
    "function poolByPair(address tokenA, address tokenB) view returns (address pool)"
];

const ALGEBRA_POOL_ABI = [
    "function globalState() view returns (uint160 price, int24 tick, uint16 fee, uint16 timepointIndex, uint8 communityFeeToken0, uint8 communityFeeToken1, bool unlocked)",
    "function liquidity() view returns (uint128)",
    "function token0() view returns (address)",
    "function token1() view returns (address)"
];

// Balancer Vault ABI for spot price
const BALANCER_VAULT_ABI = [
    "function getPoolTokens(bytes32 poolId) view returns (address[] tokens, uint256[] balances, uint256 lastChangeBlock)"
];

const ERC20_ABI = [
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)"
];

// ============================================================================
// PRICE HELPERS
// ============================================================================

function sqrtPriceX96ToPrice(sqrtPriceX96, decimals0 = 18, decimals1 = 18) {
    const Q96 = BigInt(2) ** BigInt(96);
    const sqrtPrice = Number(sqrtPriceX96) / Number(Q96);
    const price = sqrtPrice * sqrtPrice;
    const decimalAdjustment = 10 ** (decimals1 - decimals0);
    return price * decimalAdjustment;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    console.log("\n" + "=".repeat(80));
    console.log("🔬 FUTARCHY ARBITRAGE SIMULATION v2");
    console.log("=".repeat(80) + "\n");

    if (!PROPOSAL_ADDRESS) {
        console.log("❌ Usage: node scripts/simulate.js <PROPOSAL_ADDRESS>");
        process.exit(1);
    }

    console.log("📍 Proposal:", PROPOSAL_ADDRESS);

    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || "https://rpc.gnosischain.com");

    // ========================================================================
    // STEP 1: Load Proposal
    // ========================================================================

    console.log("\n📋 STEP 1: Loading Proposal...\n");

    const proposal = new ethers.Contract(PROPOSAL_ADDRESS, FUTARCHY_PROPOSAL_ABI, provider);

    const marketName = await proposal.marketName();
    const collateral1 = await proposal.collateralToken1();
    const collateral2 = await proposal.collateralToken2();

    const [yesGno] = await proposal.wrappedOutcome(0);
    const [noGno] = await proposal.wrappedOutcome(1);
    const [yesSdai] = await proposal.wrappedOutcome(2);
    const [noSdai] = await proposal.wrappedOutcome(3);

    console.log("   Market:", marketName.slice(0, 80) + "...");
    console.log("   Collateral1 (GNO):", collateral1);
    console.log("   Collateral2 (sDAI):", collateral2);
    console.log("\n   Outcome Tokens:");
    console.log("   ├── YES_GNO  [0]:", yesGno);
    console.log("   ├── NO_GNO   [1]:", noGno);
    console.log("   ├── YES_SDAI [2]:", yesSdai);
    console.log("   └── NO_SDAI  [3]:", noSdai);

    // ========================================================================
    // STEP 2: Find Pools
    // ========================================================================

    console.log("\n📋 STEP 2: Finding Pools...\n");

    const factoryAddress = process.env.ALGEBRA_FACTORY_ADDRESS || "0xA0864cCA6E114013AB0e27cbd5B6f4c8947da766";
    const factory = new ethers.Contract(factoryAddress, ALGEBRA_FACTORY_ABI, provider);

    // YES Pool: YES_GNO / YES_SDAI
    const yesPool = await factory.poolByPair(yesGno, yesSdai);
    // NO Pool: NO_GNO / NO_SDAI  
    const noPool = await factory.poolByPair(noGno, noSdai);
    // Also find Company pools for spot comparison
    const yesGnoSpotPool = await factory.poolByPair(yesGno, collateral2).catch(() => ethers.ZeroAddress);
    const noGnoSpotPool = await factory.poolByPair(noGno, collateral2).catch(() => ethers.ZeroAddress);

    console.log("   YES Pool (YES_GNO/YES_SDAI):", yesPool);
    console.log("   NO Pool (NO_GNO/NO_SDAI):", noPool);
    console.log("   YES_GNO/sDAI Pool:", yesGnoSpotPool || "Not found");
    console.log("   NO_GNO/sDAI Pool:", noGnoSpotPool || "Not found");

    // ========================================================================
    // STEP 3: Get Pool Prices
    // ========================================================================

    console.log("\n📋 STEP 3: Reading Pool Prices...\n");

    // Helper to get price from pool with correct token ordering
    async function getPoolPrice(poolAddress, expectedGnoToken, label) {
        if (!poolAddress || poolAddress === ethers.ZeroAddress) return { price: 0, liquidity: 0n };

        const pool = new ethers.Contract(poolAddress, ALGEBRA_POOL_ABI, provider);
        const [sqrtPriceX96, tick] = await pool.globalState();
        const liquidity = await pool.liquidity();
        const token0 = await pool.token0();

        let rawPrice = sqrtPriceX96ToPrice(sqrtPriceX96);
        // If GNO token is token0, price is SDAI/GNO (what we want)
        // If GNO token is token1, price is GNO/SDAI (need inverse)
        const gnoIsToken0 = token0.toLowerCase() === expectedGnoToken.toLowerCase();
        const price = gnoIsToken0 ? rawPrice : (1 / rawPrice);

        console.log(`   ${label}:`);
        console.log(`   ├── Tick: ${tick}`);
        console.log(`   ├── Token order: ${gnoIsToken0 ? 'GNO/SDAI' : 'SDAI/GNO (inverted)'}`);
        console.log(`   ├── Price: ${price.toFixed(4)} SDAI per GNO`);
        console.log(`   └── Liquidity: ${liquidity.toString()}`);

        return { price, liquidity };
    }

    const yesPoolData = await getPoolPrice(yesPool, yesGno, "YES Pool");
    const noPoolData = await getPoolPrice(noPool, noGno, "NO Pool");

    // Try to get YES_GNO/sDAI and NO_GNO/sDAI for direct pricing
    let yesGnoSdaiPrice = 0, noGnoSdaiPrice = 0;
    if (yesGnoSpotPool && yesGnoSpotPool !== ethers.ZeroAddress) {
        const data = await getPoolPrice(yesGnoSpotPool, yesGno, "YES_GNO/sDAI");
        yesGnoSdaiPrice = data.price;
    }
    if (noGnoSpotPool && noGnoSpotPool !== ethers.ZeroAddress) {
        const data = await getPoolPrice(noGnoSpotPool, noGno, "NO_GNO/sDAI");
        noGnoSdaiPrice = data.price;
    }

    // ========================================================================
    // STEP 4: Calculate Implied Prices
    // ========================================================================

    console.log("\n" + "=".repeat(80));
    console.log("💰 PRICE ANALYSIS");
    console.log("=".repeat(80) + "\n");

    // YES Pool price: YES_SDAI per YES_GNO
    // NO Pool price: NO_SDAI per NO_GNO
    const yesPrice = yesPoolData.price;  // YES_SDAI per YES_GNO
    const noPrice = noPoolData.price;     // NO_SDAI per NO_GNO

    console.log("   📊 Conditional Pool Prices:");
    console.log(`   ├── YES Pool: 1 YES_GNO = ${yesPrice.toFixed(4)} YES_SDAI`);
    console.log(`   └── NO Pool:  1 NO_GNO  = ${noPrice.toFixed(4)} NO_SDAI`);

    // The IMPLIED sDAI values:
    // If YES wins: 1 YES_SDAI = 1 sDAI, 1 NO_SDAI = 0 sDAI
    // If NO wins:  1 YES_SDAI = 0 sDAI, 1 NO_SDAI = 1 sDAI
    // But we can ALWAYS merge: 1 YES_SDAI + 1 NO_SDAI = 1 sDAI

    // The key arbitrage insight:
    // Cost to create 1 YES_GNO + 1 NO_GNO = 1 GNO (split)
    // Revenue from selling:
    //   - 1 YES_GNO → yesPrice YES_SDAI
    //   - 1 NO_GNO → noPrice NO_SDAI
    //   - Merge min(yesPrice, noPrice) pairs → min(yesPrice, noPrice) sDAI
    //   - Left with |yesPrice - noPrice| of either YES_SDAI or NO_SDAI

    const minPrice = Math.min(yesPrice, noPrice);
    const maxPrice = Math.max(yesPrice, noPrice);

    // Merging all pairs we can:
    // We get minPrice sDAI + (maxPrice - minPrice) of the excess SDAI variant
    // The excess is worth something only if we bet on the outcome
    // For risk-free arb, we only count the mergeable amount

    const mergeableValue = minPrice;  // sDAI we can definitely get by merging

    console.log("\n   📊 Arbitrage Calculation:");
    console.log(`   ├── Split 1 GNO → 1 YES_GNO + 1 NO_GNO`);
    console.log(`   ├── Sell YES_GNO → ${yesPrice.toFixed(4)} YES_SDAI`);
    console.log(`   ├── Sell NO_GNO  → ${noPrice.toFixed(4)} NO_SDAI`);
    console.log(`   ├── Merge ${minPrice.toFixed(4)} pairs → ${minPrice.toFixed(4)} sDAI`);
    console.log(`   └── Leftover: ${(maxPrice - minPrice).toFixed(4)} ${yesPrice > noPrice ? 'YES_SDAI' : 'NO_SDAI'} (risky)`);

    // For SPOT price, we need to fetch actual GNO/sDAI 
    // Using Balancer V3 WeightedPool directly (not V2 vault)
    const balancerV3Pool = "0xD1D7Fa8871d84d0E77020fc28B7Cd5718C446522";
    const wagnoRateProvider = "0xbbb4966335677ea24f7b86dc19a423412390e1fb";

    // Balancer V3 WeightedPool ABI
    const BALANCER_V3_POOL_ABI = [
        "function getTokenInfo() view returns (address[] tokens, tuple(uint8 tokenType, address rateProvider, bool paysYieldFees)[] tokenInfo, uint256[] balancesRaw, uint256[] lastBalancesLiveScaled18)",
        "function getTokens() view returns (address[] tokens)",
        "function getCurrentLiveBalances() view returns (uint256[] balancesLiveScaled18)"
    ];

    // Rate Provider ABI
    const RATE_PROVIDER_ABI = [
        "function getRate() view returns (uint256)"
    ];

    let spotPrice = 0;
    let wagnoRate = 1.0;

    try {
        // First, get WAGNO → GNO rate (how many GNO per WAGNO)
        const rateProvider = new ethers.Contract(wagnoRateProvider, RATE_PROVIDER_ABI, provider);
        const rateRaw = await rateProvider.getRate();
        wagnoRate = Number(rateRaw) / 1e18; // Rate is in 18 decimals
        console.log(`\n   📊 WAGNO Rate Provider:`);
        console.log(`   └── 1 WAGNO = ${wagnoRate.toFixed(6)} GNO`);

        // Now get pool balances
        const pool = new ethers.Contract(balancerV3Pool, BALANCER_V3_POOL_ABI, provider);
        const [tokens, , balancesRaw] = await pool.getTokenInfo();

        // Find WAGNO and sDAI
        const wagnoAddress = "0x7c16F0185A26Db0AE7A9377F23BC18ea7Ce5D644";
        const sdaiAddress = collateral2;

        let wagnoBalance = 0n, sdaiBalance = 0n;

        for (let i = 0; i < tokens.length; i++) {
            if (tokens[i].toLowerCase() === wagnoAddress.toLowerCase()) {
                wagnoBalance = balancesRaw[i];
            }
            if (tokens[i].toLowerCase() === sdaiAddress.toLowerCase()) {
                sdaiBalance = balancesRaw[i];
            }
        }

        if (wagnoBalance > 0n && sdaiBalance > 0n) {
            // Pool price = sDAI / WAGNO
            const poolPrice = Number(sdaiBalance) / Number(wagnoBalance);
            // GNO/sDAI = poolPrice / wagnoRate (more WAGNO needed to equal 1 GNO)
            spotPrice = poolPrice / wagnoRate;

            console.log(`\n   📊 Balancer V3 WAGNO/sDAI Pool:`);
            console.log(`   ├── WAGNO Balance: ${ethers.formatEther(wagnoBalance)}`);
            console.log(`   ├── sDAI Balance: ${ethers.formatEther(sdaiBalance)}`);
            console.log(`   ├── Pool Price (sDAI/WAGNO): ${poolPrice.toFixed(4)}`);
            console.log(`   └── SPOT Price (sDAI/GNO): ${spotPrice.toFixed(4)} sDAI per GNO`);
        } else {
            throw new Error("WAGNO or sDAI not found in pool");
        }
    } catch (e) {
        console.log(`   ⚠️  Could not fetch Balancer V3 spot price: ${e.message}`);
        spotPrice = 113.89; // Fallback from screenshot
        console.log(`   └── Using fallback SPOT: ${spotPrice.toFixed(4)} sDAI per GNO`);
    }

    // ========================================================================
    // STEP 5: Arbitrage Edge Detection
    // ========================================================================

    console.log("\n" + "=".repeat(80));
    console.log("🎯 ARBITRAGE EDGE DETECTION");
    console.log("=".repeat(80) + "\n");

    // SPOT_SPLIT Strategy:
    // 1. Buy 1 GNO at SPOT price (cost: spotPrice sDAI)
    // 2. Split → 1 YES_GNO + 1 NO_GNO
    // 3. Sell both on pools → yesPrice YES_SDAI + noPrice NO_SDAI
    // 4. Merge min pairs → minPrice sDAI guaranteed
    // 
    // Risk-free profit only if: minPrice > spotPrice

    const riskFreeProfit = minPrice - spotPrice;
    const riskFreePercent = (riskFreeProfit / spotPrice) * 100;

    console.log("   Strategy: SPOT_SPLIT (buy GNO, split, sell outcomes)");
    console.log("");
    console.log("   RISK-FREE Analysis:");
    console.log(`   ├── Buy 1 GNO at SPOT:    ${spotPrice.toFixed(4)} sDAI`);
    console.log(`   ├── Guaranteed return:    ${minPrice.toFixed(4)} sDAI (merged)`);
    console.log(`   ├── Risk-free profit:     ${riskFreeProfit.toFixed(4)} sDAI (${riskFreePercent.toFixed(2)}%)`);
    console.log(`   └── Extra (risky):        ${(maxPrice - minPrice).toFixed(4)} outcome SDAI`);

    if (riskFreeProfit > 0.5) {
        console.log("\n   ✅ RISK-FREE ARBITRAGE EXISTS!");
        console.log(`      Edge: ${riskFreeProfit.toFixed(2)} sDAI per GNO (${riskFreePercent.toFixed(2)}%)`);
    } else if (riskFreeProfit > 0) {
        console.log("\n   ⚠️  Small edge exists but may not cover fees");
        console.log(`      Edge: ${riskFreeProfit.toFixed(4)} sDAI per GNO`);
    } else {
        console.log("\n   ❌ No risk-free arbitrage available");
        console.log(`      SPOT is ${(-riskFreeProfit).toFixed(4)} sDAI higher than mergeable return`);
    }

    // Including the risky portion (betting on the outcome)
    const fullProfit = yesPrice + noPrice - spotPrice; // If you could sell both for sDAI
    console.log(`\n   RISKY Analysis (assuming both outcomes pay sDAI):`);
    console.log(`   ├── Total pool value:     ${(yesPrice + noPrice).toFixed(4)} outcome SDAI`);
    console.log(`   ├── If both = sDAI:       ${fullProfit.toFixed(4)} sDAI profit`);
    console.log(`   └── Reality: Only ${minPrice.toFixed(4)} is guaranteed`);

    // ========================================================================
    // PROFIT TABLE
    // ========================================================================

    console.log("\n" + "=".repeat(80));
    console.log("📊 PROFIT SIMULATION (RISK-FREE ONLY)");
    console.log("=".repeat(80) + "\n");

    console.log("┌─────────────┬──────────────┬──────────────┬──────────────┬──────────────┐");
    console.log("│ Flash Loan  │ GNO Bought   │ Merge Return │ Est. Profit  │ ROI %        │");
    console.log("│ (sDAI)      │ (at spot)    │ (sDAI)       │ (sDAI)       │              │");
    console.log("├─────────────┼──────────────┼──────────────┼──────────────┼──────────────┤");

    for (const loanStr of LOAN_AMOUNTS) {
        const loan = parseFloat(loanStr);
        const gnoBought = loan / spotPrice;
        const mergeReturn = gnoBought * minPrice;
        const profit = mergeReturn - loan;
        const roi = (profit / loan) * 100;

        console.log(`│ ${loanStr.padStart(11)} │ ${gnoBought.toFixed(4).padStart(12)} │ ${mergeReturn.toFixed(2).padStart(12)} │ ${profit.toFixed(2).padStart(12)} │ ${roi.toFixed(2).padStart(11)}% │`);
    }

    console.log("└─────────────┴──────────────┴──────────────┴──────────────┴──────────────┘");

    console.log("\n" + "=".repeat(80) + "\n");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("Error:", error);
        process.exit(1);
    });
