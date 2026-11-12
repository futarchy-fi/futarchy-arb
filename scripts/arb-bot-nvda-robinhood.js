#!/usr/bin/env node
/**
 * NVDA Arbitrage Bot - Robinhood Chain (4663)
 * Uses NVDAFlashArbitrageRobinhood (flash swap on the NVDA/USDG spot pool, profit-or-revert, owner-only).
 *
 * Keeps the YES and NO conditional NVDA/USDG pools of the futarchy proposal consistent with spot:
 *   both conditional prices above spot -> SPOT_SPLIT (0)
 *   both conditional prices below spot -> MERGE_SPOT (1)
 *   spot between YES and NO            -> nothing to do
 *
 * Every cycle: read the three pool prices, and when a gap exists simulate the contract call at several
 * sizes, pick the most profitable one, and send it only if the simulated USDG profit after gas clears the
 * threshold. The contract itself reverts unless it nets `minProfit`, so only gas is ever at risk.
 *
 * Usage:
 *   node scripts/arb-bot-nvda-robinhood.js                 # dry run: simulate and log, never send
 *   CONFIRM=true node scripts/arb-bot-nvda-robinhood.js    # live
 *
 * Environment (all optional except the key when CONFIRM=true):
 *   PRIVATE_KEY_NVDA_ROBINHOOD  owner key of the arb contract (falls back to PRIVATE_KEY)
 *   ARB_CONTRACT_ADDRESS        default: the deployed contract below
 *   ROBINHOOD_RPC_URLS          comma-separated RPC URLs, tried in order
 *   SCAN_INTERVAL_MS            default 5000
 *   MIN_NET_PROFIT_USDG         default 0.5 (simulated profit minus gas)
 *   MAX_NVDA_PER_TRADE          default 10
 *   MIN_GAP_BPS                 default 12 (0.12%: two 0.05% pool fees plus a little)
 *   HEARTBEAT_FILE              JSON written every cycle
 *   TRADE_LOG_FILE              JSON lines, one per transaction sent
 *   ALERT_CMD                   program called with ("--source", "nvda-robinhood-arb", message); alerts are
 *                               rate-limited and only cover repeated failures and low gas, never single trades
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
try { require('dotenv').config(); } catch (_) { /* dotenv is optional */ }

// =============================================================================
// CONFIGURATION
// =============================================================================

const env = process.env;
const CONFIG = {
    chainId: 4663,
    rpcUrls: (env.ROBINHOOD_RPC_URLS || 'https://rpc.mainnet.chain.robinhood.com,https://robinhood-rpc.publicnode.com')
        .split(',').map((s) => s.trim()).filter(Boolean),
    contract: env.ARB_CONTRACT_ADDRESS || '0xdbc389d2b4637bbd85f640f1e66397a14da003ae', // NVDAFlashArbitrageRobinhood
    owner: '0x645A3D9208523bbFEE980f7269ac72C61Dd3b552',
    confirm: env.CONFIRM === 'true',
    intervalMs: Number(env.SCAN_INTERVAL_MS || 5000),
    minNetProfitUsdg: Number(env.MIN_NET_PROFIT_USDG || 0.5),
    minProfitMargin: 0.8, // on-chain minProfit = 80% of the simulated profit
    maxNvda: Number(env.MAX_NVDA_PER_TRADE || 10),
    minGapBps: Number(env.MIN_GAP_BPS || 12),
    heartbeatFile: env.HEARTBEAT_FILE || '',
    tradeLogFile: env.TRADE_LOG_FILE || '',
    alertCmd: env.ALERT_CMD || '',
    lowGasEth: 0.0015, // alert below this
    stopGasEth: 0.0003, // do not send below this
};

const ADDRESSES = {
    SPOT_POOL: '0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3', // token0 USDG (6), token1 NVDA (18)
    YES_POOL: '0xba71c15c9A92a3875144Accc0416FE67D898b77C', // token0 YES_USDG (6), token1 YES_NVDA (18)
    NO_POOL: '0x2616fBb93e1b3283d2a14760768D5Ec2ec352c90', // token0 NO_NVDA (18), token1 NO_USDG (6)
    WETH_USDG_POOL: '0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a', // token0 WETH (18), token1 USDG (6)
};

