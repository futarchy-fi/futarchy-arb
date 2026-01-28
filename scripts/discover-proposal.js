/**
 * Discover Proposal Tokens
 * 
 * Usage: node scripts/discover-proposal.js <PROPOSAL_ADDRESS>
 * Example: node scripts/discover-proposal.js 0x4e018f1D8b93B91a0Ce186874eDb53CB6fFfCa62
 * 
 * This script extracts all token addresses from a Futarchy proposal:
 * - CollateralToken1 (CompanyToken, e.g., AAVE)
 * - CollateralToken2 (CurrencyToken, e.g., GHO, sDAI)
 * - Outcome tokens (YES/NO for each collateral)
 * 
 * It also checks for Uniswap V3 pools between outcomes and
 * reports available liquidity paths.
 */

const { ethers } = require("ethers");

// ============================================================================
// CONFIGURATION
// ============================================================================

const RPC_URL = process.env.MAINNET_RPC_URL || "https://ethereum.publicnode.com";
const PROPOSAL_ADDRESS = process.argv[2];

// Known Infrastructure (Mainnet)
const UNISWAP_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const BALANCER_V2_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
const FUTARCHY_ROUTER = "0xAc9Bf8EbA6Bd31f8E8c76f8E8B2AAd0BD93f98Dc";

// Fee tiers to check for Uniswap V3
const FEE_TIERS = [100, 500, 3000, 10000];

// ============================================================================
// ABIs
// ============================================================================

const PROPOSAL_ABI = [
    "function collateralToken1() external view returns (address)",
    "function collateralToken2() external view returns (address)",
    "function wrappedOutcome(uint256 index) external view returns (address wrapped1155, bytes memory data)",
    "function encodedQuestion() external view returns (bytes memory)",
    "function questionId() external view returns (bytes32)",
    "function conditionId() external view returns (bytes32)",
    "function parentMarket() external view returns (address)",
    "function numOutcomes() external view returns (uint256)"
];

const ERC20_ABI = [
    "function symbol() view returns (string)",
    "function name() view returns (string)",
    "function decimals() view returns (uint8)",
    "function totalSupply() view returns (uint256)"
];

const FACTORY_ABI = [
    "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)"
];

const POOL_ABI = [
    "function liquidity() external view returns (uint128)",
    "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
    "function token0() external view returns (address)",
    "function token1() external view returns (address)"
];

// ============================================================================
// HELPERS
// ============================================================================

async function getTokenInfo(provider, address) {
    try {
        const token = new ethers.Contract(address, ERC20_ABI, provider);
        const [symbol, name, decimals, totalSupply] = await Promise.all([
            token.symbol().catch(() => "UNKNOWN"),
            token.name().catch(() => "Unknown Token"),
            token.decimals().catch(() => 18),
            token.totalSupply().catch(() => 0n)
        ]);
        return { address, symbol, name, decimals, totalSupply };
    } catch (e) {
        return { address, symbol: "ERROR", name: "Error fetching", decimals: 18, totalSupply: 0n };
    }
}

async function findUniswapPool(provider, factory, tokenA, tokenB) {
    const factoryContract = new ethers.Contract(UNISWAP_FACTORY, FACTORY_ABI, provider);

    for (const fee of FEE_TIERS) {
        try {
            const pool = await factoryContract.getPool(tokenA, tokenB, fee);
            if (pool !== "0x0000000000000000000000000000000000000000") {
                // Get pool info
                const poolContract = new ethers.Contract(pool, POOL_ABI, provider);
                const [liquidity, slot0] = await Promise.all([
                    poolContract.liquidity().catch(() => 0n),
                    poolContract.slot0().catch(() => null)
                ]);

                return {
                    exists: true,
                    address: pool,
                    fee,
                    liquidity: liquidity.toString(),
                    hasLiquidity: liquidity > 0n,
                    tick: slot0 ? slot0[1] : null
                };
            }
        } catch (e) {
            // Continue to next fee tier
        }
    }

    return { exists: false, address: null, fee: null, liquidity: "0", hasLiquidity: false };
}

