/**
 * 🔥 Flash Arbitrage Finder & Executor
 * 
 * Finds optimal parameters and executes static call simulation
 * Usage: npx hardhat run scripts/find-arb.js --network gnosis
 */

const { ethers } = require("hardhat");
require("dotenv").config();

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
    contractAddress: "0xe0545480aAB67Bc855806b1f64486F5c77F08eCC",
    proposalAddress: "0x45e1064348fD8A407D6D1F59Fc64B05F633b28FC",
    sdaiAddress: "0xaf204776c7245bF4147c2612BF6e5972Ee483701",
    gnoAddress: "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb",

    // Test amounts (in sDAI)
    testAmounts: [100, 500, 1000, 2000, 5000, 10000],

    // Balancer WAGNO/sDAI pool for spot price
    balancerPool: "0xD1D7Fa8871d84d0E77020fc28B7Cd5718C446522",
    wagnoRateProvider: "0xbbb4966335677ea24f7b86dc19a423412390e1fb"
};

const ArbitrageDirection = {
    YES_TO_NO: 0,
    NO_TO_YES: 1,
    SPOT_SPLIT: 2,
    MERGE_SPOT: 3
};

const DIRECTION_NAMES = ["YES_TO_NO", "NO_TO_YES", "SPOT_SPLIT", "MERGE_SPOT"];

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
    console.log("\n");
    console.log("╔══════════════════════════════════════════════════════════════════╗");
    console.log("║  🔥 FLASH ARBITRAGE FINDER                                       ║");
    console.log("║  GnosisFlashArbitrageV2 - Static Call Analysis                   ║");
    console.log("╚══════════════════════════════════════════════════════════════════╝");

    const [signer] = await ethers.getSigners();
    console.log(`\n👤 Signer: ${signer.address}`);
    console.log(`📍 Contract: ${CONFIG.contractAddress}`);
    console.log(`📋 Proposal: ${CONFIG.proposalAddress}`);

    // Connect to contract
    const contract = await ethers.getContractAt(
        "GnosisFlashArbitrageV3",
        CONFIG.contractAddress,
        signer
    );

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 1: Load Proposal Data
    // ═══════════════════════════════════════════════════════════════════════
    console.log("\n┌─────────────────────────────────────────────────────────────────┐");
    console.log("│ STEP 1: Loading Proposal Data                                   │");
    console.log("└─────────────────────────────────────────────────────────────────┘");

    let proposalInfo;
    try {
        proposalInfo = await contract.loadProposal(CONFIG.proposalAddress);
        console.log(`✅ Proposal Valid: ${proposalInfo.isValid}`);
        console.log(`   YES_GNO:  ${proposalInfo.yesGno}`);
        console.log(`   NO_GNO:   ${proposalInfo.noGno}`);
        console.log(`   YES Pool: ${proposalInfo.yesPool}`);
        console.log(`   NO Pool:  ${proposalInfo.noPool}`);

        if (!proposalInfo.isValid) {
            console.log("❌ Proposal not valid for arbitrage!");
            return;
        }
    } catch (error) {
        console.error("❌ Failed to load proposal:", error.message);
        return;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 2: Analyze Pool Prices
    // ═══════════════════════════════════════════════════════════════════════
    console.log("\n┌─────────────────────────────────────────────────────────────────┐");
    console.log("│ STEP 2: Analyzing Pool Prices                                   │");
    console.log("└─────────────────────────────────────────────────────────────────┘");

    // Helper to fetch pool info locally since V3 contract doesn't have analyzeArbitrageOpportunity
    const getPoolInfo = async (poolAddress) => {
        if (!poolAddress || poolAddress === ethers.ZeroAddress) return { exists: false };
        try {
            const pool = new ethers.Contract(poolAddress, [
                "function globalState() external view returns (uint160 price, int24 tick, uint16, uint16, uint8, uint8, bool)",
                "function liquidity() external view returns (uint128)",
                "function token0() external view returns (address)",
                "function token1() external view returns (address)"
            ], signer);

            const state = await pool.globalState();
            const liquidity = await pool.liquidity();
            const token0 = await pool.token0();
            return {
                exists: true,
                sqrtPriceX96: state.price,
                liquidity: liquidity,
                token0: token0
            };
        } catch (e) {
            console.log(`   ⚠️ Failed to read pool ${poolAddress}: ${e.message.split('(')[0]}`);
            return { exists: false };
        }
    };

    const yesPoolInfo = await getPoolInfo(proposalInfo.yesPool);
    const noPoolInfo = await getPoolInfo(proposalInfo.noPool);

    const Q96 = BigInt(2) ** BigInt(96);

    // Calculate prices (sDAI per GNO)
    let yesPrice = 0, noPrice = 0;

    if (yesPoolInfo.exists) {
        const sqrtP = yesPoolInfo.sqrtPriceX96;
        let rawPrice = Number(sqrtP * sqrtP) / Number(Q96 * Q96);
        // Check if GNO is token0 or token1 to get correct orientation
        yesPrice = yesPoolInfo.token0.toLowerCase() === proposalInfo.yesGno.toLowerCase()
            ? rawPrice : 1 / rawPrice;
        console.log(`   YES Pool: ${yesPrice.toFixed(4)} sDAI/YES_GNO  (Liquidity: ${yesPoolInfo.liquidity.toString()})`);
    }

    if (noPoolInfo.exists) {
        const sqrtP = noPoolInfo.sqrtPriceX96;
        let rawPrice = Number(sqrtP * sqrtP) / Number(Q96 * Q96);
        // Check if GNO is token0 or token1
        noPrice = noPoolInfo.token0.toLowerCase() === proposalInfo.noGno.toLowerCase()
            ? rawPrice : 1 / rawPrice;
        console.log(`   NO Pool:  ${noPrice.toFixed(4)} sDAI/NO_GNO   (Liquidity: ${noPoolInfo.liquidity.toString()})`);
    }

    // Get spot price from Balancer
    let spotPrice = 0;
    try {
        const balancerPool = new ethers.Contract(CONFIG.balancerPool, [
            "function getTokenInfo(address token) view returns (uint256 cash, uint256 managed, uint256 lastLiveBalance, uint256 scalingFactor)"
        ], signer);

        const rateProvider = new ethers.Contract(CONFIG.wagnoRateProvider, [
            "function getRate() view returns (uint256)"
        ], signer);

        const wagnoInfo = await balancerPool.getTokenInfo("0x7c16F0185A26Db0AE7a9377f23BC18ea7ce5d644");
        const sdaiInfo = await balancerPool.getTokenInfo(CONFIG.sdaiAddress);
        const wagnoRate = await rateProvider.getRate();

        const wagnoBalance = Number(ethers.formatEther(wagnoInfo.lastLiveBalance));
        const sdaiBalance = Number(ethers.formatEther(sdaiInfo.lastLiveBalance));
        const rate = Number(ethers.formatEther(wagnoRate));

        const wagnoPriceInSdai = sdaiBalance / wagnoBalance;
        spotPrice = wagnoPriceInSdai / rate;

        console.log(`   SPOT:     ${spotPrice.toFixed(4)} sDAI/GNO     (Balancer V3 via WAGNO)`);
    } catch (error) {
        console.log(`   SPOT:     Unable to fetch (${error.message.slice(0, 50)})`);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 3: Calculate Arbitrage Edges
    // ═══════════════════════════════════════════════════════════════════════
    console.log("\n┌─────────────────────────────────────────────────────────────────┐");
    console.log("│ STEP 3: Arbitrage Edge Analysis                                 │");
    console.log("└─────────────────────────────────────────────────────────────────┘");

    const combinedOutcome = yesPrice + noPrice;
    const mergeEdge = spotPrice > 0 ? ((spotPrice - combinedOutcome) / spotPrice * 100) : 0;
    const splitEdge = spotPrice > 0 ? ((combinedOutcome - spotPrice) / spotPrice * 100) : 0;
    const yesNoEdge = yesPrice > 0 && noPrice > 0 ? ((yesPrice - noPrice) / noPrice * 100) : 0;

    console.log(`\n   📊 PRICE SUMMARY:`);
    console.log(`   ├─ YES Pool Price:     ${yesPrice.toFixed(4)} sDAI/GNO`);
    console.log(`   ├─ NO Pool Price:      ${noPrice.toFixed(4)} sDAI/GNO`);
    console.log(`   ├─ Combined (YES+NO):  ${combinedOutcome.toFixed(4)} sDAI`);
    console.log(`   └─ SPOT Price:         ${spotPrice.toFixed(4)} sDAI/GNO`);

    console.log(`\n   🎯 ARBITRAGE EDGES:`);
    console.log(`   ├─ MERGE_SPOT Edge:    ${mergeEdge > 0 ? '+' : ''}${mergeEdge.toFixed(2)}% ${mergeEdge > 0.5 ? '🔥' : ''}`);
    console.log(`   ├─ SPOT_SPLIT Edge:    ${splitEdge > 0 ? '+' : ''}${splitEdge.toFixed(2)}% ${splitEdge > 0.5 ? '🔥' : ''}`);
    console.log(`   └─ YES↔NO Spread:      ${yesNoEdge > 0 ? '+' : ''}${yesNoEdge.toFixed(2)}%`);

    // Determine best strategy
    let bestStrategy = ArbitrageDirection.MERGE_SPOT;
    let bestEdge = mergeEdge;

    if (splitEdge > mergeEdge && splitEdge > Math.abs(yesNoEdge)) {
        bestStrategy = ArbitrageDirection.SPOT_SPLIT;
        bestEdge = splitEdge;
    } else if (yesNoEdge > 1 && yesNoEdge > mergeEdge) {
        bestStrategy = ArbitrageDirection.YES_TO_NO;
        bestEdge = yesNoEdge;
    } else if (yesNoEdge < -1 && Math.abs(yesNoEdge) > mergeEdge) {
        bestStrategy = ArbitrageDirection.NO_TO_YES;
        bestEdge = Math.abs(yesNoEdge);
    }

    console.log(`\n   ✨ RECOMMENDED: ${DIRECTION_NAMES[bestStrategy]} (${bestEdge.toFixed(2)}% edge)`);

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 4: Static Call Testing
    // ═══════════════════════════════════════════════════════════════════════
    console.log("\n┌─────────────────────────────────────────────────────────────────┐");
    console.log("│ STEP 4: Static Call Testing                                     │");
    console.log("└─────────────────────────────────────────────────────────────────┘");
    console.log("\n   Testing different amounts with all strategies...\n");

    const results = [];

    for (const amount of CONFIG.testAmounts) {
        const amountWei = ethers.parseEther(amount.toString());

        for (const direction of [0, 1, 2, 3]) {
            try {
                await contract.executeProposalArbitrage.staticCall(
                    CONFIG.proposalAddress,
                    CONFIG.sdaiAddress,
                    amountWei,
                    direction,
                    0  // minProfit = 0 for testing
                );
                results.push({
                    amount,
                    direction,
                    directionName: DIRECTION_NAMES[direction],
                    success: true,
                    error: null
                });
            } catch (error) {
                const reason = error.reason || error.message.split('(')[0].slice(0, 60);
                results.push({
                    amount,
                    direction,
                    directionName: DIRECTION_NAMES[direction],
                    success: false,
                    error: reason
                });
            }
        }
    }

    // Print results table
    console.log("   ┌──────────┬──────────────┬─────────┬────────────────────────────────┐");
    console.log("   │  Amount  │   Strategy   │ Result  │  Error/Notes                   │");
    console.log("   ├──────────┼──────────────┼─────────┼────────────────────────────────┤");

    for (const r of results) {
        const amtStr = `${r.amount}`.padStart(6) + " sDAI";
        const stratStr = r.directionName.padEnd(12);
        const resultStr = r.success ? "   ✅  " : "   ❌  ";
        const errorStr = (r.error || "Ready to execute!").slice(0, 30).padEnd(30);
        console.log(`   │ ${amtStr} │ ${stratStr} │${resultStr}│ ${errorStr} │`);
    }

    console.log("   └──────────┴──────────────┴─────────┴────────────────────────────────┘");

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 5: Best Opportunity Summary
    // ═══════════════════════════════════════════════════════════════════════
    const successfulResults = results.filter(r => r.success);

    console.log("\n┌─────────────────────────────────────────────────────────────────┐");
    console.log("│ SUMMARY                                                         │");
    console.log("└─────────────────────────────────────────────────────────────────┘");

    if (successfulResults.length > 0) {
        console.log(`\n   ✅ ${successfulResults.length} viable arbitrage opportunities found!`);
        console.log(`\n   🎯 BEST OPPORTUNITY:`);
        console.log(`      Strategy: ${DIRECTION_NAMES[bestStrategy]}`);
        console.log(`      Edge:     ${bestEdge.toFixed(2)}%`);

        const bestAmount = successfulResults.find(r => r.direction === bestStrategy)?.amount || successfulResults[0].amount;
        console.log(`      Amount:   ${bestAmount} sDAI`);

        console.log(`\n   📋 EXECUTION COMMAND:`);
        console.log(`   npx hardhat run scripts/execute-arb.js --network gnosis -- \\`);
        console.log(`     --amount ${bestAmount} --strategy ${bestStrategy}`);
    } else {
        console.log(`\n   ❌ No viable arbitrage opportunities at current prices.`);
        console.log(`   Common reasons:`);
        console.log(`   - Insufficient liquidity in pools`);
        console.log(`   - Not contract owner`);
        console.log(`   - Pool prices not favorable`);
    }

    console.log("\n╔══════════════════════════════════════════════════════════════════╗");
    console.log("║  Analysis Complete                                               ║");
    console.log("╚══════════════════════════════════════════════════════════════════╝\n");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("\n❌ Script error:", error);
        process.exit(1);
    });
