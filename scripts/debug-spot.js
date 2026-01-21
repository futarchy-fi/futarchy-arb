/**
 * 🔍 Balancer V3 WeightedPool - Spot Price Debug
 * Uses the correct V3 pool interface
 */

const { ethers } = require("hardhat");

// Balancer V3 Addresses (Gnosis)
const WAGNO_SDAI_POOL = "0xd1d7fa8871d84d0e77020fc28b7cd5718c446522";
const RATE_PROVIDER = "0xbbb4966335677ea24f7b86dc19a423412390e1fb";

// Token addresses
const WAGNO = "0x7c16F0185A26Db0AE7a9377f23BC18ea7ce5d644";
const SDAI = "0xaf204776c7245bF4147c2612BF6e5972Ee483701";

// Balancer V3 WeightedPool ABI (relevant functions only)
const WEIGHTED_POOL_ABI = [
    "function getTokens() view returns (address[] tokens)",
    "function getTokenInfo() view returns (address[] tokens, tuple(uint8 tokenType, address rateProvider, bool paysYieldFees)[] tokenInfo, uint256[] balancesRaw, uint256[] lastBalancesLiveScaled18)",
    "function getCurrentLiveBalances() view returns (uint256[] balancesLiveScaled18)",
    "function getWeightedPoolDynamicData() view returns (tuple(uint256[] balancesLiveScaled18, uint256[] tokenRates, uint256 staticSwapFeePercentage, uint256 totalSupply, bool isPoolInitialized, bool isPoolPaused, bool isPoolInRecoveryMode) data)",
    "function getNormalizedWeights() view returns (uint256[])",
    "function getVault() view returns (address)"
];

const RATE_PROVIDER_ABI = [
    "function getRate() view returns (uint256)"
];

