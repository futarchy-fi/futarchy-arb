/**
 * Static Call Test for GnosisFlashArbitrageV2
 * 
 * This script tests the deployed contract using static calls
 * to simulate profitability before actual execution.
 */

const { ethers } = require("hardhat");
require("dotenv").config();

// Contract deployed address
const CONTRACT_ADDRESS = "0x16e07953f0673C696771aA0409bE9C4d57870851";

// Test proposal address (FutarchyProposal-1)
const PROPOSAL_ADDRESS = "0x45e1064348fD8A407D6D1F59Fc64B05F633b28FC";

// sDAI token address
const SDAI_ADDRESS = "0xaf204776c7245bF4147c2612BF6e5972Ee483701";

// ArbitrageDirection enum values
const ArbitrageDirection = {
    YES_TO_NO: 0,
    NO_TO_YES: 1,
    SPOT_SPLIT: 2,
    MERGE_SPOT: 3
};

async function main() {
    console.log("\n🔍 GnosisFlashArbitrageV2 Static Call Test");
    console.log("=".repeat(50));
    console.log(`📍 Contract: ${CONTRACT_ADDRESS}`);
    console.log(`📍 Proposal: ${PROPOSAL_ADDRESS}`);
    console.log("");

    const [signer] = await ethers.getSigners();
    console.log(`👤 Signer: ${signer.address}`);

    // Connect to deployed contract
    const contract = await ethers.getContractAt(
        "GnosisFlashArbitrageV2",
        CONTRACT_ADDRESS,
        signer
    );

    // 1. Test loadProposal (view function - free)
    console.log("\n📊 Step 1: Loading Proposal Data...");
    try {
        const proposalInfo = await contract.loadProposal(PROPOSAL_ADDRESS);

        console.log("✅ Proposal loaded successfully!");
        console.log(`   Collateral 1 (GNO): ${proposalInfo.collateralToken1}`);
        console.log(`   Collateral 2 (sDAI): ${proposalInfo.collateralToken2}`);
        console.log(`   YES_GNO: ${proposalInfo.yesGno}`);
        console.log(`   NO_GNO: ${proposalInfo.noGno}`);
        console.log(`   YES_SDAI: ${proposalInfo.yesSdai}`);
        console.log(`   NO_SDAI: ${proposalInfo.noSdai}`);
        console.log(`   YES Pool: ${proposalInfo.yesPool}`);
        console.log(`   NO Pool: ${proposalInfo.noPool}`);
        console.log(`   Is Valid: ${proposalInfo.isValid}`);

        if (!proposalInfo.isValid) {
            console.log("❌ Proposal not valid for arbitrage (collateral mismatch)");
            return;
        }
    } catch (error) {
        console.error("❌ Failed to load proposal:", error.message);
        return;
    }

    // 2. Test analyzeArbitrageOpportunity (view function - free)
    console.log("\n📊 Step 2: Analyzing Arbitrage Opportunity...");
    try {
        const [proposalInfo, yesPoolInfo, noPoolInfo] = await contract.analyzeArbitrageOpportunity(PROPOSAL_ADDRESS);

        console.log("✅ Analysis complete!");
        console.log("\n   YES Pool:");
        console.log(`      Address: ${yesPoolInfo.pool}`);
        console.log(`      Token0: ${yesPoolInfo.token0}`);
        console.log(`      Token1: ${yesPoolInfo.token1}`);
        console.log(`      SqrtPriceX96: ${yesPoolInfo.sqrtPriceX96.toString()}`);
        console.log(`      Liquidity: ${yesPoolInfo.liquidity.toString()}`);
        console.log(`      Exists: ${yesPoolInfo.exists}`);

        console.log("\n   NO Pool:");
        console.log(`      Address: ${noPoolInfo.pool}`);
        console.log(`      Token0: ${noPoolInfo.token0}`);
        console.log(`      Token1: ${noPoolInfo.token1}`);
        console.log(`      SqrtPriceX96: ${noPoolInfo.sqrtPriceX96.toString()}`);
        console.log(`      Liquidity: ${noPoolInfo.liquidity.toString()}`);
        console.log(`      Exists: ${noPoolInfo.exists}`);

        // Calculate human-readable prices
        const Q96 = BigInt(2) ** BigInt(96);

        if (yesPoolInfo.exists) {
            const yesSqrtP = yesPoolInfo.sqrtPriceX96;
            const yesPrice = Number(yesSqrtP * yesSqrtP) / Number(Q96 * Q96);
            console.log(`\n   YES Pool Price (token1/token0): ${yesPrice.toFixed(6)}`);
        }

        if (noPoolInfo.exists) {
            const noSqrtP = noPoolInfo.sqrtPriceX96;
            const noPrice = Number(noSqrtP * noSqrtP) / Number(Q96 * Q96);
            console.log(`   NO Pool Price (token1/token0): ${noPrice.toFixed(6)}`);
        }

    } catch (error) {
        console.error("❌ Analysis failed:", error.message);
        return;
    }

    // 3. Test static call for executeProposalArbitrage
    console.log("\n📊 Step 3: Static Call Simulation...");

    const testAmounts = [
        ethers.parseEther("100"),   // 100 sDAI
        ethers.parseEther("500"),   // 500 sDAI
        ethers.parseEther("1000"),  // 1000 sDAI
    ];

    for (const amount of testAmounts) {
        console.log(`\n   Testing with ${ethers.formatEther(amount)} sDAI...`);

        // Try MERGE_SPOT strategy (based on simulation showing spot price > outcome prices)
        try {
            // Use callStatic to simulate without sending transaction
            await contract.executeProposalArbitrage.staticCall(
                PROPOSAL_ADDRESS,
                SDAI_ADDRESS,
                amount,
                ArbitrageDirection.MERGE_SPOT,
                0  // min profit = 0 for testing
            );
            console.log(`   ✅ MERGE_SPOT: Simulation succeeded!`);
        } catch (error) {
            console.log(`   ❌ MERGE_SPOT failed: ${error.reason || error.message.slice(0, 100)}`);
        }

        // Try SPOT_SPLIT strategy
        try {
            await contract.executeProposalArbitrage.staticCall(
                PROPOSAL_ADDRESS,
                SDAI_ADDRESS,
                amount,
                ArbitrageDirection.SPOT_SPLIT,
                0
            );
            console.log(`   ✅ SPOT_SPLIT: Simulation succeeded!`);
        } catch (error) {
            console.log(`   ❌ SPOT_SPLIT failed: ${error.reason || error.message.slice(0, 100)}`);
        }
    }

    // 4. Check ownership
    console.log("\n📊 Step 4: Checking Contract Ownership...");
    try {
        const owner = await contract.owner();
        console.log(`   Owner: ${owner}`);
        console.log(`   Is Caller Owner: ${owner.toLowerCase() === signer.address.toLowerCase()}`);
    } catch (error) {
        console.error("❌ Failed to check ownership:", error.message);
    }

    console.log("\n" + "=".repeat(50));
    console.log("🎉 Static call test complete!");
    console.log(`\n📌 Contract is live at: https://gnosisscan.io/address/${CONTRACT_ADDRESS}`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Script error:", error);
        process.exit(1);
    });
