/**
 * Automated Arbitrage Bot — GIP-149 (Gnosis)
 *
 * Liquidity-aware: reads pool depth and sizes trades accordingly.
 * Scans from tiny to optimal size, stops when price impact kills profit.
 *
 * Usage: CONFIRM=true npx hardhat run scripts/arb-bot-gnosis-new.js --network gnosis
 */

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
    contractAddress: "0x0ECD7369cFe4CD2f35b47B3c66e32AaC2016B25a",  // V4 PERMISSIONLESS
    proposalAddress: "0x47c80f5f701ebc5f25cab64e660f0577890729c2",  // GIP-149

    tokens: {
        GNO: "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb",
        SDAI: "0xaf204776c7245bF4147c2612BF6e5972Ee483701"
    },

    // Pool addresses (for reading liquidity)
    yesPool: "0x5Ce6E5Bb8866B30ffbA342A9D988788A4011182F",
    noPool: "0xd78Ea40dC62E763a41dBDAC744005192b57412E6",
    spotPool: "0x80086B6A53249277961c8672F0C22B3f54AC85FB",

    scanIntervalMs: 15000,

    // Profit Thresholds (in native token units)
    minNetProfitGno: "0.000005",
    minNetProfitSdai: "0.0005",

    // Trade sizing: fractions of pool GNO-side depth to test
    // Starts tiny, increases until price impact kills profit
    depthFractions: [0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2],

    estimatedGasLimit: 3500000,
    logFile: path.join(__dirname, "../logs/arbitrage-bot-gnosis-new.json")
};

const POOL_ABI = [
    "function globalState() view returns (uint160 price, int24 tick, uint16 fee, uint16 timepointIndex, uint8 communityFeeToken0, uint8 communityFeeToken1, bool unlocked)",
    "function liquidity() view returns (uint128)",
];

let sessionTotalProfit = 0;

// ═══════════════════════════════════════════════════════════════════════════
// POOL DEPTH CALCULATION
// ═══════════════════════════════════════════════════════════════════════════

function getPoolDepth(sqrtPriceX96, liquidity) {
    // For a full-range position, compute token amounts at current price
    // token0 (sDAI) amount ≈ L / sqrtP (in wei)
    // token1 (GNO) amount ≈ L * sqrtP / Q96 (simplified)
    const Q96 = 2n ** 96n;
    const sqrtP = Number(sqrtPriceX96) / Number(Q96);
    const L = Number(liquidity);

    const token0Amount = L / sqrtP / 1e18;          // sDAI side
    const token1Amount = L * sqrtP / 1e18;           // GNO side
    const price = 1 / (sqrtP * sqrtP);               // sDAI per GNO

    return { token0Amount, token1Amount, price, sqrtP };
}

function generateTestAmounts(gnoDepth, sdaiDepth, fractions) {
    const gnoAmounts = [];
    const sdaiAmounts = [];

    for (const f of fractions) {
        const gno = gnoDepth * f;
        const sdai = sdaiDepth * f;
        // Round to reasonable precision
        if (gno >= 0.000001) gnoAmounts.push(gno.toFixed(8));
        if (sdai >= 0.0001) sdaiAmounts.push(sdai.toFixed(6));
    }

    return { gnoAmounts, sdaiAmounts };
}

// ═══════════════════════════════════════════════════════════════════════════
// BOT LOGIC
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
    console.log("\n ARBITRAGE BOT STARTED (liquidity-aware)");
    console.log("=".repeat(60));

    const [signer] = await ethers.getSigners();
    const contract = await ethers.getContractAt("GnosisFlashArbitrageV4", CONFIG.contractAddress, signer);

    const logsDir = path.dirname(CONFIG.logFile);
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
    }

    console.log(`Signer: ${signer.address}`);
    console.log(`Interval: ${CONFIG.scanIntervalMs / 1000}s`);
    console.log(`Log: ${CONFIG.logFile}`);

    while (true) {
        try {
            await runScanCycle(contract, signer);
        } catch (error) {
            console.error("\n Error in scan cycle:", error.message);
        }

        await new Promise(resolve => setTimeout(resolve, CONFIG.scanIntervalMs));
    }
}