const CONTRACT_ABI = [
    'function executeArbitrage(uint256 nvdaAmount, uint8 direction, uint256 minProfit) returns (uint256 profit)',
    'function owner() view returns (address)',
    'event ArbitrageExecuted(address indexed caller, uint8 direction, uint256 nvdaAmount, uint256 profitUsdg)',
    'error ArbitrageFailed(uint256 balanceAfter, uint256 required, string reason)',
    'error NotOwner()',
];
const POOL_ABI = [
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
];
const DIRECTION = { SPOT_SPLIT: 0, MERGE_SPOT: 1 };
const DIRECTION_NAME = ['SPOT_SPLIT', 'MERGE_SPOT'];

// =============================================================================
// PRICE MATH (USDG has 6 decimals, NVDA 18; outcome tokens follow their collateral)
// =============================================================================

const Q96 = 2 ** 96;
/** USDG per NVDA for a pool whose token0 is the USDG side and token1 the NVDA side. */
const priceUsdgFirst = (sqrtPriceX96) => { const r = Number(sqrtPriceX96) / Q96; return 1e12 / (r * r); };
/** USDG per 18-decimal token for a pool whose token0 is the 18-decimal side and token1 the USDG side. */
const priceUsdgSecond = (sqrtPriceX96) => { const r = Number(sqrtPriceX96) / Q96; return r * r * 1e12; };

// =============================================================================
// SMALL UTILITIES
// =============================================================================

