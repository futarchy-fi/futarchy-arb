/**
 * Check Balancer Vault version on Gnosis
 */

const { ethers } = require("hardhat");

const VAULT_ADDRESS = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";

async function main() {
    console.log("\n🔍 Checking Balancer Vault Version on Gnosis\n");

    const [signer] = await ethers.getSigners();

    // Check if V2 flashLoan exists
    console.log("Testing V2 interface (flashLoan)...");
    const v2Vault = new ethers.Contract(VAULT_ADDRESS, [
        "function flashLoan(address recipient, address[] tokens, uint256[] amounts, bytes userData) external"
    ], signer);

    try {
        // Try to encode the call (won't execute, just checks if function exists)
        const code = await ethers.provider.getCode(VAULT_ADDRESS);
        console.log(`Vault code exists: ${code.length > 2 ? 'YES' : 'NO'}`);
        console.log(`Code length: ${code.length} bytes`);

        // Check for V2 specific function selector: flashLoan(address,address[],uint256[],bytes)
        const v2Selector = ethers.id("flashLoan(address,address[],uint256[],bytes)").slice(0, 10);
        console.log(`V2 flashLoan selector: ${v2Selector}`);
        console.log(`Code contains V2 selector: ${code.includes(v2Selector.slice(2)) ? 'MAYBE' : 'NO'}`);

    } catch (e) {
        console.log(`Error: ${e.message}`);
    }

    // Check if V3 unlock exists
    console.log("\nTesting V3 interface (unlock)...");
    const v3Vault = new ethers.Contract(VAULT_ADDRESS, [
        "function unlock(bytes data) external returns (bytes)"
    ], signer);

    try {
        const v3Selector = ethers.id("unlock(bytes)").slice(0, 10);
        console.log(`V3 unlock selector: ${v3Selector}`);
    } catch (e) {
        console.log(`Error: ${e.message}`);
    }

    // Try calling getPoolTokens (V2 function)
    console.log("\nTesting getPoolTokens (V2 signature)...");
    const vaultV2 = new ethers.Contract(VAULT_ADDRESS, [
        "function getPoolTokens(bytes32) external view returns (address[], uint256[], uint256)"
    ], signer);

    try {
        // Random pool ID
        const result = await vaultV2.getPoolTokens("0x0000000000000000000000000000000000000000000000000000000000000001");
        console.log("V2 getPoolTokens works!");
    } catch (e) {
        console.log(`V2 getPoolTokens failed: ${e.message.slice(0, 80)}`);
    }

    // Check for WAGNO/sDAI pool V3 style
    console.log("\nChecking WAGNO/sDAI pool (V3 style)...");
    const poolV3 = new ethers.Contract("0xd1d7fa8871d84d0e77020fc28b7cd5718c446522", [
        "function getVault() external view returns (address)",
        "function getTokens() external view returns (address[])"
    ], signer);

    try {
        const vault = await poolV3.getVault();
        console.log(`Pool's Vault: ${vault}`);
        console.log(`Expected V2 Vault: ${VAULT_ADDRESS}`);
        console.log(`Match: ${vault.toLowerCase() === VAULT_ADDRESS.toLowerCase() ? 'YES (V2)' : 'NO (V3)'}`);

        const tokens = await poolV3.getTokens();
        console.log(`Pool tokens: ${tokens}`);
    } catch (e) {
        console.log(`Error: ${e.message.slice(0, 80)}`);
    }

    console.log("\n✅ Done!\n");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("Error:", error);
        process.exit(1);
    });