async function runScanCycle(contract, signer) {
    const timestamp = new Date().toISOString();
    console.log(`\n--- SCAN: ${timestamp} ---`);

    // 1. Read pool states
    const yesPool = new ethers.Contract(CONFIG.yesPool, POOL_ABI, signer);
    const noPool = new ethers.Contract(CONFIG.noPool, POOL_ABI, signer);
    const spotPool = new ethers.Contract(CONFIG.spotPool, POOL_ABI, signer);

    const [yesGs, noGs, spotGs, yesLiq, noLiq] = await Promise.all([
        yesPool.globalState(),
        noPool.globalState(),
        spotPool.globalState(),
        yesPool.liquidity(),
        noPool.liquidity(),
    ]);

    // Use the smaller pool's liquidity (bottleneck)
    const minLiq = yesLiq < noLiq ? yesLiq : noLiq;
    const minSqrtPrice = yesLiq < noLiq ? yesGs[0] : noGs[0];

    const depth = getPoolDepth(minSqrtPrice, minLiq);

    // Prices: YES/NO pool token0=sDAI, token1=GNO → sqrtP^2 = GNO/sDAI → invert
    const yesSdaiPerGno = 1 / (Number(yesGs[0]) / Number(2n ** 96n)) ** 2;
    const noSdaiPerGno = 1 / (Number(noGs[0]) / Number(2n ** 96n)) ** 2;
    // Spot pool: token0=GNO, token1=sDAI → sqrtP^2 = sDAI/GNO directly
    const spotSdaiPerGno = (Number(spotGs[0]) / Number(2n ** 96n)) ** 2;

    const divergence = (yesSdaiPerGno / spotSdaiPerGno - 1) * 100;

    const gasPrice = await ethers.provider.getFeeData();
    const gasPriceGwei = ethers.formatUnits(gasPrice.gasPrice, "gwei");

    console.log(`  Gas: ${parseFloat(gasPriceGwei).toFixed(2)} Gwei`);
    console.log(`  Prices: YES=${yesSdaiPerGno.toFixed(2)} NO=${noSdaiPerGno.toFixed(2)} SPOT=${spotSdaiPerGno.toFixed(2)} sDAI/GNO`);
    console.log(`  Divergence: ${divergence >= 0 ? '+' : ''}${divergence.toFixed(2)}%`);
    console.log(`  Pool depth: ${depth.token1Amount.toFixed(4)} GNO + ${depth.token0Amount.toFixed(2)} sDAI ($${((depth.token0Amount + depth.token1Amount * spotSdaiPerGno) * 1.228).toFixed(0)})`);

    // 2. Generate liquidity-aware test amounts
    const { gnoAmounts, sdaiAmounts } = generateTestAmounts(
        depth.token1Amount, depth.token0Amount, CONFIG.depthFractions
    );

    console.log(`  Test sizes (GNO): [${gnoAmounts.map(a => parseFloat(a).toFixed(6)).join(', ')}]`);

    // 3. Test SPOT_SPLIT (profitable when conditional > spot)
    let bestArb = null;
    if (divergence > 0.1) {
        console.log(`  SPOT_SPLIT (cond > spot by ${divergence.toFixed(2)}%):`);
        for (let i = 0; i < gnoAmounts.length; i++) {
            const amt = gnoAmounts[i];
            const arb = await simulateArbitrage(contract, CONFIG.tokens.GNO, amt, 0);
            if (arb && arb.success) {
                const netProfit = calculateNetProfit(arb.profit, gasPrice.gasPrice, spotSdaiPerGno);
                const pctReturn = (arb.profit / parseFloat(amt) * 100).toFixed(3);
                console.log(`    ${amt} GNO: profit=${arb.profit.toFixed(8)} (${pctReturn}%), net=${netProfit.toFixed(8)}`);
                if (!bestArb || netProfit > bestArb.netProfit) {
                    bestArb = { ...arb, netProfit, strategy: "SPOT_SPLIT", borrowToken: "GNO", profitUnit: "GNO" };
                }
            } else if (arb && arb.error) {
                console.log(`    ${amt} GNO: ${arb.error}`);
                if (arb.error === "reverted" && i > 0) break; // Bigger will also fail
            }
        }
    } else {
        console.log(`  SPOT_SPLIT: skipped (divergence ${divergence.toFixed(2)}% too low)`);
    }

    // 4. Test MERGE_SPOT (profitable when spot > conditional)
    let bestSdaiArb = null;
    if (divergence < -0.1) {
        console.log(`  MERGE_SPOT (spot > cond by ${(-divergence).toFixed(2)}%):`);
        for (let i = 0; i < sdaiAmounts.length; i++) {
            const amt = sdaiAmounts[i];
            const arb = await simulateArbitrage(contract, CONFIG.tokens.SDAI, amt, 1);
            if (arb && arb.success) {
                const gasCostSdai = calculateGasCostInSdai(gasPrice.gasPrice, spotSdaiPerGno);
                const netProfitSdai = arb.profit - gasCostSdai;
                const pctReturn = (arb.profit / parseFloat(amt) * 100).toFixed(3);
                console.log(`    ${amt} sDAI: profit=${arb.profit.toFixed(6)} (${pctReturn}%), net=${netProfitSdai.toFixed(6)}`);
                if (!bestSdaiArb || netProfitSdai > bestSdaiArb.netProfitSdai) {
                    bestSdaiArb = { ...arb, netProfitSdai, strategy: "MERGE_SPOT", borrowToken: "SDAI", profitUnit: "sDAI" };
                }
            } else if (arb && arb.error) {
                console.log(`    ${amt} sDAI: ${arb.error}`);
                if (arb.error === "reverted" && i > 0) break;
            }
        }
    } else {
        console.log(`  MERGE_SPOT: skipped (divergence ${divergence.toFixed(2)}% wrong direction)`);
    }

    // 5. Execute best
    const executeGno = bestArb && bestArb.netProfit > parseFloat(CONFIG.minNetProfitGno);
    const executeSdai = bestSdaiArb && bestSdaiArb.netProfitSdai > parseFloat(CONFIG.minNetProfitSdai);

    if (executeGno || executeSdai) {
        const sdaiValueInGno = executeSdai ? bestSdaiArb.netProfitSdai / spotSdaiPerGno : 0;
        const gnoValue = executeGno ? bestArb.netProfit : 0;
        const selected = gnoValue >= sdaiValueInGno ? bestArb : bestSdaiArb;
        const unit = gnoValue >= sdaiValueInGno ? "GNO" : "sDAI";
        const netVal = gnoValue >= sdaiValueInGno ? bestArb.netProfit : bestSdaiArb.netProfitSdai;

        console.log(`  >> EXECUTE: ${selected.strategy} ${selected.amount} ${selected.borrowToken} → net ${netVal.toFixed(8)} ${unit}`);

        if (process.env.CONFIRM === "true") {
            await executeTrade(contract, selected);
        } else {
            console.log("  >> DRY RUN (set CONFIRM=true)");
        }
    } else {
        console.log(`  >> No profitable opportunity (need more liquidity or divergence)`);
    }

    console.log(`  Session total: ${sessionTotalProfit.toFixed(6)} GNO`);

    logEvent({
        type: "scan",
        timestamp,
        gasPrice: gasPriceGwei,
        divergence: divergence.toFixed(2),
        poolDepthGno: depth.token1Amount.toFixed(4),
        poolDepthSdai: depth.token0Amount.toFixed(2),
        bestOpportunity: bestArb ? {
            strategy: bestArb.strategy,
            amount: bestArb.amount,
            profit: bestArb.profit,
            netProfit: bestArb.netProfit
        } : null
    });
}

