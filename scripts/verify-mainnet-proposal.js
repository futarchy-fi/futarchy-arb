/**
 * Verify Mainnet Proposal Infrastructure
 * 
 * Target: Proposal 0xFb45aE9d8e5874e85b8e23D735EB9718EfEF47Fa
 * Network: Ethereum Mainnet
 * 
 * Usage: node scripts/verify-mainnet-proposal.js
 */

const { ethers } = require("ethers");

// ============================================================================
// CONFIGURATION
// ============================================================================

const RPC_URL = "https://ethereum.publicnode.com";
const PROPOSAL_ADDRESS = "0xFb45aE9d8e5874e85b8e23D735EB9718EfEF47Fa";
const FUTARCHY_ROUTER = "0xAc9Bf8EbA6Bd31f8E8c76f8E8B2AAd0BD93f98Dc";
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const UNISWAP_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const UNISWAP_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";

// Balancer V2 Pools to Check
const POOLS = {
    "GHO_GYD": "0xaa7a70070e7495fe86c67225329dbd39baa2f63b000200000000000000000663",
    "GYD_WSTETH": "0xc8cf54b0b70899ea846b70361e62f3f5b22b1f4b0002000000000000000006c7",
    "WSTETH_AAVE": "0x3de27efa2f1aa663ae5d458857e731c129069f29000200000000000000000588"
};

// ============================================================================
// ABIs
// ============================================================================

const PROPOSAL_ABI = [
    "function collateralToken1() external view returns (address)",
    "function collateralToken2() external view returns (address)",
    "function wrappedOutcome(uint256 index) external view returns (address wrapped1155, bytes memory data)"
];

const ERC20_ABI = [
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function allowance(address owner, address spender) view returns (uint256)"
];

const FACTORY_ABI = [
    "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)"
];

const PERMIT2_ABI = [
    "function allowance(address user, address token, address spender) external view returns (uint160 amount, uint48 expiration, uint48 nonce)"
];

const VAULT_ABI = [
    "function getPool(bytes32 poolId) external view returns (address, uint8)"
];

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    console.log("╔════════════════════════════════════════════════════════════════╗");
    console.log("║  VERIFYING MAINNET PROPOSAL INFRASTRUCTURE                     ║");
    console.log("╚════════════════════════════════════════════════════════════════╝\n");

    const provider = new ethers.JsonRpcProvider(RPC_URL);

    // 1. Check Proposal Tokens
    console.log("🔍 [1/5] Checking Proposal Tokens...");
    const proposal = new ethers.Contract(PROPOSAL_ADDRESS, PROPOSAL_ABI, provider);

    // Collaterals
    const col1 = await proposal.collateralToken1();
    const col2 = await proposal.collateralToken2();

    const token1 = new ethers.Contract(col1, ERC20_ABI, provider);
    const token2 = new ethers.Contract(col2, ERC20_ABI, provider);
    const sym1 = await token1.symbol();
    const sym2 = await token2.symbol();

    console.log(`   Collateral 1: ${sym1} (${col1})`);
    console.log(`   Collateral 2: ${sym2} (${col2})`);

    // Outcomes
    console.log("\n   Fetching Outcome Tokens (Indices 0-3)...");
    const outcomes = [];
    for (let i = 0; i < 4; i++) {
        const [addr] = await proposal.wrappedOutcome(i);
        const symbol = await new ethers.Contract(addr, ERC20_ABI, provider).symbol().catch(() => "UNKNOWN");
        outcomes.push({ index: i, address: addr, symbol });
        console.log(`   [${i}] ${symbol}: ${addr}`);
    }

    // 2. Check Uniswap V3 Pools (Fee 500)
    console.log("\n🔍 [2/5] Checking Uniswap V3 Pools (Fee: 500)...");
    const factory = new ethers.Contract(UNISWAP_FACTORY, FACTORY_ABI, provider);
    const fee = 500;

    // Check Pool: Conditional vs Conditional (YES/YES and NO/NO)
    // Indices: 0=YES_AAVE, 1=NO_AAVE, 2=YES_GHO, 3=NO_GHO

    // We expect pools between corresponding outcomes:
    // YES Pool: YES_AAVE (0) / YES_GHO (2)
    // NO Pool:  NO_AAVE (1) / NO_GHO (3)

    const pairsToCheck = [
        // The likely Futarchy Pairs
        { name: `YES_PAIR: ${outcomes[0].symbol} / ${outcomes[2].symbol}`, t0: outcomes[0].address, t1: outcomes[2].address },
        { name: `NO_PAIR:  ${outcomes[1].symbol} / ${outcomes[3].symbol}`, t0: outcomes[1].address, t1: outcomes[3].address },

        // Sanity checks (Collateral pairs from before, just in case)
        { name: `Legacy: ${outcomes[2].symbol} / ${sym2}`, t0: outcomes[2].address, t1: col2 }, // YES_GHO / GHO
        { name: `Legacy: ${outcomes[0].symbol} / ${sym2}`, t0: outcomes[0].address, t1: col2 }, // YES_AAVE / GHO
    ];

    for (const p of pairsToCheck) {
        const pool = await factory.getPool(p.t0, p.t1, fee);
        const exists = pool !== "0x0000000000000000000000000000000000000000";
        console.log(`   ${p.name}: ${exists ? "✅ " + pool : "❌ Not Found"}`);
    }

    // 3. Check Balancer V2 Pools (Repayment Path)
    console.log("\n🔍 [3/5] Checking Balancer V2 Repayment Pools...");
    const vault = new ethers.Contract("0xBA12222222228d8Ba445958a75a0704d566BF2C8", VAULT_ABI, provider);

    for (const [name, id] of Object.entries(POOLS)) {
        try {
            const [address] = await vault.getPool(id);
            console.log(`   ${name}: ✅ Found (${address})`);
        } catch (e) {
            console.log(`   ${name}: ❌ Invalid Pool ID`);
        }
    }

    // 4. Check Permit2 Allowance Logic
    console.log("\n🔍 [4/5] verifying Permit2 Read Access...");
    const permit2 = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, provider);

    // Check a random address (e.g., Vitalik) for allowance to Uniswap Router
    const user = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"; // Vitalik
    const token = "0xdAC17F958D2ee523a2206206994597C13D831ec7"; // USDT

    try {
        const [amount, expiration, nonce] = await permit2.allowance(user, token, UNISWAP_ROUTER);
        console.log(`   Permit2 Call Success!`);
        console.log(`   User: ${user.slice(0, 6)}...`);
        console.log(`   Token: USDT`);
        console.log(`   Spender: Universal Router`);
        console.log(`   Allowance: ${amount.toString()}`);
        console.log(`   Expiration: ${expiration}`);
        console.log(`   Nonce: ${nonce}`);
    } catch (e) {
        console.log(`   ❌ Permit2 Call Failed: ${e.message}`);
    }

    console.log("\n✅ VERIFICATION COMPLETE");
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
