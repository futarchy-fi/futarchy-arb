/**
 * Automated Arbitrage Bot for PNK/sDAI Futarchy Markets (KIP-86)
 *
 * Always borrows WETH from Balancer V3. Tests both SPOT_SPLIT and MERGE_SPOT.
 * Route: WETH ↔ PNK (DXswap) and WETH ↔ WXDAI (Honeyswap) ↔ sDAI (ERC4626).
 *
 * Usage: CONFIRM=true npx hardhat run scripts/arb-bot-pnk.js --network gnosis
 */

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
    // Contract address — update after deployment
    contractAddress: process.env.PNK_ARB_CONTRACT || "",
    proposalAddress: "0xb607bd7c7201e966e6a150cd6ef1d08db55cad5d",  // KIP-86

    // Token addresses (for reference)
    tokens: {
        WETH: "0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1",
    },

    // Scan settings
    scanIntervalMs: 15000,  // 15 seconds

    // Fallback/test amounts in WETH (used when liquidity-aware sizing fails)
    wethAmounts: ["0.0001", "0.0002", "0.0005", "0.001", "0.002", "0.005", "0.01", "0.05", "0.1", "0.2", "0.5"],

    // Minimum net profit in WETH to execute
    minNetProfitWeth: process.env.PNK_MIN_NET_PROFIT_WETH || "0",

    // Trade sizes as a fraction of observed pool depth (bottleneck side)
    depthFractions: [0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2],

    // Gas estimation
    estimatedGasLimit: 4000000,

    // Logging
    logFile: path.join(__dirname, "../logs/arb-bot-pnk.json"),
};

const EXPLORER_BY_CHAIN_ID = {
    100: "https://gnosisscan.io/tx/",
    10200: "https://gnosis-chiado.blockscout.com/tx/",
};


const POOL_ABI = [
    "function token0() view returns (address)",
    "function token1() view returns (address)",
    "function globalState() view returns (uint160 price, int24 tick, uint16 fee, uint16 timepointIndex, uint8 communityFeeToken0, uint8 communityFeeToken1, bool unlocked)",
    "function liquidity() view returns (uint128)",
];

const UNISWAP_PAIR_ABI = [
    "function token0() view returns (address)",
    "function token1() view returns (address)",
    "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
];

let sessionTotalProfit = 0;