const now = () => new Date().toISOString();
const log = (msg) => console.log(`${now()} ${msg}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fmt = (n, d = 4) => Number(n).toFixed(d);

function writeJsonAtomic(file, obj) {
    if (!file) return;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(obj));
        fs.renameSync(tmp, file);
    } catch (e) {
        log(`WARN heartbeat write failed: ${e.message}`);
    }
}

function appendJsonLine(file, obj) {
    if (!file) return;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, JSON.stringify(obj) + '\n');
    } catch (e) {
        log(`WARN trade log write failed: ${e.message}`);
    }
}

const lastAlertAt = new Map();
/** Send one alert per `key` at most every `everyMs`. Always logs. */
function alert(key, message, everyMs = 60 * 60 * 1000) {
    const last = lastAlertAt.get(key) || 0;
    if (Date.now() - last < everyMs) return;
    lastAlertAt.set(key, Date.now());
    log(`ALERT ${message}`);
    if (!CONFIG.alertCmd) return;
    execFile(CONFIG.alertCmd, ['--source', 'nvda-robinhood-arb', `NVDA arb bot (Robinhood Chain): ${message}`],
        { timeout: 30000 }, (err) => { if (err) log(`WARN alert command failed: ${err.message}`); });
}

// =============================================================================
// CHAIN ACCESS
// =============================================================================

let rpcIndex = 0;
let provider;
let contract;      // connected to the signer when live, to the provider otherwise
let pools;
let signer = null;

function connect() {
    const url = CONFIG.rpcUrls[rpcIndex % CONFIG.rpcUrls.length];
    const network = ethers.Network.from(CONFIG.chainId);
    provider = new ethers.JsonRpcProvider(url, network, { staticNetwork: network });
    const key = env.PRIVATE_KEY_NVDA_ROBINHOOD || env.PRIVATE_KEY;
    signer = key ? new ethers.Wallet(key, provider) : null;
    contract = new ethers.Contract(CONFIG.contract, CONTRACT_ABI, signer || provider);
    pools = Object.fromEntries(Object.entries(ADDRESSES).map(([k, a]) => [k, new ethers.Contract(a, POOL_ABI, provider)]));
    return url;
}

async function readPrices() {
    const [spot, yes, no] = await Promise.all([pools.SPOT_POOL.slot0(), pools.YES_POOL.slot0(), pools.NO_POOL.slot0()]);
    return {
        spot: priceUsdgFirst(spot.sqrtPriceX96),
        yes: priceUsdgFirst(yes.sqrtPriceX96),
        no: priceUsdgSecond(no.sqrtPriceX96),
    };
}

let ethPriceCache = { value: 0, at: 0 };
async function ethPriceUsdg() {
    if (Date.now() - ethPriceCache.at < 5 * 60 * 1000 && ethPriceCache.value > 0) return ethPriceCache.value;
    const s = await pools.WETH_USDG_POOL.slot0();
    ethPriceCache = { value: priceUsdgSecond(s.sqrtPriceX96), at: Date.now() };
    return ethPriceCache.value;
}

let lastOddRevertLogAt = 0;
/** Simulated USDG profit of one size, or -1 when the call reverts (no arbitrage at that size). */
async function simulate(nvda, direction) {
    try {
        const profit = await contract.executeArbitrage.staticCall(
            ethers.parseEther(nvda.toFixed(18)), direction, 0, { from: CONFIG.owner }
        );
        return Number(ethers.formatUnits(profit, 6));
    } catch (e) {
        if (e.code !== 'CALL_EXCEPTION') throw e; // RPC trouble: let the main loop back off
        // ArbitrageFailed means "not profitable at this size". Any other revert is unexpected: say so once a minute.
        if (!(e.revert && e.revert.name === 'ArbitrageFailed') && Date.now() - lastOddRevertLogAt > 60000) {
            lastOddRevertLogAt = Date.now();
            log(`WARN simulation of ${nvda} NVDA ${DIRECTION_NAME[direction]} reverted without ArbitrageFailed: ${(e.shortMessage || e.message || '').slice(0, 160)}`);
        }
        return -1;
    }
}

/** Profit is concave in size: scan a geometric grid, then narrow around the best point. */
async function findBestSize(direction) {
    const grid = [0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20].filter((a) => a <= CONFIG.maxNvda);
    const profits = await Promise.all(grid.map((a) => simulate(a, direction)));
    let best = 0;
    for (let i = 1; i < grid.length; i++) if (profits[i] > profits[best]) best = i;
    if (profits[best] <= 0) return { nvda: 0, profit: 0, scan: grid.map((a, i) => `${a}:${fmt(profits[i], 3)}`).join(' ') };

    let lo = grid[Math.max(0, best - 1)];
    let hi = grid[Math.min(grid.length - 1, best + 1)];
    let bestNvda = grid[best];
    let bestProfit = profits[best];
    for (let i = 0; i < 6 && hi - lo > 0.01; i++) { // ternary search
        const m1 = lo + (hi - lo) / 3;
        const m2 = hi - (hi - lo) / 3;
        const [p1, p2] = await Promise.all([simulate(m1, direction), simulate(m2, direction)]);
        if (p1 > bestProfit) { bestProfit = p1; bestNvda = m1; }
        if (p2 > bestProfit) { bestProfit = p2; bestNvda = m2; }
        if (p1 < p2) lo = m1; else hi = m2;
    }
    return { nvda: bestNvda, profit: bestProfit, scan: grid.map((a, i) => `${a}:${fmt(profits[i], 3)}`).join(' ') };
}

// =============================================================================
// ONE CYCLE
// =============================================================================

const state = {
    startedAt: now(),
    cycles: 0,
    trades: 0,
    totalProfitUsdg: 0,
    consecutiveErrors: 0,
    consecutiveReverts: 0,
    pausedUntil: 0,
    lastDecision: '',
    lastNoopLogAt: 0,
    lastTrade: null,
};

async function cycle() {
    const p = await readPrices();
    const lo = Math.min(p.yes, p.no);
    const hi = Math.max(p.yes, p.no);
    const gap = CONFIG.minGapBps / 10000;

    let direction = null;
    if (lo > p.spot * (1 + gap)) direction = DIRECTION.SPOT_SPLIT;      // both conditional prices above spot
    else if (hi < p.spot * (1 - gap)) direction = DIRECTION.MERGE_SPOT; // both conditional prices below spot

    const prices = `spot=${fmt(p.spot)} YES=${fmt(p.yes)} NO=${fmt(p.no)}`;
    const beat = { ts: now(), prices: p, decision: 'NOOP', cycles: state.cycles, trades: state.trades,
        totalProfitUsdg: state.totalProfitUsdg, live: CONFIG.confirm, contract: CONFIG.contract, startedAt: state.startedAt,
        lastTrade: state.lastTrade };

    if (direction === null) {
        const decision = 'NOOP spot is between YES and NO (or within the fee band)';
        if (decision !== state.lastDecision || Date.now() - state.lastNoopLogAt > 60000) {
            log(`${prices} -> ${decision}`);
            state.lastNoopLogAt = Date.now();
        }
        state.lastDecision = decision;
        writeJsonAtomic(CONFIG.heartbeatFile, beat);
        return;
    }

    const name = DIRECTION_NAME[direction];
    const best = await findBestSize(direction);
    if (best.profit <= 0) {
        const decision = `NOOP ${name}: gap seen but no size is profitable`;
        if (decision !== state.lastDecision || Date.now() - state.lastNoopLogAt > 60000) {
            log(`${prices} -> ${decision} (scan ${best.scan})`);
            state.lastNoopLogAt = Date.now();
        }
        state.lastDecision = decision;
        beat.decision = decision;
        writeJsonAtomic(CONFIG.heartbeatFile, beat);
        return;
    }

    // Gas: estimate this exact call, price it in USDG.
    const amountWei = ethers.parseEther(best.nvda.toFixed(18));
    const minProfitWei = ethers.parseUnits((best.profit * CONFIG.minProfitMargin).toFixed(6), 6);
    const [gasEstimate, feeData, ethPrice] = await Promise.all([
        contract.executeArbitrage.estimateGas(amountWei, direction, minProfitWei, { from: CONFIG.owner }),
        provider.getFeeData(),
        ethPriceUsdg(),
    ]);
    const gasPrice = feeData.gasPrice ?? 0n;
    const gasCostUsdg = Number(ethers.formatEther(gasEstimate * gasPrice)) * ethPrice;
    const net = best.profit - gasCostUsdg;
    const summary = `${name} size=${fmt(best.nvda, 3)} NVDA simulated=${fmt(best.profit, 3)} USDG gas=${fmt(gasCostUsdg, 4)} USDG net=${fmt(net, 3)} USDG`;

    if (net < CONFIG.minNetProfitUsdg) {
        const decision = `SKIP ${name}: net below ${CONFIG.minNetProfitUsdg} USDG`;
        if (decision !== state.lastDecision || Date.now() - state.lastNoopLogAt > 60000) {
            log(`${prices} -> ${decision} (${summary})`);
            state.lastNoopLogAt = Date.now();
        }
        state.lastDecision = decision;
        beat.decision = decision;
        writeJsonAtomic(CONFIG.heartbeatFile, beat);
        return;
    }

    if (!CONFIG.confirm || !signer) {
        log(`${prices} -> DRY RUN would send ${summary}`);
        state.lastDecision = 'DRY';
        beat.decision = `DRY ${summary}`;
        writeJsonAtomic(CONFIG.heartbeatFile, beat);
        return;
    }

    // Gas balance guard.
    const balanceEth = Number(ethers.formatEther(await provider.getBalance(signer.address)));
    if (balanceEth < CONFIG.lowGasEth) alert('low-gas', `gas is low: ${fmt(balanceEth, 5)} ETH at ${signer.address}`, 6 * 60 * 60 * 1000);
    if (balanceEth < CONFIG.stopGasEth) {
        log(`${prices} -> SKIP ${name}: not enough gas (${fmt(balanceEth, 6)} ETH)`);
        beat.decision = 'SKIP no gas';
        writeJsonAtomic(CONFIG.heartbeatFile, beat);
        return;
    }

    log(`${prices} -> SEND ${summary} minProfit=${ethers.formatUnits(minProfitWei, 6)} USDG`);
    state.lastDecision = 'SEND';
    const tx = await contract.executeArbitrage(amountWei, direction, minProfitWei, {
        gasLimit: (gasEstimate * 13n) / 10n,
        maxFeePerGas: gasPrice * 3n,
        maxPriorityFeePerGas: 0n,
    });
    let receipt = null;
    try {
        receipt = await tx.wait(1, 90000);
    } catch (e) {
        receipt = e.receipt || null; // a reverted transaction still has a receipt
        if (!receipt) throw e;
    }

    const record = { ts: now(), tx: tx.hash, direction: name, nvda: best.nvda, simulatedUsdg: best.profit,
        gasUsed: receipt.gasUsed.toString(), status: receipt.status, pricesBefore: p };
    if (receipt.status === 1) {
        let profit = null;
        for (const l of receipt.logs) {
            try {
                const parsed = contract.interface.parseLog(l);
                if (parsed && parsed.name === 'ArbitrageExecuted') profit = Number(ethers.formatUnits(parsed.args.profitUsdg, 6));
            } catch (_) { /* log from another contract */ }
        }
        const after = await readPrices();
        record.profitUsdg = profit;
        record.pricesAfter = after;
        state.trades += 1;
        state.totalProfitUsdg += profit || 0;
        state.consecutiveReverts = 0;
        log(`OK ${tx.hash} profit=${fmt(profit ?? 0, 4)} USDG gasUsed=${receipt.gasUsed} -> spot=${fmt(after.spot)} YES=${fmt(after.yes)} NO=${fmt(after.no)} (total ${state.trades} trades, ${fmt(state.totalProfitUsdg, 3)} USDG)`);
    } else {
        state.consecutiveReverts += 1;
        log(`REVERTED ${tx.hash} gasUsed=${receipt.gasUsed} (someone else moved the price first, or the simulation went stale)`);
        if (state.consecutiveReverts >= 3) {
            state.pausedUntil = Date.now() + 10 * 60 * 1000;
            alert('reverts', `${state.consecutiveReverts} transactions in a row reverted; pausing 10 minutes. Last: ${tx.hash}`);
        }
    }
    state.lastTrade = record;
    appendJsonLine(CONFIG.tradeLogFile, record);
    beat.decision = receipt.status === 1 ? 'TRADED' : 'REVERTED';
    beat.lastTrade = record;
    beat.trades = state.trades;
    beat.totalProfitUsdg = state.totalProfitUsdg;
    writeJsonAtomic(CONFIG.heartbeatFile, beat);
}

// =============================================================================
// MAIN LOOP
// =============================================================================

async function main() {
    const url = connect();
    log('NVDA ARBITRAGE BOT - Robinhood Chain (4663)');
    log(`contract=${CONFIG.contract} rpc=${url} mode=${CONFIG.confirm ? 'LIVE' : 'DRY RUN'} interval=${CONFIG.intervalMs}ms minNet=${CONFIG.minNetProfitUsdg} USDG maxSize=${CONFIG.maxNvda} NVDA minGap=${CONFIG.minGapBps}bps`);

    const owner = await contract.owner();
    if (owner.toLowerCase() !== CONFIG.owner.toLowerCase()) throw new Error(`contract owner is ${owner}, expected ${CONFIG.owner}`);
    if (CONFIG.confirm) {
        if (!signer) throw new Error('CONFIRM=true but no PRIVATE_KEY_NVDA_ROBINHOOD / PRIVATE_KEY');
        if (signer.address.toLowerCase() !== owner.toLowerCase()) throw new Error(`key is for ${signer.address}, the contract owner is ${owner}`);
        log(`signer=${signer.address} gas=${ethers.formatEther(await provider.getBalance(signer.address))} ETH`);
    }

    for (;;) {
        const started = Date.now();
        state.cycles += 1;
        let wait = CONFIG.intervalMs;
        try {
            if (Date.now() < state.pausedUntil) {
                writeJsonAtomic(CONFIG.heartbeatFile, { ts: now(), decision: 'PAUSED after reverts', pausedUntil: new Date(state.pausedUntil).toISOString(), contract: CONFIG.contract });
            } else {
                await cycle();
            }
            state.consecutiveErrors = 0;
        } catch (e) {
            state.consecutiveErrors += 1;
            const msg = (e.shortMessage || e.message || String(e)).slice(0, 200);
            wait = Math.min(60000, CONFIG.intervalMs * 2 ** Math.min(state.consecutiveErrors, 6));
            log(`ERROR #${state.consecutiveErrors} ${msg} -> retry in ${Math.round(wait / 1000)}s`);
            if (state.consecutiveErrors % 3 === 0 && CONFIG.rpcUrls.length > 1) {
                rpcIndex += 1;
                log(`switching RPC to ${connect()}`);
            }
            if (state.consecutiveErrors >= 12) alert('errors', `${state.consecutiveErrors} cycles in a row failed: ${msg}`);
        }
        await sleep(Math.max(500, wait - (Date.now() - started)));
    }
}

main().catch((e) => {
    console.error(`${now()} FATAL ${e.message}`);
    process.exit(1);
});
