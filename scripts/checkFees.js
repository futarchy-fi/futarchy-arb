/**
 * Check fee configurations on all relevant pools.
 * Usage: npx hardhat run scripts/checkFees.js --network gnosis
 */
const { ethers } = require("hardhat");

const YES_POOL = "0x1E3174Fc4A1F5bDc995aCb38B83c9b9040f14b2D";
const NO_POOL = "0xdFCa9E6D1f557244cC4Ec5871e975C7E0632B4a2";
const DX_PAIR = "0x2613Cb099C12CECb1bd290Fd0eF6833949374165"; // PNK/WETH
const HONEY_PAIR = "0x7bea4af5d425f2d4485bdad1859c88617df31a67"; // WETH/WXDAI

const ALGEBRA_ABI = [
    "function globalState() view returns (uint160 price, int24 tick, uint16 fee, uint16 timepointIndex, uint8 communityFeeToken0, uint8 communityFeeToken1, bool unlocked)",
    "function token0() view returns (address)",
    "function token1() view returns (address)",
    "function liquidity() view returns (uint128)",
];

const PAIR_ABI = [
    "function swapFee() view returns (uint32)",
    "function token0() view returns (address)",
    "function token1() view returns (address)",
    "function getReserves() view returns (uint112, uint112, uint32)",
];

async function main() {
    console.log("=== Fee Report ===\n");

    // YES pool (Algebra)
    const yesPool = new ethers.Contract(YES_POOL, ALGEBRA_ABI, ethers.provider);
    const gsYes = await yesPool.globalState();
    const yesT0 = await yesPool.token0();
    const yesT1 = await yesPool.token1();
    const yesLiq = await yesPool.liquidity();
    console.log("YES Pool (Algebra concentrated liquidity):");
    console.log("  Address:", YES_POOL);
    console.log("  Fee:", gsYes[2].toString(), "basis points =", (Number(gsYes[2]) / 100).toFixed(2) + "%");
    console.log("  token0:", yesT0);
    console.log("  token1:", yesT1);
    console.log("  Liquidity:", yesLiq.toString());

    // NO pool (Algebra)
    const noPool = new ethers.Contract(NO_POOL, ALGEBRA_ABI, ethers.provider);
    const gsNo = await noPool.globalState();
    const noT0 = await noPool.token0();
    const noT1 = await noPool.token1();
    const noLiq = await noPool.liquidity();
    console.log("\nNO Pool (Algebra concentrated liquidity):");
    console.log("  Address:", NO_POOL);
    console.log("  Fee:", gsNo[2].toString(), "basis points =", (Number(gsNo[2]) / 100).toFixed(2) + "%");
    console.log("  token0:", noT0);
    console.log("  token1:", noT1);
    console.log("  Liquidity:", noLiq.toString());

    // DXswap PNK/WETH
    const dxPair = new ethers.Contract(DX_PAIR, PAIR_ABI, ethers.provider);
    const dxFee = await dxPair.swapFee();
    const dxT0 = await dxPair.token0();
    const dxT1 = await dxPair.token1();
    const [dxR0, dxR1] = await dxPair.getReserves();
    // DXswap: fee is in basis points where 10000 = 100%. Formula: amountIn * (10000 - fee) / 10000
    console.log("\nDXswap PNK/WETH (UniV2 fork):");
    console.log("  Address:", DX_PAIR);
    console.log("  swapFee:", dxFee.toString(), "=> fee =", (Number(dxFee) / 100).toFixed(2) + "%");
    console.log("  token0:", dxT0);
    console.log("  token1:", dxT1);
    console.log("  Reserves:", ethers.formatEther(dxR0), "/", ethers.formatEther(dxR1));

    // Honeyswap WETH/WXDAI
    const honeyPair = new ethers.Contract(HONEY_PAIR, PAIR_ABI, ethers.provider);
    const honeyFee = await honeyPair.swapFee();
    const honeyT0 = await honeyPair.token0();
    const honeyT1 = await honeyPair.token1();
    const [hR0, hR1] = await honeyPair.getReserves();
    console.log("\nHoneyswap WETH/WXDAI (UniV2 fork):");
    console.log("  Address:", HONEY_PAIR);
    console.log("  swapFee:", honeyFee.toString(), "=> fee =", (Number(honeyFee) / 100).toFixed(2) + "%");
    console.log("  token0:", honeyT0);
    console.log("  token1:", honeyT1);
    console.log("  Reserves:", ethers.formatEther(hR0), "/", ethers.formatEther(hR1));

    // Summary
    const yesFee = Number(gsYes[2]) / 100;
    const noFee = Number(gsNo[2]) / 100;
    const dxFeePct = Number(dxFee) / 100;
    const honeyFeePct = Number(honeyFee) / 100;

    console.log("\n=== Summary ===");
    console.log(`YES pool:      ${yesFee.toFixed(2)}%`);
    console.log(`NO pool:       ${noFee.toFixed(2)}%`);
    console.log(`DXswap:        ${dxFeePct.toFixed(2)}%`);
    console.log(`Honeyswap:     ${honeyFeePct.toFixed(2)}%`);
    console.log(`\nConditional→Spot arb (one-way): ${yesFee.toFixed(2)}% + ${dxFeePct.toFixed(2)}% + ${honeyFeePct.toFixed(2)}% = ${(yesFee + dxFeePct + honeyFeePct).toFixed(2)}%`);
    console.log(`Round-trip: ~${(2 * (yesFee + dxFeePct + honeyFeePct)).toFixed(2)}%`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
