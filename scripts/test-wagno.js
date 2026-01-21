/**
 * Test WAGNO Wrap/Unwrap
 * 
 * This script tests the actual GNO → WAGNO → GNO flow
 * Uses a tiny amount (0.00000001 GNO = 10 wei)
 * 
 * Usage: npx hardhat run scripts/test-wagno.js --network gnosis
 */

const { ethers } = require("hardhat");
require("dotenv").config();

// Contract addresses on Gnosis Chain (proper checksums)
const GNO_ADDRESS = "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb";
const WAGNO_ADDRESS = "0x7c16F0185A26Db0AE7a9377f23BC18ea7ce5d644";

// Test amount: 10 wei = 0.00000000000000001 GNO (very tiny!)
const TEST_AMOUNT = ethers.parseUnits("0.00000001", 18); // 10^10 wei

// ABIs
const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)"
];

// WAGNO is a StaticAToken - we need to find the correct deposit/redeem interface
// Based on Aave StaticAToken pattern
const STATIC_ATOKEN_ABI = [
    // Standard ERC20
    "function balanceOf(address) view returns (uint256)",
    "function symbol() view returns (string)",

    // StaticAToken specific
    "function deposit(uint256 assets, address receiver) returns (uint256 shares)",
    "function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)",
    "function convertToShares(uint256 assets) view returns (uint256)",
    "function convertToAssets(uint256 shares) view returns (uint256)",
    "function asset() view returns (address)",

    // Alternative method names (Aave v2 style)
    "function deposit(address recipient, uint256 amount, uint16 referralCode, bool fromUnderlying) returns (uint256)",
    "function redeem(address recipient, uint256 shares, bool toUnderlying) returns (uint256, uint256)",

    // Rate info
    "function rate() view returns (uint256)",
    "function getRate() view returns (uint256)",

    // aToken
    "function ATOKEN() view returns (address)",
    "function UNDERLYING_ASSET_ADDRESS() view returns (address)"
];

