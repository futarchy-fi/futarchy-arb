/**
 * Trace SPOT_SPLIT arb using pool math to compute exact outputs.
 * Usage: npx hardhat run scripts/traceArbMath.js --network gnosis
 */
const { ethers } = require("hardhat");

const GNO = "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb";
const SDAI = "0xaf204776c7245bF4147c2612BF6e5972Ee483701";
const YES_GNO = "0xcBD75765B52c278a61a481E8c79C16D8D9b08Cca";
const NO_GNO = "0x4339E3e5168C9bB2EC6e7Ab66bce64487f2FcaC4";
const YES_SDAI = "0x75C292EB27E33D36B087c84Ad3131197dE03B483";
const NO_SDAI = "0x26853F7B8F70DCe83326A12317B7aEE5a20D0404";
const YES_POOL = "0x5Ce6E5Bb8866B30ffbA342A9D988788A4011182F";
const NO_POOL = "0xd78Ea40dC62E763a41dBDAC744005192b57412E6";
const SPOT_POOL = "0x80086B6A53249277961c8672F0C22B3f54AC85FB";
const BALANCER_V2 = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
const USDC = "0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83";
const WXDAI = "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d";

const POOL_ABI = [
    "function globalState() view returns (uint160 price, int24 tick, uint16 fee, uint16 timepointIndex, uint8 communityFeeToken0, uint8 communityFeeToken1, bool unlocked)",
    "function liquidity() view returns (uint128)",
    "function token0() view returns (address)",
    "function token1() view returns (address)",
];

const BALANCER_V2_ABI = [
    "function queryBatchSwap(uint8 kind, (bytes32 poolId, uint256 assetInIndex, uint256 assetOutIndex, uint256 amount, bytes userData)[] swaps, address[] assets, (address sender, bool fromInternalBalance, address recipient, bool toInternalBalance) funds) external returns (int256[] memory)",
];

// Compute swap output for exactIn on concentrated liquidity pool
// Selling token1 to get token0: sqrtPrice increases
// Selling token0 to get token1: sqrtPrice decreases
function computeSwapOutput(sqrtPriceX96, liquidity, amountInWei, feeRaw, sellingToken1) {
    const Q96 = 2n ** 96n;
    const FEE_DENOM = 1000000n;

    // Apply fee
    const feeAmount = (amountInWei * BigInt(feeRaw)) / FEE_DENOM;
    const amountInAfterFee = amountInWei - feeAmount;

    let sqrtPriceNew;
    let amountOut;

    if (sellingToken1) {
        // Selling token1 (GNO) for token0 (sDAI): price goes UP
        // sqrtP_new = sqrtP + amountIn * Q96 / L
        sqrtPriceNew = sqrtPriceX96 + (amountInAfterFee * Q96) / liquidity;
        // amount0_out = L * (1/sqrtP_old - 1/sqrtP_new) = L * Q96 * (sqrtP_new - sqrtP_old) / (sqrtP_old * sqrtP_new)
        // Simplified: amount0_out = L * (sqrtP_new - sqrtP_old) * Q96 / (sqrtP_old * sqrtP_new / Q96)
        // Let's do it step by step with bigint
        const numerator = liquidity * (sqrtPriceNew - sqrtPriceX96) * Q96;
        const denominator = sqrtPriceX96 * sqrtPriceNew;
        amountOut = numerator / denominator;
    } else {
        // Selling token0 (sDAI) for token1 (GNO): price goes DOWN
        // sqrtP_new = L * sqrtP / (L + amountIn * sqrtP / Q96)
        // = L * sqrtP * Q96 / (L * Q96 + amountIn * sqrtP)
        const num = liquidity * sqrtPriceX96;
        const den = liquidity + (amountInAfterFee * sqrtPriceX96 / Q96);
        sqrtPriceNew = num / den;
        // amount1_out = L * (sqrtP_old - sqrtP_new) / Q96
        amountOut = liquidity * (sqrtPriceX96 - sqrtPriceNew) / Q96;
    }

    return { amountOut, sqrtPriceNew, feeAmount };
}

