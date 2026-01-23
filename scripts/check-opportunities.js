/**
 * 🔍 Check Profit Opportunities via Static Calls
 * 
 * Uses static calls (no gas cost) to simulate arbitrage and find profit opportunities
 * Usage: npx hardhat run scripts/check-opportunities.js --network gnosis
 */

const { ethers } = require("hardhat");

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
    // V4 PERMISSIONLESS Contract
    contractAddress: "0x0ECD7369cFe4CD2f35b47B3c66e32AaC2016B25a",

    // Proposal to check
    proposalAddress: "0x45e1064348fD8A407D6D1F59Fc64B05F633b28FC",

    // Token addresses
    gnoAddress: "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb",
    sdaiAddress: "0xaf204776c7245bF4147c2612BF6e5972Ee483701",

    // Balancer V3 for spot price
    wagnoAddress: "0x7c16F0185A26Db0AE7a9377f23BC18ea7ce5d644",
    balancerPool: "0xD1D7Fa8871d84d0E77020fc28B7Cd5718C446522",
    wagnoRateProvider: "0xbbb4966335677ea24f7b86dc19a423412390e1fb",

    // Test amounts for each strategy
    gnoAmounts: ["0.001", "0.005", "0.01", "0.05", "0.1", "0.5", "1"],    // SPOT_SPLIT (borrow GNO)
    sdaiAmounts: ["0.1", "0.5", "1", "10", "50", "100"]     // MERGE_SPOT (borrow sDAI)
};

// Strategy direction constants
const SPOT_SPLIT = 0;  // Borrow GNO → Split → Sell outcomes → Merge sDAI → Swap back
const MERGE_SPOT = 1;  // Borrow sDAI → Split → Buy outcomes → Merge GNO → Swap back

// ABIs
const WEIGHTED_POOL_ABI = [
    "function getTokenInfo() view returns (address[] tokens, tuple(uint8 tokenType, address rateProvider, bool paysYieldFees)[] tokenInfo, uint256[] balancesRaw, uint256[] lastBalancesLiveScaled18)"
];

