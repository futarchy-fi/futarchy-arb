/**
 * 📊 Verify Arbitrage Execution Results
 */

const { ethers } = require("hardhat");

const CONTRACT_ADDRESS = "0x5590349f7a460aff6c04f2c70a9d1eedab94f6eb";

async function main() {
    console.log("\n📊 FETCHING ON-CHAIN EXECUTION LOGS\n");
    console.log("=".repeat(60));

    const [signer] = await ethers.getSigners();
    const contract = await ethers.getContractAt("GnosisFlashArbitrageV3", CONTRACT_ADDRESS, signer);

    // Get latest block
    const latestBlock = await ethers.provider.getBlockNumber();
    console.log(`Current Block: ${latestBlock}`);

    // Fetch ArbitrageExecuted events from the last 100 blocks
    const filter = contract.filters.ArbitrageExecuted();
    const events = await contract.queryFilter(filter, latestBlock - 100, latestBlock);

    if (events.length === 0) {
        console.log("❌ No ArbitrageExecuted events found in the last 100 blocks.");
        return;
    }

    console.log(`Found ${events.length} arbitrage events:\n`);

    for (const event of events) {
        const { proposal, direction, borrowToken, borrowAmount, profit, profitRecipient } = event.args;
        console.log(`🔹 TX: ${event.transactionHash}`);
        console.log(`   Proposal:  ${proposal}`);
        console.log(`   Strategy:  ${direction === 0n ? 'SPOT_SPLIT' : 'MERGE_SPOT'}`);
        console.log(`   Borrow:    ${ethers.formatUnits(borrowAmount, 18)} ${borrowToken === "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb" ? 'GNO' : 'Token'}`);
        console.log(`   Profit:    ${ethers.formatUnits(profit, 18)} GNO`);
        console.log(`   Recipient: ${profitRecipient}`);
        console.log("-".repeat(40));
    }

    console.log("\nDone!");
}

main().then(() => process.exit(0)).catch(console.error);