// ═══════════════════════════════════════════════════════════════════════════
// BOT LOGIC
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
    if (!CONFIG.contractAddress) {
        // Try reading from last_deployment_pnk.txt
        const depFile = path.join(__dirname, "../last_deployment_pnk.txt");
        if (fs.existsSync(depFile)) {
            CONFIG.contractAddress = fs.readFileSync(depFile, "utf8").trim();
        } else {
            console.error("Set PNK_ARB_CONTRACT env var or deploy first (last_deployment_pnk.txt)");
            process.exit(1);
        }
    }

    console.log("\nPNK ARB BOT STARTED");
    console.log("=".repeat(60));

    const [signer] = await ethers.getSigners();
    const contract = await ethers.getContractAt("PNKFlashArbitrage", CONFIG.contractAddress, signer);

    const logsDir = path.dirname(CONFIG.logFile);
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

    console.log(`Signer:   ${signer.address}`);
    console.log(`Contract: ${CONFIG.contractAddress}`);
    console.log(`Proposal: ${CONFIG.proposalAddress}`);
    console.log(`Interval: ${CONFIG.scanIntervalMs / 1000}s`);
    console.log(`Log:      ${CONFIG.logFile}`);

    // Verify proposal loads correctly
    let proposalInfo = null;
    try {
        proposalInfo = await contract.loadProposal(CONFIG.proposalAddress);
        if (!proposalInfo.isValid) {
            console.error("Proposal is not valid for PNK/sDAI arbitrage");
            process.exit(1);
        }
        console.log(`\nProposal loaded:`);
        console.log(`  YES pool: ${proposalInfo.yesPool}`);
        console.log(`  NO pool:  ${proposalInfo.noPool}`);
        console.log(`  YES PNK: ${proposalInfo.yesPnk}`);
        console.log(`  NO  PNK: ${proposalInfo.noPnk}`);
        console.log(`  YES sDAI: ${proposalInfo.yesSdai}`);
        console.log(`  NO  sDAI: ${proposalInfo.noSdai}`);
    } catch (e) {
        console.error("Failed to load proposal:", e.message);
        process.exit(1);
    }

    const [pnkToken, sdaiToken] = await Promise.all([
        contract.pnkToken(),
        contract.sdaiToken(),
    ]);

    while (true) {
        try {
            await runScanCycle(contract, signer, proposalInfo, pnkToken, sdaiToken);
        } catch (error) {
            console.error("\nError in scan cycle:", error.message);
        }
        console.log(`\nWaiting ${CONFIG.scanIntervalMs / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, CONFIG.scanIntervalMs));
    }
}

function normalizeAddress(addr) {
    return addr.toLowerCase();
}

function amountFromPoolDepthAtPrice(sqrtPriceX96, liquidity) {
    // For a full-range position, compute token amounts at current price.
    // token0 (amount in reserve units) and token1 (amount in reserve units) as floats.
    const Q96 = 2n ** 96n;
    const sqrtP = Number(sqrtPriceX96) / Number(Q96);
    const L = Number(liquidity);

    const token0Amount = L / sqrtP / 1e18;
    const token1Amount = L * sqrtP / 1e18;

    return { token0Amount, token1Amount };
}

function poolDepthForToken(poolDepths, tokenInPool, targetToken) {
    const isPnk0 = normalizeAddress(tokenInPool.token0) === normalizeAddress(targetToken);
    return isPnk0 ? poolDepths.token0Amount : poolDepths.token1Amount;
}

function getMidPriceOutPerIn(reserve0, reserve1, token0, token1, tokenIn, tokenOut) {
    const t0 = normalizeAddress(token0);
    const t1 = normalizeAddress(token1);
    const tin = normalizeAddress(tokenIn);
    const tout = normalizeAddress(tokenOut);

    if (tin === t0 && tout === t1) {
        if (Number(reserve0) === 0) return null;
        return Number(reserve1) / Number(reserve0);
    }
    if (tin === t1 && tout === t0) {
        if (Number(reserve1) === 0) return null;
        return Number(reserve0) / Number(reserve1);
    }
    return null;
}

function buildWethTestSizes(maxBorrowWeth, fractions, minSize = 0.0001) {
    const out = [];
    if (!Number.isFinite(maxBorrowWeth) || maxBorrowWeth <= 0) return out;

    for (const f of fractions) {
        const amt = maxBorrowWeth * f;
        if (amt >= minSize) {
            out.push(amt.toFixed(6));
        }
    }

    // Deduplicate while preserving order
    return [...new Set(out)]
        .filter(a => parseFloat(a) > 0)
        .sort((a, b) => parseFloat(a) - parseFloat(b));
}

async function getTxExplorerUrl(txHash) {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const baseUrl = EXPLORER_BY_CHAIN_ID[chainId.toString()];

    if (baseUrl) {
        return `${baseUrl}${txHash}`;
    }

    return `chain:${chainId} tx:${txHash}`;
}

async function getLiquidityAwareAmounts(contract, signer, proposalInfo, tokenInfo) {
    // Read pool state and pair pricing to build liquidity-aware WETH sizes.
    const { yesPool, noPool, yesPnk, noPnk, yesSdai, noSdai } = proposalInfo;
    const { pnkToken, sdaiToken } = tokenInfo;

    const pairAddresses = await Promise.all([
        contract.dxswapPair(),
        contract.wethWxdaiPair(),
    ]);
    const dxswapPairAddr = pairAddresses[0];
    const wethWxdaiPairAddr = pairAddresses[1];

    const yesPoolContract = new ethers.Contract(yesPool, POOL_ABI, signer);
    const noPoolContract = new ethers.Contract(noPool, POOL_ABI, signer);
    const dxPair = new ethers.Contract(dxswapPairAddr, UNISWAP_PAIR_ABI, signer);
    const wxPair = new ethers.Contract(wethWxdaiPairAddr, UNISWAP_PAIR_ABI, signer);

    const [
        yesLiq,
        noLiq,
        yesState,
        noState,
        yesToken0,
        yesToken1,
        noToken0,
        noToken1,
        dxToken0,
        dxToken1,
        dxReserves,
        wxToken0,
        wxToken1,
        wxReserves,
    ] = await Promise.all([
        yesPoolContract.liquidity(),
        noPoolContract.liquidity(),
        yesPoolContract.globalState(),
        noPoolContract.globalState(),
        yesPoolContract.token0(),
        yesPoolContract.token1(),
        noPoolContract.token0(),
        noPoolContract.token1(),
        dxPair.token0(),
        dxPair.token1(),
        dxPair.getReserves(),
        wxPair.token0(),
        wxPair.token1(),
        wxPair.getReserves(),
    ]);

    const yesDepth = amountFromPoolDepthAtPrice(yesState[0], yesLiq);
    const noDepth = amountFromPoolDepthAtPrice(noState[0], noLiq);

    const yesPnkDepth = poolDepthForToken({
        token0Amount: yesDepth.token0Amount,
        token1Amount: yesDepth.token1Amount,
    }, { token0: yesToken0, token1: yesToken1 }, yesPnk);

    const noPnkDepth = poolDepthForToken({
        token0Amount: noDepth.token0Amount,
        token1Amount: noDepth.token1Amount,
    }, { token0: noToken0, token1: noToken1 }, noPnk);

    const yesSdaiDepth = poolDepthForToken({
        token0Amount: yesDepth.token0Amount,
        token1Amount: yesDepth.token1Amount,
    }, { token0: yesToken0, token1: yesToken1 }, yesSdai);

    const noSdaiDepth = poolDepthForToken({
        token0Amount: noDepth.token0Amount,
        token1Amount: noDepth.token1Amount,
    }, { token0: noToken0, token1: noToken1 }, noSdai);

    const pnkPerWeth = getMidPriceOutPerIn(
        dxReserves[0],
        dxReserves[1],
        dxToken0,
        dxToken1,
        CONFIG.tokens.WETH,
        pnkToken,
    );

    // sDAI route is via WXDAI (via ERC4626), assume sDAI:WXDAI == 1:1 in mint/redeem.
    const sdaiPerWeth = getMidPriceOutPerIn(
        wxReserves[0],
        wxReserves[1],
        wxToken0,
        wxToken1,
        CONFIG.tokens.WETH,
        sdaiToken,
    );

    const maxBorrowPnk = 2 * Math.min(yesPnkDepth, noPnkDepth);
    const maxBorrowSdai = 2 * Math.min(yesSdaiDepth, noSdaiDepth);

    const maxSpotBorrowWeth = pnkPerWeth > 0 ? maxBorrowPnk / pnkPerWeth : 0;
    const maxMergeBorrowWeth = sdaiPerWeth > 0 ? maxBorrowSdai / sdaiPerWeth : 0;

    const wethForSpot = buildWethTestSizes(maxSpotBorrowWeth, CONFIG.depthFractions, 0.00005);
    const wethForMerge = buildWethTestSizes(maxMergeBorrowWeth, CONFIG.depthFractions, 0.00005);

    return {
        wethForSpot,
        wethForMerge,
        fallback: (wethForSpot.length === 0 && wethForMerge.length === 0),
        profile: {
            yesPnkDepth,
            noPnkDepth,
            yesSdaiDepth,
            noSdaiDepth,
            pnkPerWeth,
            sdaiPerWeth,
            maxBorrowPnk,
            maxBorrowSdai,
            maxSpotBorrowWeth,
            maxMergeBorrowWeth,
        },
    };
}

async function runScanCycle(contract, signer, proposalInfo, pnkToken, sdaiToken) {
    const timestamp = new Date().toISOString();
    console.log(`\nSCAN: ${timestamp}`);

    const feeData = await ethers.provider.getFeeData();
    const gasPriceGwei = ethers.formatUnits(feeData.gasPrice, "gwei");
    console.log(`Gas: ${parseFloat(gasPriceGwei).toFixed(2)} Gwei`);

    let spotCandidates = [];
    let mergeCandidates = [];

    try {
        const sizing = await getLiquidityAwareAmounts(contract, signer, proposalInfo, { pnkToken, sdaiToken });

        spotCandidates = sizing.wethForSpot;
        mergeCandidates = sizing.wethForMerge;

        if (sizing.fallback) {
            console.log("  Liquidity-aware sizing failed; using fallback WETH grid");
            spotCandidates = CONFIG.wethAmounts;
            mergeCandidates = CONFIG.wethAmounts;
        } else {
            if (spotCandidates.length > 0) {
                console.log(`  SPOT_SPLIT candidates: [${spotCandidates.join(", ")}] WETH`);
            } else {
                console.log("  SPOT_SPLIT candidates: none (pool depth too low)");
            }
            if (mergeCandidates.length > 0) {
                console.log(`  MERGE_SPOT candidates: [${mergeCandidates.join(", ")}] WETH`);
            } else {
                console.log("  MERGE_SPOT candidates: none (pool depth too low)");
            }

            const p = sizing.profile;
            console.log(`  Pool depth PNK: YES=${p.yesPnkDepth.toFixed(6)} NO=${p.noPnkDepth.toFixed(6)}`);
            console.log(`  Pool depth sDAI: YES=${p.yesSdaiDepth.toFixed(6)} NO=${p.noSdaiDepth.toFixed(6)}`);
            console.log(`  Spot-rate approx: ${p.pnkPerWeth?.toFixed(4) || "n/a"} PNK/WETH, ${p.sdaiPerWeth?.toFixed(4) || "n/a"} sDAI/WETH`);
        }
    } catch (e) {
        console.log("  Liquidity read failed; using fallback WETH grid:", e.message?.slice(0, 120));
        spotCandidates = CONFIG.wethAmounts;
        mergeCandidates = CONFIG.wethAmounts;
    }

    if (spotCandidates.length === 0) spotCandidates = CONFIG.wethAmounts;
    if (mergeCandidates.length === 0) mergeCandidates = CONFIG.wethAmounts;

    let bestSpotSplit = null;
    let bestMergeSpot = null;

    // Test SPOT_SPLIT
    console.log("  Testing SPOT_SPLIT...");
    for (let i = 0; i < spotCandidates.length; i++) {
        const amt = spotCandidates[i];
        const arb = await simulateArbitrage(contract, amt, 0);
        if (arb && arb.success) {
            console.log(`    WETH ${amt}: profit=${arb.profit.toFixed(6)}`);
            if (!bestSpotSplit || arb.profit > bestSpotSplit.profit) {
                bestSpotSplit = { ...arb, strategy: "SPOT_SPLIT" };
            }
        } else if (arb && arb.error) {
            console.log(`    WETH ${amt}: ${arb.error}`);
            const skipped = spotCandidates.length - i - 1;
            if (skipped > 0) console.log(`    Skipping ${skipped} larger amounts`);
            break;
        } else {
            console.log(`    WETH ${amt}: no profit`);
        }
    }

    // Test MERGE_SPOT
    console.log("  Testing MERGE_SPOT...");
    for (let i = 0; i < mergeCandidates.length; i++) {
        const amt = mergeCandidates[i];
        const arb = await simulateArbitrage(contract, amt, 1);
        if (arb && arb.success) {
            console.log(`    WETH ${amt}: profit=${arb.profit.toFixed(6)}`);
            if (!bestMergeSpot || arb.profit > bestMergeSpot.profit) {
                bestMergeSpot = { ...arb, strategy: "MERGE_SPOT" };
            }
        } else if (arb && arb.error) {
            console.log(`    WETH ${amt}: ${arb.error}`);
            const skipped = mergeCandidates.length - i - 1;
            if (skipped > 0) console.log(`    Skipping ${skipped} larger amounts`);
            break;
        } else {
            console.log(`    WETH ${amt}: no profit`);
        }
    }

    // Determine best opportunity
    console.log("\n  SUMMARY:");
    const threshold = parseFloat(CONFIG.minNetProfitWeth);

    const candidates = [bestSpotSplit, bestMergeSpot].filter(a => a && a.profit > threshold);
    if (candidates.length === 0) {
        if (bestSpotSplit) console.log(`  SPOT_SPLIT best: ${bestSpotSplit.profit.toFixed(6)} WETH`);
        if (bestMergeSpot) console.log(`  MERGE_SPOT best: ${bestMergeSpot.profit.toFixed(6)} WETH`);
        console.log("  No opportunities above threshold");
        logEvent({ type: "scan", timestamp, gasPrice: gasPriceGwei, best: null });
        return;
    }

    // Pick highest profit
    candidates.sort((a, b) => b.profit - a.profit);
    const selected = candidates[0];

    console.log(`  TARGET: ${selected.strategy} ${selected.amount} WETH -> profit ${selected.profit.toFixed(6)} WETH`);
    console.log(`  CONFIRM mode: ${process.env.CONFIRM === "true" ? "ENABLED (LIVE)" : "DISABLED (DRY RUN)"}`);

    if (process.env.CONFIRM === "true") {
        console.log("  Sending selected trade on-chain...");
        await executeTrade(contract, selected);
    } else {
        console.log("  DRY RUN: Set CONFIRM=true to execute.");
    }

    console.log(`\nSESSION TOTAL: ${sessionTotalProfit.toFixed(6)} WETH`);
    logEvent({
        type: "scan",
        timestamp,
        gasPrice: gasPriceGwei,
        best: { strategy: selected.strategy, amount: selected.amount, profit: selected.profit },
    });
}

async function simulateArbitrage(contract, amountStr, direction) {
    const amount = ethers.parseEther(amountStr);
    try {
        const result = await contract.executeArbitrage.staticCall(
            CONFIG.proposalAddress,
            amount,
            direction,
            0  // minProfit = 0 for simulation
        );
        return {
            success: true,
            amount: amountStr,
            profit: parseFloat(ethers.formatEther(result.profit)),
        };
    } catch (e) {
        const errorMsg = e.message?.includes("reverted") ? "reverted"
            : e.message?.includes("BAD_DATA") ? "BAD_DATA"
            : e.message?.slice(0, 60) || "unknown";
        return { success: false, error: errorMsg };
    }
}

async function executeTrade(contract, arb) {
    console.log("\n  EXECUTING TRADE...");
    try {
        const direction = arb.strategy === "SPOT_SPLIT" ? 0 : 1;
        console.log(`  Strategy: ${arb.strategy}`);
        console.log(`  Amount: ${arb.amount} WETH`);
        console.log("  Submitting transaction...");
        const tx = await contract.executeArbitrage(
            CONFIG.proposalAddress,
            ethers.parseEther(arb.amount),
            direction,
            0,
            { gasLimit: CONFIG.estimatedGasLimit }
        );

        const explorerUrl = await getTxExplorerUrl(tx.hash);
        console.log(`  TX submitted: ${tx.hash}`);
        console.log(`  Explorer: ${explorerUrl}`);
        console.log("  Waiting for confirmation...");

        const receipt = await tx.wait();
        const status = receipt.status === 1 ? "SUCCESS" : "FAIL";
        const block = receipt.blockNumber ? receipt.blockNumber.toString() : "n/a";
        const latestBlock = await ethers.provider.getBlockNumber();
        const confirmations = receipt.blockNumber ? (Number(latestBlock) - Number(receipt.blockNumber) + 1) : "n/a";

        console.log(`  Confirmed: ${status}`);
        console.log(`  Block: ${block}`);
        console.log(`  Confirmations: ${confirmations}`);
        console.log(`  Gas used: ${receipt.gasUsed.toString()}`);
        if (receipt.effectiveGasPrice) {
            console.log(`  Effective gas price: ${ethers.formatUnits(receipt.effectiveGasPrice, "gwei")} gwei`);
        }

        if (receipt.status === 1) {
            sessionTotalProfit += arb.profit;
        }

        logEvent({
            type: "trade",
            timestamp: new Date().toISOString(),
            txHash: tx.hash,
            status: status.toLowerCase(),
            profit: arb.profit,
            gasUsed: receipt.gasUsed.toString(),
            strategy: arb.strategy,
            amount: arb.amount,
            txUrl: explorerUrl,
            blockNumber: block,
            confirmations,
            sessionTotal: sessionTotalProfit,
        });
    } catch (error) {
        console.error("  Execution error:", error.message);
        logEvent({
            type: "trade_error",
            timestamp: new Date().toISOString(),
            error: error.message?.slice(0, 200),
            strategy: arb.strategy,
            amount: arb.amount,
        });
    }
}

function logEvent(event) {
    fs.appendFileSync(CONFIG.logFile, JSON.stringify(event) + "\n");
}

main().then(() => process.exit(0)).catch(console.error);
