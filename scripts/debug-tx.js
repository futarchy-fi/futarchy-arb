/**
 * 🕵️ Transaction Debugger
 * 
 * Fetches transaction receipt and decodes custom error if it reverted.
 */

const { ethers } = require("hardhat");

const TX_HASH = "0xce5daf52b8555341c747a522ad62885dd747f8c"; // Need to verify this hash

async function main() {
    console.log(`\n🕵️ ANALYZING TRANSACTION: ${TX_HASH}\n`);

    const receipt = await ethers.provider.getTransactionReceipt(TX_HASH);
    if (!receipt) {
        console.log("❌ Transaction not found or not mined yet.");
        return;
    }

    console.log(`Status: ${receipt.status === 1 ? "SUCCESS" : "FAILED (REVERTED)"}`);
    console.log(`Block:  ${receipt.blockNumber}`);
    console.log(`Gas Used: ${receipt.gasUsed.toString()}`);

    if (receipt.status === 0) {
        console.log("\n🔍 Attempting to decode revert reason...");

        try {
            const tx = await ethers.provider.getTransaction(TX_HASH);
            const code = await ethers.provider.call({
                to: tx.to,
                from: tx.from,
                nonce: tx.nonce,
                gasLimit: tx.gasLimit,
                gasPrice: tx.gasPrice,
                data: tx.data,
                value: tx.value,
                blockTag: receipt.blockNumber
            });
            console.log("Raw Revert Data:", code);
        } catch (error) {
            console.log("❌ Revert Reason Retrieval failed:", error.message);

            if (error.data) {
                console.log("Error Data Found! Decoding...");
                decodeCustomError(error.data);
            }
        }
    }
}

function decodeCustomError(data) {
    try {
        const iface = new ethers.Interface([
            "error ArbitrageFailed(uint256 balanceAfter, uint256 borrowAmount, string reason)"
        ]);
        const decoded = iface.parseError(data);
        console.log("\n🚨 DECODED ERROR:");
        console.log(`   Reason:        ${decoded.args[2]}`);
        console.log(`   Balance After: ${ethers.formatEther(decoded.args[0])} GNO`);
        console.log(`   Borrow Amount: ${ethers.formatEther(decoded.args[1])} GNO`);
        console.log(`   Delta:         ${ethers.formatEther(decoded.args[0] - decoded.args[1])} GNO`);
    } catch (e) {
        console.log("   Could not decode custom error:", e.message);
    }
}

main().then(() => process.exit(0)).catch(console.error);
