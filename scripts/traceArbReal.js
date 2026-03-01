/**
 * Trace SPOT_SPLIT arb using REAL router staticCall quotes.
 * Usage: npx hardhat run scripts/traceArbReal.js --network gnosis
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

const SWAPR_ROUTER = "0xfFB643E73f280B97809A8b41f7232AB401a04ee1";
const BALANCER_V2 = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";

const USDC = "0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83";
const WXDAI = "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d";

const POOL_ABI = [
    "function globalState() view returns (uint160 price, int24 tick, uint16 fee, uint16 timepointIndex, uint8 communityFeeToken0, uint8 communityFeeToken1, bool unlocked)",
    "function liquidity() view returns (uint128)",
];

const ROUTER_ABI = [
    "function exactInputSingle((address tokenIn, address tokenOut, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 limitSqrtPrice)) external payable returns (uint256 amountOut)",
];

const BALANCER_V2_ABI = [
    "function queryBatchSwap(uint8 kind, (bytes32 poolId, uint256 assetInIndex, uint256 assetOutIndex, uint256 amount, bytes userData)[] swaps, address[] assets, (address sender, bool fromInternalBalance, address recipient, bool toInternalBalance) funds) external returns (int256[] memory)",
];

async function quoteSwap(router, tokenIn, tokenOut, amountIn, signer) {
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const result = await router.exactInputSingle.staticCall({
        tokenIn,
        tokenOut,
        recipient: signer.address,
        deadline,
        amountIn,
        amountOutMinimum: 0,
        limitSqrtPrice: 0,
    }, { from: signer.address });
    return result;
}

async function main() {
    const [signer] = await ethers.getSigners();
    const amount = ethers.parseEther("0.01");
    const router = new ethers.Contract(SWAPR_ROUTER, ROUTER_ABI, signer);

    console.log("=== SPOT_SPLIT ARB TRACE: 0.01 GNO ===");
    console.log(`Signer: ${signer.address}\n`);

    // Prices
    const yesPool = new ethers.Contract(YES_POOL, POOL_ABI, signer);
    const noPool = new ethers.Contract(NO_POOL, POOL_ABI, signer);
    const spotPool = new ethers.Contract(SPOT_POOL, POOL_ABI, signer);

    const [yesGs, noGs, spotGs] = await Promise.all([
        yesPool.globalState(), noPool.globalState(), spotPool.globalState(),
    ]);

    // Spot pool: token0=GNO, token1=sDAI → 1.0001^tick = sDAI/GNO
    const spotPrice = Math.pow(1.0001, Number(spotGs[1]));
    // YES/NO pool: token0=sDAI, token1=GNO → 1.0001^tick = GNO/sDAI, invert for sDAI/GNO
    const yesPrice = 1 / Math.pow(1.0001, Number(yesGs[1]));
    const noPrice = 1 / Math.pow(1.0001, Number(noGs[1]));

    console.log("PRICES (sDAI per GNO):");
    console.log(`  Spot:       ${spotPrice.toFixed(4)} (fee=${spotGs[2]}, tick=${spotGs[1]})`);
    console.log(`  YES cond:   ${yesPrice.toFixed(4)} (fee=${yesGs[2]}, tick=${yesGs[1]})`);
    console.log(`  NO cond:    ${noPrice.toFixed(4)} (fee=${noGs[2]}, tick=${noGs[1]})`);
    console.log(`  Divergence: ${((yesPrice / spotPrice - 1) * 100).toFixed(2)}%`);

    // Step 1: Split
    console.log("\n--- STEP 1: Split 0.01 GNO → 0.01 YES_GNO + 0.01 NO_GNO (free) ---");

    // Step 2: Sell YES_GNO → YES_sDAI via Swapr router
    console.log("\n--- STEP 2: Sell 0.01 YES_GNO → YES_sDAI ---");
    let yesSdaiOut;
    try {
        yesSdaiOut = await quoteSwap(router, YES_GNO, YES_SDAI, amount, signer);
        const rate = parseFloat(ethers.formatEther(yesSdaiOut)) / 0.01;
        const feePct = (1 - rate / yesPrice) * 100;
        console.log(`  Output: ${ethers.formatEther(yesSdaiOut)} YES_sDAI`);
        console.log(`  Effective rate: ${rate.toFixed(4)} sDAI/GNO`);
        console.log(`  vs mid price ${yesPrice.toFixed(4)}: lost ${feePct.toFixed(4)}% (fee + impact)`);
    } catch(e) {
        console.log(`  FAILED: ${e.message.slice(0,200)}`);
        return;
    }

    // Step 3: Sell NO_GNO → NO_sDAI
    console.log("\n--- STEP 3: Sell 0.01 NO_GNO → NO_sDAI ---");
    let noSdaiOut;
    try {
        noSdaiOut = await quoteSwap(router, NO_GNO, NO_SDAI, amount, signer);
        const rate = parseFloat(ethers.formatEther(noSdaiOut)) / 0.01;
        const feePct = (1 - rate / noPrice) * 100;
        console.log(`  Output: ${ethers.formatEther(noSdaiOut)} NO_sDAI`);
        console.log(`  Effective rate: ${rate.toFixed(4)} sDAI/GNO`);
        console.log(`  vs mid price ${noPrice.toFixed(4)}: lost ${feePct.toFixed(4)}% (fee + impact)`);
    } catch(e) {
        console.log(`  FAILED: ${e.message.slice(0,200)}`);
        return;
    }

    // Step 4: Merge
    console.log("\n--- STEP 4: Merge min(YES_sDAI, NO_sDAI) → sDAI ---");
    const yesSdaiVal = parseFloat(ethers.formatEther(yesSdaiOut));
    const noSdaiVal = parseFloat(ethers.formatEther(noSdaiOut));
    const mergeAmount = Math.min(yesSdaiVal, noSdaiVal);
    console.log(`  YES_sDAI: ${yesSdaiVal.toFixed(8)}`);
    console.log(`  NO_sDAI:  ${noSdaiVal.toFixed(8)}`);
    console.log(`  Merged:   ${mergeAmount.toFixed(8)} sDAI`);
    console.log(`  Leftover: ${Math.abs(yesSdaiVal - noSdaiVal).toFixed(8)} (wasted)`);

    // Step 5a: Direct Swapr sDAI → GNO
    console.log("\n--- STEP 5a: sDAI → GNO via Swapr direct ---");
    const mergeWei = ethers.parseEther(mergeAmount.toFixed(18));
    let gnoOutDirect;
    try {
        gnoOutDirect = await quoteSwap(router, SDAI, GNO, mergeWei, signer);
        const directRate = mergeAmount / parseFloat(ethers.formatEther(gnoOutDirect));
        const feePct = (1 - parseFloat(ethers.formatEther(gnoOutDirect)) / (mergeAmount / spotPrice)) * 100;
        console.log(`  Output: ${ethers.formatEther(gnoOutDirect)} GNO`);
        console.log(`  Effective rate: ${directRate.toFixed(4)} sDAI/GNO`);
        console.log(`  vs spot ${spotPrice.toFixed(4)}: lost ${feePct.toFixed(4)}% (fee + impact)`);
    } catch(e) {
        console.log(`  FAILED: ${e.message.slice(0,200)}`);
    }

    // Step 5b: Balancer V2 3-hop
    console.log("\n--- STEP 5b: sDAI → GNO via Balancer V2 (sDAI→USDC→WXDAI→GNO) ---");
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
        const balRate = mergeAmount / gnoOutBalancer;
        const feePct = (1 - gnoOutBalancer / (mergeAmount / spotPrice)) * 100;
        console.log(`  sDAI in:  ${parseFloat(ethers.formatEther(deltas[0])).toFixed(8)}`);
        console.log(`  USDC mid: ${parseFloat(ethers.formatUnits(deltas[1], 6)).toFixed(6)}`);
        console.log(`  WXDAI mid: ${parseFloat(ethers.formatEther(deltas[2])).toFixed(6)}`);
        console.log(`  GNO out:  ${gnoOutBalancer.toFixed(8)}`);
        console.log(`  Effective rate: ${balRate.toFixed(4)} sDAI/GNO`);
        console.log(`  vs spot ${spotPrice.toFixed(4)}: lost ${feePct.toFixed(4)}% (fee + impact)`);
    } catch(e) {
        console.log(`  FAILED: ${e.message.slice(0,200)}`);
    }

    // Final summary
    console.log("\n========== FINAL SUMMARY ==========");
    const gnoFinal = gnoOutDirect ? parseFloat(ethers.formatEther(gnoOutDirect)) : gnoOutBalancer;
    const route = gnoOutDirect ? "Swapr direct" : "Balancer 3-hop";
    const pnl = gnoFinal - 0.01;
    console.log(`  Route: Split → Conditional pools → Merge → ${route}`);
    console.log(`  Started:  0.01000000 GNO`);
    console.log(`  Got back: ${gnoFinal.toFixed(8)} GNO`);
    console.log(`  P&L:      ${pnl >= 0 ? '+' : ''}${pnl.toFixed(8)} GNO (${((pnl / 0.01) * 100).toFixed(4)}%)`);
    console.log(`  ${pnl > 0 ? '✅ PROFITABLE' : '❌ NOT PROFITABLE'}`);

    // Compare routes
    if (gnoOutDirect && gnoOutBalancer) {
        const directVal = parseFloat(ethers.formatEther(gnoOutDirect));
        console.log(`\n  Swapr direct:   ${directVal.toFixed(8)} GNO`);
        console.log(`  Balancer 3-hop: ${gnoOutBalancer.toFixed(8)} GNO`);
        console.log(`  Better route: ${directVal > gnoOutBalancer ? 'Swapr direct' : 'Balancer 3-hop'} (+${Math.abs(directVal - gnoOutBalancer).toFixed(8)} GNO)`);
    }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