function formatAddress(addr) {
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    if (!PROPOSAL_ADDRESS) {
        console.log("Usage: node scripts/discover-proposal.js <PROPOSAL_ADDRESS>");
        console.log("Example: node scripts/discover-proposal.js 0x4e018f1D8b93B91a0Ce186874eDb53CB6fFfCa62");
        process.exit(1);
    }

    console.log("╔════════════════════════════════════════════════════════════════╗");
    console.log("║  FUTARCHY PROPOSAL DISCOVERY                                   ║");
    console.log("╚════════════════════════════════════════════════════════════════╝\n");

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    console.log(`🔗 RPC: ${RPC_URL}`);
    console.log(`📋 Proposal: ${PROPOSAL_ADDRESS}\n`);

    // =========================================================================
    // 1. BASIC PROPOSAL INFO
    // =========================================================================

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📌 STEP 1: Basic Proposal Info");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    const proposal = new ethers.Contract(PROPOSAL_ADDRESS, PROPOSAL_ABI, provider);

    let questionId, conditionId, numOutcomes, parentMarket;
    try {
        [questionId, conditionId, numOutcomes, parentMarket] = await Promise.all([
            proposal.questionId().catch(() => null),
            proposal.conditionId().catch(() => null),
            proposal.numOutcomes().catch(() => 2),
            proposal.parentMarket().catch(() => null)
        ]);

        console.log(`   Question ID: ${questionId || "N/A"}`);
        console.log(`   Condition ID: ${conditionId || "N/A"}`);
        console.log(`   Num Outcomes: ${numOutcomes}`);
        console.log(`   Parent Market: ${parentMarket || "None (Root Market)"}`);
    } catch (e) {
        console.log(`   ⚠️ Could not fetch some proposal metadata: ${e.message}`);
    }

    // =========================================================================
    // 2. COLLATERAL TOKENS
    // =========================================================================

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("💰 STEP 2: Collateral Tokens (CompanyToken & CurrencyToken)");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    const col1Addr = await proposal.collateralToken1();
    const col2Addr = await proposal.collateralToken2();

    const col1 = await getTokenInfo(provider, col1Addr);
    const col2 = await getTokenInfo(provider, col2Addr);

    console.log(`   CollateralToken1 (CompanyToken):`);
    console.log(`      Symbol:   ${col1.symbol}`);
    console.log(`      Name:     ${col1.name}`);
    console.log(`      Address:  ${col1.address}`);
    console.log(`      Decimals: ${col1.decimals}`);
    console.log(`      Supply:   ${ethers.formatUnits(col1.totalSupply, col1.decimals)}`);

    console.log(`\n   CollateralToken2 (CurrencyToken):`);
    console.log(`      Symbol:   ${col2.symbol}`);
    console.log(`      Name:     ${col2.name}`);
    console.log(`      Address:  ${col2.address}`);
    console.log(`      Decimals: ${col2.decimals}`);
    console.log(`      Supply:   ${ethers.formatUnits(col2.totalSupply, col2.decimals)}`);

    // =========================================================================
    // 3. OUTCOME TOKENS
    // =========================================================================

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🎯 STEP 3: Outcome Tokens (YES/NO for each collateral)");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    const outcomes = [];
    const totalOutcomes = Number(numOutcomes) * 2; // Usually 4 (2 outcomes x 2 collaterals)

    for (let i = 0; i < totalOutcomes; i++) {
        try {
            const [addr] = await proposal.wrappedOutcome(i);
            const info = await getTokenInfo(provider, addr);
            outcomes.push({ index: i, ...info });

            // Determine what this outcome represents
            let description = "";
            if (i === 0) description = `YES_${col1.symbol}`;
            else if (i === 1) description = `NO_${col1.symbol}`;
            else if (i === 2) description = `YES_${col2.symbol}`;
            else if (i === 3) description = `NO_${col2.symbol}`;
            else description = `Outcome_${i}`;

            console.log(`   [${i}] ${description}:`);
            console.log(`       Symbol:  ${info.symbol}`);
            console.log(`       Address: ${info.address}`);
            console.log(`       Supply:  ${ethers.formatUnits(info.totalSupply, info.decimals)}`);
            console.log();
        } catch (e) {
            console.log(`   [${i}] ⚠️ Could not fetch: ${e.message}\n`);
        }
    }

    // =========================================================================
    // 4. UNISWAP V3 POOL DISCOVERY
    // =========================================================================

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🔄 STEP 4: Uniswap V3 Pool Discovery");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    // Check outcome vs outcome pools (the Futarchy pattern)
    const poolChecks = [];

    if (outcomes.length >= 4) {
        // YES_COL1 / YES_COL2
        poolChecks.push({
            name: `YES_${col1.symbol} / YES_${col2.symbol}`,
            tokenA: outcomes[0].address,
            tokenB: outcomes[2].address
        });

        // NO_COL1 / NO_COL2
        poolChecks.push({
            name: `NO_${col1.symbol} / NO_${col2.symbol}`,
            tokenA: outcomes[1].address,
            tokenB: outcomes[3].address
        });

        // Also check outcome vs collateral (legacy/fallback)
        poolChecks.push({
            name: `YES_${col1.symbol} / ${col2.symbol} (legacy)`,
            tokenA: outcomes[0].address,
            tokenB: col2.address
        });

        poolChecks.push({
            name: `NO_${col1.symbol} / ${col2.symbol} (legacy)`,
            tokenA: outcomes[1].address,
            tokenB: col2.address
        });
    }

    // Also check collateral pair
    poolChecks.push({
        name: `${col1.symbol} / ${col2.symbol} (Spot)`,
        tokenA: col1.address,
        tokenB: col2.address
    });

    console.log("   Checking pools...\n");

    for (const check of poolChecks) {
        const result = await findUniswapPool(provider, UNISWAP_FACTORY, check.tokenA, check.tokenB);

        if (result.exists) {
            const status = result.hasLiquidity ? "✅ ACTIVE" : "⚠️ EMPTY";
            console.log(`   ${status} ${check.name}`);
            console.log(`       Pool:      ${result.address}`);
            console.log(`       Fee:       ${result.fee / 10000}%`);
            console.log(`       Liquidity: ${result.liquidity}`);
            console.log();
        } else {
            console.log(`   ❌ NOT FOUND: ${check.name}\n`);
        }
    }

    // =========================================================================
    // 5. SUMMARY
    // =========================================================================

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📋 SUMMARY: Contract Configuration");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    console.log("// Token Addresses (for contract)");
    console.log(`address public constant ${col1.symbol.toUpperCase()} = ${col1.address};`);
    console.log(`address public constant ${col2.symbol.toUpperCase()} = ${col2.address};`);
    console.log();

    if (outcomes.length >= 4) {
        console.log("// Outcome Tokens (populated at runtime from proposal)");
        console.log(`// YES_${col1.symbol}: ${outcomes[0].address}`);
        console.log(`// NO_${col1.symbol}:  ${outcomes[1].address}`);
        console.log(`// YES_${col2.symbol}: ${outcomes[2].address}`);
        console.log(`// NO_${col2.symbol}:  ${outcomes[3].address}`);
    }

    console.log("\n// Proposal");
    console.log(`const PROPOSAL_ADDRESS = "${PROPOSAL_ADDRESS}";`);
    console.log(`const FUTARCHY_ROUTER = "${FUTARCHY_ROUTER}";`);

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("✅ DISCOVERY COMPLETE");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error("Error:", e.message);
        process.exit(1);
    });
