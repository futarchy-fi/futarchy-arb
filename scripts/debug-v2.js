const { ethers } = require("ethers");
require("dotenv").config();

const RPC = process.env.RPC_URL || "https://ethereum.publicnode.com";
const CONTRACT = "0x098321F3f0d20dD4fc9559267a9B1c88AaDd2876";
const PROPOSAL = "0xFb45aE9d8e5874e85b8e23D735EB9718EfEF47Fa";
const AAVE = "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9";

const ABI = [
    "function executeArbitrage(address proposalAddress, address borrowToken, uint256 borrowAmount, uint8 direction, uint256 minProfit) external returns (tuple(bool success, uint256 profit, uint256 borrowAmount) result)"
];

async function main() {
    const provider = new ethers.JsonRpcProvider(RPC);
    const contract = new ethers.Contract(CONTRACT, ABI, provider);
    
    console.log("🔍 Debug: Simulating V2 SPOT_SPLIT with 0.01 AAVE...\n");
    
    try {
        const result = await contract.executeArbitrage.staticCall(
            PROPOSAL,
            AAVE,
            ethers.parseEther("0.01"),
            0, // SPOT_SPLIT
            0  // minProfit
        );
        console.log("✅ Success!", result);
    } catch (e) {
        console.log("❌ Revert:");
        console.log("   Message:", e.message?.slice(0, 200));
        console.log("   Data:", e.data);
        if (e.info?.error) {
            console.log("   Info Error:", e.info.error);
        }
        // Try to decode
        if (e.data) {
            console.log("\n   Raw Error Data:", e.data);
        }
    }
}

main().catch(console.error);