async function main() {
    console.log("\n" + "=".repeat(60));
    console.log("🧪 WAGNO WRAP/UNWRAP TEST");
    console.log("=".repeat(60) + "\n");

    // Get signer
    const [signer] = await ethers.getSigners();
    console.log("📍 Wallet:", signer.address);

    // Connect to contracts
    const gno = new ethers.Contract(GNO_ADDRESS, ERC20_ABI, signer);
    const wagno = new ethers.Contract(WAGNO_ADDRESS, STATIC_ATOKEN_ABI, signer);

    // Check initial balances
    console.log("\n📊 Initial Balances:");
    const gnoBalanceBefore = await gno.balanceOf(signer.address);
    const wagnoBalanceBefore = await wagno.balanceOf(signer.address);
    console.log(`   GNO:   ${ethers.formatEther(gnoBalanceBefore)}`);
    console.log(`   WAGNO: ${ethers.formatEther(wagnoBalanceBefore)}`);

    if (gnoBalanceBefore < TEST_AMOUNT) {
        console.log(`\n❌ Insufficient GNO! Need at least ${ethers.formatEther(TEST_AMOUNT)} GNO`);
        process.exit(1);
    }

    // Try to get underlying and aToken info
    console.log("\n📋 Exploring WAGNO contract...");
    try {
        const underlying = await wagno.UNDERLYING_ASSET_ADDRESS().catch(() => null);
        const atoken = await wagno.ATOKEN().catch(() => null);
        const asset = await wagno.asset().catch(() => null);
        console.log(`   UNDERLYING_ASSET_ADDRESS: ${underlying || 'N/A'}`);
        console.log(`   ATOKEN: ${atoken || 'N/A'}`);
        console.log(`   asset(): ${asset || 'N/A'}`);
    } catch (e) {
        console.log(`   Could not read WAGNO info: ${e.message}`);
    }

    // Step 1: Approve GNO to WAGNO
    console.log(`\n🔐 Step 1: Approve ${ethers.formatEther(TEST_AMOUNT)} GNO to WAGNO...`);
    try {
        const approveTx = await gno.approve(WAGNO_ADDRESS, TEST_AMOUNT);
        console.log(`   TX: ${approveTx.hash}`);
        await approveTx.wait();
        console.log("   ✅ Approved!");

        const allowance = await gno.allowance(signer.address, WAGNO_ADDRESS);
        console.log(`   Allowance: ${ethers.formatEther(allowance)} GNO`);
    } catch (e) {
        console.log(`   ❌ Approve failed: ${e.message}`);
        process.exit(1);
    }

    // Step 2: Deposit GNO to get WAGNO
    console.log(`\n💰 Step 2: Wrap GNO → WAGNO...`);
    let depositSuccess = false;

    // Try ERC4626 style first
    try {
        console.log("   Trying ERC4626 deposit(assets, receiver)...");
        const depositTx = await wagno.getFunction("deposit(uint256,address)")(TEST_AMOUNT, signer.address);
        console.log(`   TX: ${depositTx.hash}`);
        await depositTx.wait();
        console.log("   ✅ Deposit success (ERC4626)!");
        depositSuccess = true;
    } catch (e) {
        console.log(`   ERC4626 failed: ${e.message.slice(0, 80)}...`);
    }

    // Try StaticAToken style if ERC4626 failed
    if (!depositSuccess) {
        try {
            console.log("   Trying StaticAToken deposit(recipient, amount, 0, true)...");
            const depositTx = await wagno.getFunction("deposit(address,uint256,uint16,bool)")(
                signer.address, TEST_AMOUNT, 0, true
            );
            console.log(`   TX: ${depositTx.hash}`);
            await depositTx.wait();
            console.log("   ✅ Deposit success (StaticAToken)!");
            depositSuccess = true;
        } catch (e) {
            console.log(`   StaticAToken failed: ${e.message.slice(0, 80)}...`);
        }
    }

    if (!depositSuccess) {
        console.log("\n❌ Could not deposit GNO to WAGNO. Check contract interface.");
        process.exit(1);
    }

    // Check balances after deposit
    console.log("\n📊 Balances after wrap:");
    const gnoAfterWrap = await gno.balanceOf(signer.address);
    const wagnoAfterWrap = await wagno.balanceOf(signer.address);
    console.log(`   GNO:   ${ethers.formatEther(gnoAfterWrap)} (change: ${ethers.formatEther(gnoAfterWrap - gnoBalanceBefore)})`);
    console.log(`   WAGNO: ${ethers.formatEther(wagnoAfterWrap)} (change: ${ethers.formatEther(wagnoAfterWrap - wagnoBalanceBefore)})`);

    // Step 3: Withdraw WAGNO back to GNO
    const wagnoToRedeem = wagnoAfterWrap - wagnoBalanceBefore;
    if (wagnoToRedeem <= 0n) {
        console.log("\n⚠️  No WAGNO to redeem. Something went wrong.");
        process.exit(1);
    }

    console.log(`\n🔄 Step 3: Unwrap WAGNO → GNO...`);
    let redeemSuccess = false;

    // Try ERC4626 redeem first
    try {
        console.log("   Trying ERC4626 redeem(shares, receiver, owner)...");
        const redeemTx = await wagno.getFunction("redeem(uint256,address,address)")(
            wagnoToRedeem, signer.address, signer.address
        );
        console.log(`   TX: ${redeemTx.hash}`);
        await redeemTx.wait();
        console.log("   ✅ Redeem success (ERC4626)!");
        redeemSuccess = true;
    } catch (e) {
        console.log(`   ERC4626 failed: ${e.message.slice(0, 80)}...`);
    }

    // Try StaticAToken style if ERC4626 failed
    if (!redeemSuccess) {
        try {
            console.log("   Trying StaticAToken redeem(recipient, shares, true)...");
            const redeemTx = await wagno.getFunction("redeem(address,uint256,bool)")(
                signer.address, wagnoToRedeem, true
            );
            console.log(`   TX: ${redeemTx.hash}`);
            await redeemTx.wait();
            console.log("   ✅ Redeem success (StaticAToken)!");
            redeemSuccess = true;
        } catch (e) {
            console.log(`   StaticAToken failed: ${e.message.slice(0, 80)}...`);
        }
    }

    // Check final balances
    console.log("\n📊 Final Balances:");
    const gnoBalanceAfter = await gno.balanceOf(signer.address);
    const wagnoBalanceAfter = await wagno.balanceOf(signer.address);
    console.log(`   GNO:   ${ethers.formatEther(gnoBalanceAfter)}`);
    console.log(`   WAGNO: ${ethers.formatEther(wagnoBalanceAfter)}`);

    console.log("\n📊 Net Changes:");
    console.log(`   GNO:   ${ethers.formatEther(gnoBalanceAfter - gnoBalanceBefore)}`);
    console.log(`   WAGNO: ${ethers.formatEther(wagnoBalanceAfter - wagnoBalanceBefore)}`);

    if (redeemSuccess) {
        console.log("\n✅ WAGNO wrap/unwrap test PASSED!");
    } else {
        console.log("\n⚠️  Wrap succeeded but unwrap failed. Check balances manually.");
    }

    console.log("\n" + "=".repeat(60) + "\n");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("Error:", error);
        process.exit(1);
    });