async function simulateArbitrage(contract, token, amountStr, direction) {
    const amount = ethers.parseEther(amountStr);
    try {
        const result = await contract.executeArbitrage.staticCall(
            CONFIG.proposalAddress,
            token,
            amount,
            direction,
            0
        );
        return {
            success: true,
            amount: amountStr,
            profit: parseFloat(ethers.formatEther(result.profit))
        };
    } catch (e) {
        const errorMsg = e.message?.includes("reverted") ? "reverted" :
            e.message?.includes("BAD_DATA") ? "BAD_DATA" :
                e.message?.slice(0, 30) || "unknown";
        return { success: false, error: errorMsg };
    }
}

function calculateNetProfit(grossProfitGno, gasPriceWei, gnoPriceSdai) {
    // Gnosis chain: gas is paid in xDAI (native token), ~1 USD
    // gnoPriceSdai ≈ sDAI/GNO ≈ USD/GNO
    const gasCostWei = gasPriceWei * BigInt(CONFIG.estimatedGasLimit);
    const gasCostXdai = parseFloat(ethers.formatEther(gasCostWei));  // xDAI ≈ $1
    const gasCostGno = gasCostXdai / gnoPriceSdai;                   // convert to GNO
    return grossProfitGno - gasCostGno;
}

function calculateGasCostInSdai(gasPriceWei, gnoPriceSdai) {
    // Gnosis chain: gas in xDAI ≈ sDAI ≈ $1
    const gasCostWei = gasPriceWei * BigInt(CONFIG.estimatedGasLimit);
    const gasCostSdai = parseFloat(ethers.formatEther(gasCostWei));   // xDAI ≈ sDAI
    return gasCostSdai;
}

async function executeTrade(contract, arb) {
    console.log("  >> EXECUTING TRADE...");
    try {
        const tx = await contract.executeArbitrage(
            CONFIG.proposalAddress,
            arb.borrowToken === "GNO" ? CONFIG.tokens.GNO : CONFIG.tokens.SDAI,
            ethers.parseEther(arb.amount),
            arb.strategy === "SPOT_SPLIT" ? 0 : 1,
            0,
            { gasLimit: CONFIG.estimatedGasLimit }
        );

        console.log(`  TX: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`  Status: ${receipt.status === 1 ? "SUCCESS" : "FAIL"}`);

        if (receipt.status === 1) {
            sessionTotalProfit += arb.profit;
        }

        logEvent({
            type: "trade",
            timestamp: new Date().toISOString(),
            txHash: tx.hash,
            status: receipt.status === 1 ? "success" : "failed",
            profit: arb.profit,
            gasUsed: receipt.gasUsed.toString(),
            strategy: arb.strategy,
            amount: arb.amount,
            sessionTotal: sessionTotalProfit
        });
    } catch (error) {
        console.error("  Execution Error:", error.message.slice(0, 200));
    }
}

function logEvent(event) {
    const data = JSON.stringify(event) + "\n";
    fs.appendFileSync(CONFIG.logFile, data);
}

main().then(() => process.exit(0)).catch(console.error);