async function main() {
    const [signer] = await ethers.getSigners();
    const amountWei = ethers.parseEther("0.01");

    console.log("=== SPOT_SPLIT ARB TRACE: 0.01 GNO ===\n");

    // Read pool states
    const yesPool = new ethers.Contract(YES_POOL, POOL_ABI, signer);
    const noPool = new ethers.Contract(NO_POOL, POOL_ABI, signer);
    const spotPool = new ethers.Contract(SPOT_POOL, POOL_ABI, signer);

    const [yesGs, noGs, spotGs, yesLiq, noLiq, spotLiq] = await Promise.all([
        yesPool.globalState(), noPool.globalState(), spotPool.globalState(),
        yesPool.liquidity(), noPool.liquidity(), spotPool.liquidity(),
    ]);

    const fmt = (v) => parseFloat(ethers.formatEther(v));

    // Display pool states
    console.log("POOL STATES:");
    console.log(`  YES: sqrtPriceX96=${yesGs[0]}, tick=${yesGs[1]}, fee=${yesGs[2]}, liq=${yesLiq}`);
    console.log(`  NO:  sqrtPriceX96=${noGs[0]}, tick=${noGs[1]}, fee=${noGs[2]}, liq=${noLiq}`);
    console.log(`  SPOT: sqrtPriceX96=${spotGs[0]}, tick=${spotGs[1]}, fee=${spotGs[2]}, liq=${spotLiq}`);

    // Calculate mid prices
    const sqrtToPrice = (sqrtX96) => {
        const s = Number(sqrtX96) / (2**96);
        return s * s;
    };

    // YES/NO: token0=sDAI, token1=GNO. price = token0/token1 = sDAI/GNO = how much sDAI for 1 GNO
    // Wait actually sqrtPriceX96 encodes sqrt(token0/token1) (Algebra convention same as Uni V3)
    // price = (sqrtPriceX96/2^96)^2 = token0_amount / token1_amount (in raw units, same decimals here)
    const yesMidPrice = sqrtToPrice(yesGs[0]); // sDAI per GNO? or GNO per sDAI?
    const noMidPrice = sqrtToPrice(noGs[0]);

    // Actually in Uni V3: price = token1/token0 NOT token0/token1
    // sqrtPriceX96 = sqrt(price) * Q96 where price = token1/token0
    // For YES pool: token0=YES_sDAI, token1=YES_GNO
    // price = YES_GNO / YES_sDAI (how much GNO for 1 sDAI)
    // To get sDAI per GNO: invert

    // Let me just verify with tick
    // tick = floor(log(price) / log(1.0001)) where price = token1/token0
    // YES tick = -46548: price = 1.0001^(-46548) = tiny = GNO/sDAI
    // 1 sDAI = 0.00952 GNO, so 1 GNO = 105 sDAI ✓

    // So: sqrtPriceX96 encodes sqrt(token1/token0)
    // For YES: sqrt(GNO/sDAI). price_raw = (sqrtPriceX96/Q96)^2 = GNO/sDAI = 0.00952
    // sDAI per GNO = 1/0.00952 = 105

    const yesGnoPerSdai = sqrtToPrice(yesGs[0]); // GNO per sDAI (tiny number)
    const yesSdaiPerGno = 1 / yesGnoPerSdai;
    const noGnoPerSdai = sqrtToPrice(noGs[0]);
    const noSdaiPerGno = 1 / noGnoPerSdai;

    // SPOT: token0=GNO, token1=sDAI
    // price = token1/token0 = sDAI/GNO directly
    const spotSdaiPerGno = sqrtToPrice(spotGs[0]);

    console.log(`\nMID PRICES (sDAI per GNO):`);
    console.log(`  YES:  ${yesSdaiPerGno.toFixed(4)}`);
    console.log(`  NO:   ${noSdaiPerGno.toFixed(4)}`);
    console.log(`  SPOT: ${spotSdaiPerGno.toFixed(4)}`);
    console.log(`  Divergence YES vs SPOT: ${((yesSdaiPerGno / spotSdaiPerGno - 1) * 100).toFixed(2)}%`);

    // Step 1: Split
    console.log("\n=== STEP 1: Split 0.01 GNO ===");
    console.log(`  0.01 GNO → 0.01 YES_GNO + 0.01 NO_GNO (free, 1:1)`);

    // Step 2: Sell 0.01 YES_GNO → YES_sDAI
    // YES pool: token0=YES_sDAI, token1=YES_GNO. We are selling token1 (GNO).
    console.log("\n=== STEP 2: Sell 0.01 YES_GNO → YES_sDAI (YES pool) ===");
    const yesSwap = computeSwapOutput(yesGs[0], yesLiq, amountWei, Number(yesGs[2]), true);
    console.log(`  Fee raw value: ${yesGs[2]}`);
    console.log(`  Fee interpretation: ${Number(yesGs[2])} / 1,000,000 = ${(Number(yesGs[2]) / 10000).toFixed(4)}%`);
    console.log(`  Fee amount: ${fmt(yesSwap.feeAmount)} GNO`);
    console.log(`  Amount after fee: ${fmt(amountWei - yesSwap.feeAmount)} GNO`);
    console.log(`  Output: ${fmt(yesSwap.amountOut)} YES_sDAI`);
    console.log(`  Effective rate: ${(fmt(yesSwap.amountOut) / 0.01).toFixed(4)} sDAI/GNO`);
    console.log(`  Price impact: ${((1 - fmt(yesSwap.amountOut) / (0.01 * yesSdaiPerGno)) * 100).toFixed(4)}%`);

    // Step 3: Sell 0.01 NO_GNO → NO_sDAI
    console.log("\n=== STEP 3: Sell 0.01 NO_GNO → NO_sDAI (NO pool) ===");
    const noSwap = computeSwapOutput(noGs[0], noLiq, amountWei, Number(noGs[2]), true);
    console.log(`  Fee amount: ${fmt(noSwap.feeAmount)} GNO`);
    console.log(`  Amount after fee: ${fmt(amountWei - noSwap.feeAmount)} GNO`);
    console.log(`  Output: ${fmt(noSwap.amountOut)} NO_sDAI`);
    console.log(`  Effective rate: ${(fmt(noSwap.amountOut) / 0.01).toFixed(4)} sDAI/GNO`);
    console.log(`  Price impact: ${((1 - fmt(noSwap.amountOut) / (0.01 * noSdaiPerGno)) * 100).toFixed(4)}%`);

    // Step 4: Merge
    console.log("\n=== STEP 4: Merge → sDAI ===");
    const yesSdaiVal = fmt(yesSwap.amountOut);
    const noSdaiVal = fmt(noSwap.amountOut);
    const mergeAmount = Math.min(yesSdaiVal, noSdaiVal);
    console.log(`  YES_sDAI: ${yesSdaiVal.toFixed(8)}`);
    console.log(`  NO_sDAI:  ${noSdaiVal.toFixed(8)}`);
    console.log(`  Merged:   ${mergeAmount.toFixed(8)} sDAI`);
    console.log(`  Wasted:   ${Math.abs(yesSdaiVal - noSdaiVal).toFixed(8)}`);

    // Step 5: sDAI → GNO
    // 5a: Direct Swapr (SPOT pool)
    console.log("\n=== STEP 5a: sDAI → GNO via Swapr direct (SPOT pool) ===");
    const mergeWei = ethers.parseEther(mergeAmount.toFixed(18));
    // SPOT: token0=GNO, token1=sDAI. Selling token1 (sDAI) for token0 (GNO).
    // Wait: selling sDAI (token1) increases price... no.
    // Actually selling token1 means we're buying token0.
    // When you sell token1: sqrtPrice goes UP (more token1 per token0)
    // But we want token0 (GNO) out.
    // Selling token1 = true
    const spotSwap = computeSwapOutput(spotGs[0], spotLiq, mergeWei, Number(spotGs[2]), true);
    console.log(`  Fee: ${spotGs[2]} → ${(Number(spotGs[2]) / 10000).toFixed(4)}%`);
    console.log(`  Fee amount: ${fmt(spotSwap.feeAmount)} sDAI`);
    console.log(`  Output: ${fmt(spotSwap.amountOut)} GNO`);
    console.log(`  Effective rate: ${(mergeAmount / fmt(spotSwap.amountOut)).toFixed(4)} sDAI/GNO`);

    // 5b: Balancer V2 3-hop
    console.log("\n=== STEP 5b: sDAI → GNO via Balancer V2 (sDAI→USDC→WXDAI→GNO) ===");
    const balancer = new ethers.Contract(BALANCER_V2, BALANCER_V2_ABI, signer);
    let gnoOutBalancer;
    try {
        const swaps = [
            { poolId: "0x7644fa5d0ea14fcf3e813fdf93ca9544f8567655000000000000000000000066", assetInIndex: 0, assetOutIndex: 1, amount: mergeWei, userData: "0x" },
            { poolId: "0x2086f52651837600180de173b09470f54ef7491000000000000000000000004f", assetInIndex: 1, assetOutIndex: 2, amount: 0, userData: "0x" },
            { poolId: "0x8189c4c96826d016a99986394103dfa9ae41e7ee0002000000000000000000aa", assetInIndex: 2, assetOutIndex: 3, amount: 0, userData: "0x" },
        ];
        const assets = [SDAI, USDC, WXDAI, GNO];
        const funds = { sender: signer.address, fromInternalBalance: false, recipient: signer.address, toInternalBalance: false };
        const deltas = await balancer.queryBatchSwap.staticCall(0, swaps, assets, funds);
        gnoOutBalancer = -parseFloat(ethers.formatEther(deltas[3]));
        console.log(`  GNO out: ${gnoOutBalancer.toFixed(8)}`);
        console.log(`  Effective rate: ${(mergeAmount / gnoOutBalancer).toFixed(4)} sDAI/GNO`);
    } catch(e) {
        console.log(`  FAILED: ${e.message.slice(0,200)}`);
    }

    // Summary
    console.log("\n==========================================");
    console.log("FINAL P&L COMPARISON");
    console.log("==========================================");
    const gnoViaSwapr = fmt(spotSwap.amountOut);
    console.log(`  Via Swapr direct:   ${gnoViaSwapr.toFixed(8)} GNO → P&L: ${((gnoViaSwapr - 0.01) / 0.01 * 100).toFixed(4)}%`);
    if (gnoOutBalancer) {
        console.log(`  Via Balancer 3-hop: ${gnoOutBalancer.toFixed(8)} GNO → P&L: ${((gnoOutBalancer - 0.01) / 0.01 * 100).toFixed(4)}%`);
    }

    console.log("\nFEE BREAKDOWN:");
    console.log(`  Conditional pool fee (${yesGs[2]}/1e6 = ${(Number(yesGs[2])/10000).toFixed(4)}%) × 2 pools (parallel):`);
    console.log(`    YES fee: ${fmt(yesSwap.feeAmount)} GNO (${(fmt(yesSwap.feeAmount) / 0.01 * 100).toFixed(4)}% of input)`);
    console.log(`    NO fee:  ${fmt(noSwap.feeAmount)} GNO (${(fmt(noSwap.feeAmount) / 0.01 * 100).toFixed(4)}% of input)`);
    console.log(`  Spot swap fee (${spotGs[2]}/1e6 = ${(Number(spotGs[2])/10000).toFixed(4)}%):`);
    console.log(`    Spot fee: ${fmt(spotSwap.feeAmount)} sDAI`);
    console.log(`  Price impact on conditional pools: ${((1 - yesSdaiVal / (0.01 * yesSdaiPerGno * (1 - Number(yesGs[2])/1e6))) * 100).toFixed(4)}%`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
