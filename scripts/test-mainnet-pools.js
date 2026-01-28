/**
 * Test script to discover Uniswap V3 conditional token pools on Ethereum Mainnet
 * 
 * Given a Futarchy proposal address, this script:
 * 1. Loads the wrapped outcome tokens from the proposal
 * 2. Finds the Uniswap V3 YES and NO pools using the 500 fee tier
 * 
 * Example proposal: 0xFb45aE9d8e5874e85b8e23D735EB9718EfEF47Fa
 */

const { ethers } = require("ethers");

// ============================================================================
// CONFIGURATION - Ethereum Mainnet
// ============================================================================

const RPC_URL = "https://ethereum.publicnode.com";
const CHAIN_ID = 1;

// Contract Addresses
const UNISWAP_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const FUTARCHY_ROUTER = "0xAc9Bf8EbA6Bd31f8E8c76f8E8B2AAd0BD93f98Dc";

// Default fee tier for Futarchy pools (0.05%)
const DEFAULT_FEE_TIER = 500;

// Example proposal on Mainnet
const EXAMPLE_PROPOSAL = "0xFb45aE9d8e5874e85b8e23D735EB9718EfEF47Fa";

// ============================================================================
// ABIs
// ============================================================================

const PROPOSAL_ABI = [
    "function collateralToken1() view returns (address)",
    "function collateralToken2() view returns (address)",
    "function wrappedOutcome(uint256 index) view returns (address wrapped1155, bytes data)"
];

const ERC20_ABI = [
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function name() view returns (string)"
];

const FACTORY_ABI = [
    "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)"
];

const POOL_ABI = [
    "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
    "function token0() view returns (address)",
    "function token1() view returns (address)",
    "function fee() view returns (uint24)",
    "function liquidity() view returns (uint128)"
];

// ============================================================================
// MAIN FUNCTIONS
// ============================================================================

async function loadProposalTokens(provider, proposalAddress) {
    console.log("\n📋 Loading Proposal:", proposalAddress);
    console.log("=".repeat(60));

    const proposal = new ethers.Contract(proposalAddress, PROPOSAL_ABI, provider);

    // Get collateral tokens
    const collateral1 = await proposal.collateralToken1();
    const collateral2 = await proposal.collateralToken2();

    console.log("\nCollateral Tokens:");
    console.log("  Token 1:", collateral1);
    console.log("  Token 2:", collateral2);

    // Get wrapped outcome tokens (same as GnosisFlashArbitrageV4)
    // Index 0: YES_Collateral1, Index 1: NO_Collateral1
    // Index 2: YES_Collateral2, Index 3: NO_Collateral2
    const [yesToken1] = await proposal.wrappedOutcome(0);
    const [noToken1] = await proposal.wrappedOutcome(1);
    const [yesToken2] = await proposal.wrappedOutcome(2);
    const [noToken2] = await proposal.wrappedOutcome(3);

    console.log("\nWrapped Outcome Tokens:");
    console.log("  YES_CollateralToken1:", yesToken1);
    console.log("  NO_CollateralToken1: ", noToken1);
    console.log("  YES_CollateralToken2:", yesToken2);
    console.log("  NO_CollateralToken2: ", noToken2);

    // Try to get token symbols
    try {
        const tok1 = new ethers.Contract(collateral1, ERC20_ABI, provider);
        const tok2 = new ethers.Contract(collateral2, ERC20_ABI, provider);
        const [sym1, sym2] = await Promise.all([tok1.symbol(), tok2.symbol()]);
        console.log(`\n  Collateral 1: ${sym1}`);
        console.log(`  Collateral 2: ${sym2}`);
    } catch (e) {
        console.log("  (Could not fetch token symbols)");
    }

    return {
        collateral1,
        collateral2,
        yesToken1,
        noToken1,
        yesToken2,
        noToken2
    };
}

async function findUniswapPool(provider, tokenA, tokenB, feeTier = DEFAULT_FEE_TIER) {
    const factory = new ethers.Contract(UNISWAP_FACTORY, FACTORY_ABI, provider);

    const poolAddress = await factory.getPool(tokenA, tokenB, feeTier);

    if (poolAddress === ethers.ZeroAddress) {
        return null;
    }

    return poolAddress;
}

async function getPoolInfo(provider, poolAddress) {
    if (!poolAddress || poolAddress === ethers.ZeroAddress) {
        return null;
    }

    const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);

    try {
        const [slot0, token0, token1, fee, liquidity] = await Promise.all([
            pool.slot0(),
            pool.token0(),
            pool.token1(),
            pool.fee(),
            pool.liquidity()
        ]);

        // Calculate price from sqrtPriceX96
        const sqrtPriceX96 = slot0.sqrtPriceX96;
        const price = (Number(sqrtPriceX96) / (2 ** 96)) ** 2;

        return {
            address: poolAddress,
            token0,
            token1,
            fee: Number(fee),
            currentTick: Number(slot0.tick),
            price,
            liquidity: liquidity.toString()
        };
    } catch (e) {
        console.log(`  Error reading pool ${poolAddress}:`, e.message);
        return null;
    }
}