const RATE_PROVIDER_ABI = [
    "function getRate() view returns (uint256)"
];

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
    console.log("\n");
    console.log("╔══════════════════════════════════════════════════════════════════╗");
    console.log("║  🔍 PROFIT OPPORTUNITY SCANNER                                   ║");
    console.log("║  Static Calls Only - No Gas Cost                                 ║");
    console.log("╚══════════════════════════════════════════════════════════════════╝");

    const [signer] = await ethers.getSigners();
    console.log(`\n👤 Signer: ${signer.address}`);
    console.log(`📍 Contract: ${CONFIG.contractAddress}`);
    console.log(`📋 Proposal: ${CONFIG.proposalAddress}`);

    const contract = await ethers.getContractAt(
        "GnosisFlashArbitrageV4",
        CONFIG.contractAddress,
        signer
    );

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 1: Get Spot Price from Balancer V3
    // ═══════════════════════════════════════════════════════════════════════
    console.log("\n┌─────────────────────────────────────────────────────────────────┐");
    console.log("│ STEP 1: Fetching Spot Price (Balancer V3 WAGNO/sDAI)            │");
    console.log("└─────────────────────────────────────────────────────────────────┘");

    let spotPrice = 0;
    try {
        const pool = new ethers.Contract(CONFIG.balancerPool, WEIGHTED_POOL_ABI, signer);
        const rateProvider = new ethers.Contract(CONFIG.wagnoRateProvider, RATE_PROVIDER_ABI, signer);

        const info = await pool.getTokenInfo();
        const tokens = info[0];
        const balancesRaw = info[2];

        let wagnoBalance, sdaiBalance;
        for (let i = 0; i < tokens.length; i++) {
            if (tokens[i].toLowerCase() === CONFIG.wagnoAddress.toLowerCase()) {
                wagnoBalance = balancesRaw[i];
            } else if (tokens[i].toLowerCase() === CONFIG.sdaiAddress.toLowerCase()) {
                sdaiBalance = balancesRaw[i];
            }
        }

        const wagnoRate = await rateProvider.getRate();

        const wagnoNum = Number(ethers.formatEther(wagnoBalance));
        const sdaiNum = Number(ethers.formatEther(sdaiBalance));
        const rateNum = Number(ethers.formatEther(wagnoRate));

        const wagnoInSdai = sdaiNum / wagnoNum;
        spotPrice = wagnoInSdai / rateNum;

        console.log(`   ✅ GNO Spot Price: ${spotPrice.toFixed(4)} sDAI/GNO`);
        console.log(`      WAGNO Rate:     ${rateNum.toFixed(4)} GNO/WAGNO`);
    } catch (error) {
        console.log(`   ⚠️  Could not fetch spot price: ${error.message.slice(0, 50)}`);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 2: Test SPOT_SPLIT Strategy (Borrow GNO)
    // ═══════════════════════════════════════════════════════════════════════
    console.log("\n┌─────────────────────────────────────────────────────────────────┐");
    console.log("│ STEP 2: SPOT_SPLIT Strategy (Borrow GNO)                        │");
    console.log("│ When profitable: Outcome token prices > Spot GNO price          │");
    console.log("└─────────────────────────────────────────────────────────────────┘\n");

    const spotSplitResults = [];

    for (const amtStr of CONFIG.gnoAmounts) {
        const amount = ethers.parseEther(amtStr);

        try {
            const result = await contract.executeArbitrage.staticCall(
                CONFIG.proposalAddress,
                CONFIG.gnoAddress,
                amount,
                SPOT_SPLIT,
                0  // minProfit = 0 for testing
            );

            const profitNum = Number(ethers.formatEther(result.profit));
            const inputNum = Number(amtStr);
            const profitPercent = (profitNum / inputNum) * 100;

            spotSplitResults.push({
                amount: amtStr,
                profit: profitNum,
                profitPercent,
                success: true,
                leftovers: {
                    yesGno: Number(ethers.formatEther(result.leftoverYesGno)),
                    noGno: Number(ethers.formatEther(result.leftoverNoGno)),
                    yesSdai: Number(ethers.formatEther(result.leftoverYesSdai)),
                    noSdai: Number(ethers.formatEther(result.leftoverNoSdai))
                }
            });

            console.log(`   ✅ ${amtStr.padStart(5)} GNO → Profit: ${profitNum.toFixed(6)} GNO (${profitPercent.toFixed(2)}%)`);

        } catch (error) {
            const reason = extractErrorReason(error);
            spotSplitResults.push({ amount: amtStr, success: false, error: reason });
            console.log(`   ❌ ${amtStr.padStart(5)} GNO → FAILED: ${reason}`);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 3: Test MERGE_SPOT Strategy (Borrow sDAI)
    // ═══════════════════════════════════════════════════════════════════════
    console.log("\n┌─────────────────────────────────────────────────────────────────┐");
    console.log("│ STEP 3: MERGE_SPOT Strategy (Borrow sDAI)                       │");
    console.log("│ When profitable: Spot GNO price > Outcome token prices          │");
    console.log("└─────────────────────────────────────────────────────────────────┘\n");

    const mergeSpotResults = [];

    for (const amtStr of CONFIG.sdaiAmounts) {
        const amount = ethers.parseEther(amtStr);

        try {
            const result = await contract.executeArbitrage.staticCall(
                CONFIG.proposalAddress,
                CONFIG.sdaiAddress,
                amount,
                MERGE_SPOT,
                0  // minProfit = 0 for testing
            );

            const profitNum = Number(ethers.formatEther(result.profit));
            const inputNum = Number(amtStr);
            const profitPercent = (profitNum / inputNum) * 100;

            mergeSpotResults.push({
                amount: amtStr,
                profit: profitNum,
                profitPercent,
                success: true,
                leftovers: {
                    yesGno: Number(ethers.formatEther(result.leftoverYesGno)),
                    noGno: Number(ethers.formatEther(result.leftoverNoGno)),
                    yesSdai: Number(ethers.formatEther(result.leftoverYesSdai)),
                    noSdai: Number(ethers.formatEther(result.leftoverNoSdai))
                }
            });

            console.log(`   ✅ ${amtStr.padStart(5)} sDAI → Profit: ${profitNum.toFixed(4)} sDAI (${profitPercent.toFixed(2)}%)`);

        } catch (error) {
            const reason = extractErrorReason(error);
            mergeSpotResults.push({ amount: amtStr, success: false, error: reason });
            console.log(`   ❌ ${amtStr.padStart(5)} sDAI → FAILED: ${reason}`);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 4: Summary & Best Opportunity
    // ═══════════════════════════════════════════════════════════════════════
    console.log("\n╔══════════════════════════════════════════════════════════════════╗");
    console.log("║  📊 OPPORTUNITY SUMMARY                                          ║");
    console.log("╚══════════════════════════════════════════════════════════════════╝");

    const successfulSpotSplit = spotSplitResults.filter(r => r.success);
    const successfulMergeSpot = mergeSpotResults.filter(r => r.success);

    console.log(`\n   SPOT_SPLIT (GNO): ${successfulSpotSplit.length}/${spotSplitResults.length} profitable`);
    console.log(`   MERGE_SPOT (sDAI): ${successfulMergeSpot.length}/${mergeSpotResults.length} profitable`);

    // Find best opportunity
    let bestOpportunity = null;

    for (const r of successfulSpotSplit) {
        if (!bestOpportunity || r.profitPercent > bestOpportunity.profitPercent) {
            bestOpportunity = { ...r, strategy: "SPOT_SPLIT", token: "GNO" };
        }
    }

    for (const r of successfulMergeSpot) {
        if (!bestOpportunity || r.profitPercent > bestOpportunity.profitPercent) {
            bestOpportunity = { ...r, strategy: "MERGE_SPOT", token: "sDAI" };
        }
    }

    if (bestOpportunity) {
        console.log("\n   🎯 BEST OPPORTUNITY:");
        console.log(`      Strategy:    ${bestOpportunity.strategy}`);
        console.log(`      Amount:      ${bestOpportunity.amount} ${bestOpportunity.token}`);
        console.log(`      Profit:      ${bestOpportunity.profit.toFixed(6)} ${bestOpportunity.token}`);
        console.log(`      Return:      ${bestOpportunity.profitPercent.toFixed(2)}%`);

        // Execution command
        console.log("\n   📋 EXECUTE COMMAND:");
        if (bestOpportunity.strategy === "SPOT_SPLIT") {
            console.log(`      await contract.executeArbitrage(`);
            console.log(`          "${CONFIG.proposalAddress}",`);
            console.log(`          "${CONFIG.gnoAddress}",  // GNO`);
            console.log(`          ethers.parseEther("${bestOpportunity.amount}"),`);
            console.log(`          0,  // SPOT_SPLIT`);
            console.log(`          ethers.parseEther("${(bestOpportunity.profit * 0.9).toFixed(6)}")  // 90% min profit`);
            console.log(`      );`);
        } else {
            console.log(`      await contract.executeArbitrage(`);
            console.log(`          "${CONFIG.proposalAddress}",`);
            console.log(`          "${CONFIG.sdaiAddress}",  // sDAI`);
            console.log(`          ethers.parseEther("${bestOpportunity.amount}"),`);
            console.log(`          1,  // MERGE_SPOT`);
            console.log(`          ethers.parseEther("${(bestOpportunity.profit * 0.9).toFixed(4)}")  // 90% min profit`);
            console.log(`      );`);
        }
    } else {
        console.log("\n   ❌ No profitable opportunities found at current prices.");
        console.log("   Check back later when market conditions change!");
    }

    console.log("\n" + "═".repeat(70) + "\n");
}

// Helper to extract error reason from contract revert
function extractErrorReason(error) {
    if (error.message.includes("Insufficient to repay")) {
        return "Insufficient to repay flash loan";
    }
    if (error.message.includes("Profit below")) {
        return "Profit below minimum";
    }
    if (error.message.includes("liquidity")) {
        return "Pool liquidity insufficient";
    }
    if (error.data && error.data.length > 10) {
        try {
            const iface = new ethers.Interface(["error Error(string)"]);
            const decoded = iface.parseError(error.data);
            return decoded.args[0];
        } catch {
            return "Slippage/liquidity issue";
        }
    }
    return error.message.slice(0, 50);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("\n❌ Script error:", error);
        process.exit(1);
    });