async function main() {
    console.log("\n🔍 Balancer V3 WeightedPool - Spot Price Debug\n");
    console.log("=".repeat(60));

    const [signer] = await ethers.getSigners();
    console.log(`Signer: ${signer.address}`);
    console.log(`Pool: ${WAGNO_SDAI_POOL}\n`);

    const pool = new ethers.Contract(WAGNO_SDAI_POOL, WEIGHTED_POOL_ABI, signer);

    // Step 1: Get Vault address
    console.log("📍 Step 1: Get Vault Address");
    try {
        const vault = await pool.getVault();
        console.log(`   Vault: ${vault} ✅`);
    } catch (e) {
        console.log(`   ❌ getVault failed: ${e.message.slice(0, 60)}`);
    }

    // Step 2: Get Tokens
    console.log("\n📍 Step 2: Get Pool Tokens");
    try {
        const tokens = await pool.getTokens();
        console.log(`   Token Count: ${tokens.length}`);
        for (let i = 0; i < tokens.length; i++) {
            const isWagno = tokens[i].toLowerCase() === WAGNO.toLowerCase();
            const isSdai = tokens[i].toLowerCase() === SDAI.toLowerCase();
            console.log(`   Token ${i}: ${tokens[i]} ${isWagno ? '(WAGNO)' : isSdai ? '(sDAI)' : ''}`);
        }
    } catch (e) {
        console.log(`   ❌ getTokens failed: ${e.message.slice(0, 60)}`);
    }

    // Step 3: Get Token Info with Balances
    console.log("\n📍 Step 3: Get Token Info (with balances)");
    let tokens, balancesRaw;
    try {
        const info = await pool.getTokenInfo();
        tokens = info[0] || info.tokens;
        const tokenInfo = info[1] || info.tokenInfo;
        balancesRaw = info[2] || info.balancesRaw;
        const liveBalances = info[3] || info.lastBalancesLiveScaled18;

        console.log(`   ✅ Got token info!`);
        for (let i = 0; i < tokens.length; i++) {
            const isWagno = tokens[i].toLowerCase() === WAGNO.toLowerCase();
            const isSdai = tokens[i].toLowerCase() === SDAI.toLowerCase();
            const label = isWagno ? 'WAGNO' : isSdai ? 'sDAI' : `Token${i}`;
            console.log(`   ${label}:`);
            console.log(`      Balance Raw: ${ethers.formatEther(balancesRaw[i])}`);
            console.log(`      Balance Live: ${ethers.formatEther(liveBalances[i])}`);
            if (tokenInfo[i]) {
                console.log(`      Rate Provider: ${tokenInfo[i].rateProvider || tokenInfo[i][1]}`);
            }
        }
    } catch (e) {
        console.log(`   ❌ getTokenInfo failed: ${e.message.slice(0, 80)}`);
    }

    // Step 4: Get Dynamic Data
    console.log("\n📍 Step 4: Get Weighted Pool Dynamic Data");
    try {
        const data = await pool.getWeightedPoolDynamicData();
        console.log(`   ✅ Got dynamic data!`);
        console.log(`   Balances Live Scaled18: ${data.balancesLiveScaled18.map(b => ethers.formatEther(b)).join(', ')}`);
        console.log(`   Token Rates: ${data.tokenRates.map(r => ethers.formatEther(r)).join(', ')}`);
        console.log(`   Swap Fee: ${Number(data.staticSwapFeePercentage) / 1e16}%`);
        console.log(`   Total Supply: ${ethers.formatEther(data.totalSupply)} BPT`);
        console.log(`   Initialized: ${data.isPoolInitialized}`);
    } catch (e) {
        console.log(`   ❌ getWeightedPoolDynamicData failed: ${e.message.slice(0, 80)}`);
    }

    // Step 5: Get Weights
    console.log("\n📍 Step 5: Get Normalized Weights");
    try {
        const weights = await pool.getNormalizedWeights();
        console.log(`   Weights: ${weights.map(w => (Number(w) / 1e16).toFixed(2) + '%').join(', ')}`);
    } catch (e) {
        console.log(`   ❌ getNormalizedWeights failed: ${e.message.slice(0, 60)}`);
    }

    // Step 6: Get WAGNO Rate
    console.log("\n📍 Step 6: Get WAGNO Rate");
    const rateProvider = new ethers.Contract(RATE_PROVIDER, RATE_PROVIDER_ABI, signer);
    let wagnoRate;
    try {
        wagnoRate = await rateProvider.getRate();
        console.log(`   WAGNO Rate: ${ethers.formatEther(wagnoRate)} GNO per WAGNO ✅`);
    } catch (e) {
        console.log(`   ❌ getRate failed: ${e.message.slice(0, 60)}`);
        wagnoRate = ethers.parseEther("1"); // fallback
    }

    // Step 7: Calculate Spot Price
    console.log("\n📍 Step 7: Calculate GNO/sDAI Spot Price");

    if (tokens && balancesRaw && tokens.length >= 2) {
        let wagnoBalance, sdaiBalance;

        for (let i = 0; i < tokens.length; i++) {
            if (tokens[i].toLowerCase() === WAGNO.toLowerCase()) {
                wagnoBalance = balancesRaw[i];
            } else if (tokens[i].toLowerCase() === SDAI.toLowerCase()) {
                sdaiBalance = balancesRaw[i];
            }
        }

        if (wagnoBalance && sdaiBalance && wagnoBalance > 0) {
            const wagnoNum = Number(ethers.formatEther(wagnoBalance));
            const sdaiNum = Number(ethers.formatEther(sdaiBalance));
            const rateNum = Number(ethers.formatEther(wagnoRate));

            // For a 50/50 weighted pool: price = balance_out / balance_in
            const wagnoInSdai = sdaiNum / wagnoNum;
            console.log(`   sDAI per WAGNO: ${wagnoInSdai.toFixed(4)}`);

            // Convert to GNO: 1 WAGNO = rateNum GNO, so 1 GNO = wagnoInSdai / rateNum sDAI
            const gnoInSdai = wagnoInSdai / rateNum;

            console.log("\n" + "=".repeat(60));
            console.log(`   🎯 GNO SPOT PRICE: ${gnoInSdai.toFixed(4)} sDAI/GNO`);
            console.log("=".repeat(60));

            // Compare with outcome tokens
            console.log("\n📊 Arbitrage Analysis:");
            console.log(`   YES Pool:  ~115.26 sDAI/YES_GNO`);
            console.log(`   NO Pool:   ~115.26 sDAI/NO_GNO`);
            const combined = 115.26 + 115.26;
            console.log(`   Combined:  ${combined.toFixed(2)} sDAI`);
            console.log(`   SPOT:      ${gnoInSdai.toFixed(2)} sDAI/GNO`);

            const mergeEdge = ((gnoInSdai - combined) / gnoInSdai * 100);
            const splitEdge = ((combined - gnoInSdai) / gnoInSdai * 100);

            console.log(`\n   MERGE Edge: ${mergeEdge.toFixed(2)}% ${mergeEdge > 1 ? '🔥' : ''}`);
            console.log(`   SPLIT Edge: ${splitEdge.toFixed(2)}% ${splitEdge > 1 ? '🔥' : ''}`);
        } else {
            console.log("   ❌ Missing WAGNO or sDAI balance");
        }
    } else {
        console.log("   ❌ Could not get tokens/balances");
    }

    console.log("\n✅ Done!\n");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Error:", error);
        process.exit(1);
    });