async function discoverConditionalPools(provider, tokens) {
    console.log("\n🔍 Discovering Uniswap V3 Pools (fee tier:", DEFAULT_FEE_TIER, ")");
    console.log("=".repeat(60));

    // YES Pool: yesToken1 <-> yesToken2 (e.g., YES_GNO <-> YES_sDAI)
    console.log("\n📊 YES Pool (yesToken1 <-> yesToken2):");
    const yesPoolAddress = await findUniswapPool(provider, tokens.yesToken1, tokens.yesToken2, DEFAULT_FEE_TIER);

    if (yesPoolAddress) {
        console.log("  ✅ Found:", yesPoolAddress);
        const yesPoolInfo = await getPoolInfo(provider, yesPoolAddress);
        if (yesPoolInfo) {
            console.log("  Token0:", yesPoolInfo.token0);
            console.log("  Token1:", yesPoolInfo.token1);
            console.log("  Fee:", yesPoolInfo.fee / 10000, "%");
            console.log("  Liquidity:", yesPoolInfo.liquidity);
            console.log("  Current Tick:", yesPoolInfo.currentTick);
            console.log("  Price (token0/token1):", yesPoolInfo.price.toFixed(8));
        }
    } else {
        console.log("  ❌ Not found");
    }

    // NO Pool: noToken1 <-> noToken2 (e.g., NO_GNO <-> NO_sDAI)
    console.log("\n📊 NO Pool (noToken1 <-> noToken2):");
    const noPoolAddress = await findUniswapPool(provider, tokens.noToken1, tokens.noToken2, DEFAULT_FEE_TIER);

    if (noPoolAddress) {
        console.log("  ✅ Found:", noPoolAddress);
        const noPoolInfo = await getPoolInfo(provider, noPoolAddress);
        if (noPoolInfo) {
            console.log("  Token0:", noPoolInfo.token0);
            console.log("  Token1:", noPoolInfo.token1);
            console.log("  Fee:", noPoolInfo.fee / 10000, "%");
            console.log("  Liquidity:", noPoolInfo.liquidity);
            console.log("  Current Tick:", noPoolInfo.currentTick);
            console.log("  Price (token0/token1):", noPoolInfo.price.toFixed(8));
        }
    } else {
        console.log("  ❌ Not found");
    }

    // Try other fee tiers if 500 not found
    if (!yesPoolAddress || !noPoolAddress) {
        console.log("\n🔁 Trying alternative fee tiers...");
        const altFeeTiers = [100, 3000, 10000];

        for (const feeTier of altFeeTiers) {
            console.log(`\n  Fee tier ${feeTier} (${feeTier / 10000}%):`);

            if (!yesPoolAddress) {
                const altYes = await findUniswapPool(provider, tokens.yesToken1, tokens.yesToken2, feeTier);
                if (altYes) console.log(`    YES Pool found: ${altYes}`);
            }

            if (!noPoolAddress) {
                const altNo = await findUniswapPool(provider, tokens.noToken1, tokens.noToken2, feeTier);
                if (altNo) console.log(`    NO Pool found: ${altNo}`);
            }
        }
    }

    return {
        yesPool: yesPoolAddress,
        noPool: noPoolAddress
    };
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main() {
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║  MAINNET CONDITIONAL TOKEN POOL DISCOVERY                  ║");
    console.log("║  Chain: Ethereum (ID: 1)                                   ║");
    console.log("╚════════════════════════════════════════════════════════════╝");

    // Get proposal from command line or use example
    const proposalAddress = process.argv[2] || EXAMPLE_PROPOSAL;

    // Connect to Ethereum Mainnet
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const network = await provider.getNetwork();
    console.log("\n🌐 Connected to:", network.name, "(Chain ID:", network.chainId.toString(), ")");

    // Load proposal tokens
    const tokens = await loadProposalTokens(provider, proposalAddress);

    // Discover pools
    const pools = await discoverConditionalPools(provider, tokens);

    // Summary
    console.log("\n" + "=".repeat(60));
    console.log("📋 SUMMARY");
    console.log("=".repeat(60));
    console.log("\nProposal:", proposalAddress);
    console.log("\nOutcome Tokens:");
    console.log("  YES Token 1:", tokens.yesToken1);
    console.log("  NO Token 1: ", tokens.noToken1);
    console.log("  YES Token 2:", tokens.yesToken2);
    console.log("  NO Token 2: ", tokens.noToken2);
    console.log("\nPools (fee tier 500):");
    console.log("  YES Pool:", pools.yesPool || "NOT FOUND");
    console.log("  NO Pool: ", pools.noPool || "NOT FOUND");

    // Return for programmatic use
    return { tokens, pools };
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("\n❌ Error:", error.message);
        process.exit(1);
    });
