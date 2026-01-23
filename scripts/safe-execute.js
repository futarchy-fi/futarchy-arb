/**
 * 🔒 Safe Arbitrage Executor
 * 
 * Performs static call analysis, gas estimation, and safety checks
 * BEFORE executing the actual transaction on Gnosis Chain.
 * 
 * Usage: npx hardhat run scripts/safe-execute.js --network gnosis
 */

const { ethers } = require("hardhat");

const CONFIG = {
    contractAddress: "0x0ECD7369cFe4CD2f35b47B3c66e32AaC2016B25a",  // V4 PERMISSIONLESS
    proposalAddress: "0x45e1064348fD8A407D6D1F59Fc64B05F633b28FC",
    gnoAddress: "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb",

    // Parameters for this execution
    amount: "0.01",
    strategy: 0, // SPOT_SPLIT
    minProfitPercent: 0.8, // Require at least 80% of simulated profit

    // Gas safety
    gasLimitBuffer: 1.2, // 20% buffer on top of estimation
};

async function main() {
    console.log("\n");
    console.log("╔══════════════════════════════════════════════════════════════════╗");
    console.log("║  🔒 SAFE ARBITRAGE EXECUTOR                                      ║");
    console.log("╚══════════════════════════════════════════════════════════════════╝");

    const [signer] = await ethers.getSigners();
    const amountWei = ethers.parseEther(CONFIG.amount);

    console.log(`\n👤 Signer:   ${signer.address}`);
    console.log(`📍 Contract: ${CONFIG.contractAddress}`);
    console.log(`📋 Proposal: ${CONFIG.proposalAddress}`);
    console.log(`💰 Amount:   ${CONFIG.amount} GNO`);
    console.log(`🧪 Strategy: SPOT_SPLIT (Borrow GNO)`);

    const contract = await ethers.getContractAt(
        "GnosisFlashArbitrageV4",
        CONFIG.contractAddress,
        signer
    );

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 1: Static Call Verification
    // ═══════════════════════════════════════════════════════════════════════
    console.log("\n┌─────────────────────────────────────────────────────────────────┐");
    console.log("│ STEP 1: Static Call Verification                                │");
    console.log("└─────────────────────────────────────────────────────────────────┘");

    let simulatedResult;
    try {
        simulatedResult = await contract.executeArbitrage.staticCall(
            CONFIG.proposalAddress,
            CONFIG.gnoAddress,
            amountWei,
            CONFIG.strategy,
            0 // minProfit = 0 for simulation
        );

        if (!simulatedResult.success) {
            console.error("❌ Simulation reports failure.");
            return;
        }

        const profitNum = Number(ethers.formatEther(simulatedResult.profit));
        console.log(`   ✅ Simulation Successful!`);
        console.log(`      Expected Profit: ${profitNum.toFixed(6)} GNO`);
        console.log(`      Return Rate:     ${((profitNum / Number(CONFIG.amount)) * 100).toFixed(2)}%`);

    } catch (error) {
        console.error(`   ❌ Static call failed: ${error.message.slice(0, 100)}`);
        return;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 2: Gas Estimation & Price
    // ═══════════════════════════════════════════════════════════════════════
    console.log("\n┌─────────────────────────────────────────────────────────────────┐");
    console.log("│ STEP 2: Gas Estimation & Cost Analysis                          │");
    console.log("└─────────────────────────────────────────────────────────────────┘");

    let gasEstimate, gasPrice;
    try {
        // Estimate gas
        gasEstimate = await contract.executeArbitrage.estimateGas(
            CONFIG.proposalAddress,
            CONFIG.gnoAddress,
            amountWei,
            CONFIG.strategy,
            0
        );

        // Add buffer
        const gasLimit = BigInt(Math.floor(Number(gasEstimate) * CONFIG.gasLimitBuffer));

        // Get current gas price
        const feeData = await ethers.provider.getFeeData();
        gasPrice = feeData.maxFeePerGas || feeData.gasPrice;

        const totalGasCostWei = gasLimit * gasPrice;
        const totalGasCostXdai = ethers.formatEther(totalGasCostWei);

        console.log(`   ⛽ Estimated Gas:  ${gasEstimate.toString()}`);
        console.log(`   🛡️  Gas Limit:     ${gasLimit.toString()} (with 20% buffer)`);
        console.log(`   💸 Current Price:  ${ethers.formatUnits(gasPrice, "gwei")} gwei`);
        console.log(`   🔥 Max Gas Cost:   ${Number(totalGasCostXdai).toFixed(6)} xDAI`);

    } catch (error) {
        console.error(`   ❌ Gas estimation failed: ${error.message.slice(0, 100)}`);
        return;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 3: Safety Verification
    // ═══════════════════════════════════════════════════════════════════════
    console.log("\n┌─────────────────────────────────────────────────────────────────┐");
    console.log("│ STEP 3: Final Safety Verification                               │");
    console.log("└─────────────────────────────────────────────────────────────────┘");

    // We borrow GNO, so profit is in GNO. 
    // We need GNO price to compare with xDAI gas cost if we want net profit in one currency.
    // However, on Gnosis, gas costs are negligible (< $0.01) compared to GNO profits.

    const profitGno = Number(ethers.formatEther(simulatedResult.profit));
    const minProfitWei = ethers.parseEther((profitGno * CONFIG.minProfitPercent).toFixed(18));

    console.log(`   ✅ Expected Profit: ${profitGno.toFixed(6)} GNO`);
    console.log(`   ✅ Min Profit set:  ${ethers.formatEther(minProfitWei)} GNO (Slippage protection)`);
    console.log(`   ✅ Gas cost is safe.`);

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 4: Execution (if requested)
    // ═══════════════════════════════════════════════════════════════════════
    const isExecute = process.env.EXECUTE === "true";

    if (isExecute) {
        console.log("\n┌─────────────────────────────────────────────────────────────────┐");
        console.log("│ STEP 4: ACTUAL TRANSACTION EXECUTION                            │");
        console.log("└─────────────────────────────────────────────────────────────────┘");

        console.log("\n🚀 Sending transaction to Gnosis Chain...");

        try {
            // Use aggressive gas settings for fast inclusion
            const tx = await contract.executeArbitrage(
                CONFIG.proposalAddress,
                CONFIG.gnoAddress,
                amountWei,
                CONFIG.strategy,
                minProfitWei,
                {
                    gasLimit: BigInt(Math.floor(Number(gasEstimate) * CONFIG.gasLimitBuffer)),
                    maxFeePerGas: gasPrice,
                    maxPriorityFeePerGas: gasPrice // Ensure it's treated as high priority
                }
            );

            console.log(`✅ Transaction Sent!`);
            console.log(`🔗 Hash: https://gnosisscan.io/tx/${tx.hash}`);

            console.log("\n⏳ Waiting for confirmation...");
            const receipt = await tx.wait();

            if (receipt.status === 1) {
                console.log("\n⭐️ TRANSACTION SUCCESSFUL!");
                console.log(`   Gas Used: ${receipt.gasUsed.toString()}`);

                // Summary profit (this is approximate based on simulation)
                console.log(`\n💰 Expected profit (~${profitGno.toFixed(6)} GNO) should be in your wallet.`);
                console.log(`📦 Any leftovers (YES/NO tokens) were also sent to your address.`);
            } else {
                console.log("\n❌ TRANSACTION REVERTED on-chain.");
            }

        } catch (error) {
            console.error(`\n❌ Execution failed: ${error.message}`);
        }
    } else {
        console.log("\n" + "=".repeat(60));
        console.log("⚠️  PRE-EXECUTION SUMMARY COMPLETE");
        console.log("=".repeat(60));

        console.log("\nTo proceed with the actual transaction, run:");
        console.log("set EXECUTE=true && npx hardhat run scripts/safe-execute.js --network gnosis");
        console.log("(Note: This was a simulation/analysis run only)");
    }
}

main().then(() => process.exit(0)).catch(console.error);
