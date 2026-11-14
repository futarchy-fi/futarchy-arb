#!/usr/bin/env node
/**
 * Multi-option futarchy arbitrage bot (Robinhood Chain, 4663)
 * Uses FutarchyMultiOptionArbitrage (profit-or-revert, operator-only, holds nothing between calls).
 *
 * A market has N options. Option k has a price pool (value of the company token if k wins) and a
 * probability pool (p_k). The bot keeps two identities in line:
 *
 *   sum_k p_k            = 1                     PROBABILITIES_ABOVE_ONE (0) / PROBABILITIES_BELOW_ONE (1)
 *   sum_k p_k * price_k  = spot                  SUM_ABOVE_SPOT (0) / SUM_BELOW_SPOT (1)
 *
 * Every cycle it reads all the pools, logs the probability sum and the identity gap, and when one of them is
 * outside its band it simulates the contract call at several sizes with eth_call, picks the most profitable,
 * and sends it only if the simulated profit after gas clears the threshold. The probabilities are checked
 * first: the spot arbitrage trades unequal remainders through the probability pools, so it works best when
 * they already sum to one. The market (options, pools, tokens) is read from the contract.
 *
 * Usage:
 *   node scripts/arb-bot-multi-option.js                 # dry run: simulate and log, never send
 *   CONFIRM=true node scripts/arb-bot-multi-option.js    # live
 *
 * Environment (all optional except the key when CONFIRM=true):
 *   PRIVATE_KEY_ARB_BOT         operator key of the arb contract (falls back to PRIVATE_KEY_NVDA_ROBINHOOD, PRIVATE_KEY)
 *   ARB_CONTRACT_ADDRESS        default: the deployed contract below
 *   MARKET_ID                   default 0
 *   OPTION_NAMES                comma-separated labels for the log, in option order
 *   ROBINHOOD_RPC_URLS          comma-separated RPC URLs, tried in order
 *   SCAN_INTERVAL_MS            default 5000
 *   MIN_NET_PROFIT              default 0.5 (currency units: simulated profit minus gas)
 *   MAX_COMPANY_PER_TRADE       default 10 (company tokens per spot arbitrage)
 *   MAX_CURRENCY_PER_TRADE      default 500 (currency per probability arbitrage)
 *   MIN_GAP_BPS                 default 12: identity gap that is worth simulating (two 0.05% pool fees and a bit)
 *   MIN_PROB_GAP_BPS            default 10: probability-sum gap that is worth simulating
 *   START_NOT_BEFORE            ISO time; before it the bot watches and logs but never sends
 *   HEARTBEAT_FILE              JSON written every cycle
 *   TRADE_LOG_FILE              JSON lines, one per transaction sent
 *   ALERT_CMD                   program called with ("--source", "multi-option-arb", message); alerts are
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
    contract: env.ARB_CONTRACT_ADDRESS || '0x355281efa67e0daf09c5f50206c0d957b8fff2a8', // FutarchyMultiOptionArbitrage
    marketId: Number(env.MARKET_ID || 0),
    optionNames: (env.OPTION_NAMES || '').split(',').map((s) => s.trim()).filter(Boolean),
    confirm: env.CONFIRM === 'true',
    startNotBefore: env.START_NOT_BEFORE ? Date.parse(env.START_NOT_BEFORE) : 0,
    intervalMs: Number(env.SCAN_INTERVAL_MS || 5000),
    minNetProfit: Number(env.MIN_NET_PROFIT || 0.5),
    minProfitMargin: 0.8, // on-chain minProfit = 80% of the simulated profit
    maxCompany: Number(env.MAX_COMPANY_PER_TRADE || 10),
    maxCurrency: Number(env.MAX_CURRENCY_PER_TRADE || 500),
    minGapBps: Number(env.MIN_GAP_BPS || 12),
    minProbGapBps: Number(env.MIN_PROB_GAP_BPS || 10),
    budgetFactor: 1.3, // currency borrowed for SUM_BELOW_SPOT, as a multiple of the trade's spot value
    heartbeatFile: env.HEARTBEAT_FILE || '',
    tradeLogFile: env.TRADE_LOG_FILE || '',
    alertCmd: env.ALERT_CMD || '',
    lowGasEth: 0.001, // alert below this
    stopGasEth: 0.0002, // do not send below this
};

const WETH_USDG_POOL = '0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a'; // token0 WETH (18), token1 USDG (6): gas pricing

const CONTRACT_ABI = [
    'function executeSpotArbitrage(uint256 marketId, uint8 direction, uint256 companyAmount, uint256 level, uint256 currencyBudget, uint256 minProfit) returns (uint256 profit)',
    'function executeProbabilityArbitrage(uint256 marketId, uint8 direction, uint256 currencyAmount, uint256 minProfit) returns (uint256 profit)',
    'function getMarket(uint256 marketId) view returns (tuple(address proposal, address companyBase, address currencyBase, address company, address currency, address spotPool, address flashPool, address[] companyTokens, address[] currencyTokens, address[] pricePools, address[] probPools, bool active))',
    'function operator() view returns (address)',
    'function treasury() view returns (address)',
    'event SpotArbitrageExecuted(uint256 indexed marketId, uint8 direction, uint256 companyAmount, uint256 profit)',
    'event ProbabilityArbitrageExecuted(uint256 indexed marketId, uint8 direction, uint256 currencyAmount, uint256 profit)',
    'error ArbitrageFailed(uint256 balanceAfter, uint256 required, string reason)',
    'error NotOperator()',
    'error MarketInactive(uint256 marketId)',
];
const POOL_ABI = [
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
    'function token0() view returns (address)',
];
const ERC20_ABI = ['function decimals() view returns (uint8)', 'function symbol() view returns (string)'];

const SPOT_NAME = ['SUM_ABOVE_SPOT', 'SUM_BELOW_SPOT'];
const PROB_NAME = ['PROBABILITIES_ABOVE_ONE', 'PROBABILITIES_BELOW_ONE'];

// =============================================================================
// SMALL UTILITIES
// =============================================================================

const now = () => new Date().toISOString();
const log = (msg) => console.log(`${now()} ${msg}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fmt = (n, d = 4) => Number(n).toFixed(d);
const pct = (x, d = 3) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`;

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
    execFile(CONFIG.alertCmd, ['--source', 'multi-option-arb', `Multi-option arb bot (Robinhood Chain): ${message}`],
        { timeout: 30000 }, (err) => { if (err) log(`WARN alert command failed: ${err.message}`); });
}

// =============================================================================
// CHAIN ACCESS
// =============================================================================

let rpcIndex = 0;
let provider;
let contract; // connected to the signer when live, to the provider otherwise
let signer = null;
let market = null; // see loadMarket()

function connect() {
    const url = CONFIG.rpcUrls[rpcIndex % CONFIG.rpcUrls.length];
    const network = ethers.Network.from(CONFIG.chainId);
    provider = new ethers.JsonRpcProvider(url, network, { staticNetwork: network });
    const key = env.PRIVATE_KEY_ARB_BOT || env.PRIVATE_KEY_NVDA_ROBINHOOD || env.PRIVATE_KEY;
    signer = key ? new ethers.Wallet(key, provider) : null;
    contract = new ethers.Contract(CONFIG.contract, CONTRACT_ABI, signer || provider);
    return url;
}

const pool = (address) => new ethers.Contract(address, POOL_ABI, provider);
const erc20 = (address) => new ethers.Contract(address, ERC20_ABI, provider);

/**
 * Read the market from the contract, and for every pool which token is token0 and the decimals of both
 * sides. Nothing about token order or decimals is assumed.
 */
async function loadMarket() {
    const m = await contract.getMarket(CONFIG.marketId);
    if (!m.active) throw new Error(`market ${CONFIG.marketId} is switched off in the contract`);
    const n = m.companyTokens.length;
    const decimalsOf = async (a) => Number(await erc20(a).decimals());
    const describe = async (poolAddress, base, quote) => {
        const [token0, baseDecimals, quoteDecimals] = await Promise.all([pool(poolAddress).token0(), decimalsOf(base), decimalsOf(quote)]);
        // price = quote per base in human units = raw ratio * 10^(baseDecimals - quoteDecimals)
        return { address: poolAddress, baseIsToken0: token0.toLowerCase() === base.toLowerCase(), scale: 10 ** (baseDecimals - quoteDecimals) };
    };
    const [operator, treasury, companyDecimals, currencyDecimals, spot] = await Promise.all([
        contract.operator(), contract.treasury(), decimalsOf(m.company), decimalsOf(m.currency),
        describe(m.spotPool, m.company, m.currency),
    ]);
    const options = [];
    for (let k = 0; k < n; k++) {
        const [pricePool, probPool, symbol] = await Promise.all([
            describe(m.pricePools[k], m.companyTokens[k], m.currencyTokens[k]),
            describe(m.probPools[k], m.currencyTokens[k], m.currency),
            erc20(m.companyTokens[k]).symbol().catch(() => `option${k}`),
        ]);
        options.push({ name: CONFIG.optionNames[k] || String(symbol).replace(/_.*$/, ''), pricePool, probPool });
    }
    market = { proposal: m.proposal, operator, treasury, companyDecimals, currencyDecimals, spot, options };
    return market;
}

const Q96 = 2 ** 96;
/** Quote per base, human units, from a pool's sqrtPriceX96. */
function poolPrice(desc, sqrtPriceX96) {
    const r = Number(sqrtPriceX96) / Q96;
    const raw = r * r; // token1 per token0, raw units
    return (desc.baseIsToken0 ? raw : 1 / raw) * desc.scale;
}

/** One round of slot0 reads: spot, every option's price and probability, and the two identities. */
async function readState() {
    const calls = [pool(market.spot.address).slot0()];
    for (const o of market.options) calls.push(pool(o.pricePool.address).slot0(), pool(o.probPool.address).slot0());
    const res = await Promise.all(calls);
    const spot = poolPrice(market.spot, res[0].sqrtPriceX96);
    let sumP = 0;
    let weighted = 0;
    const options = market.options.map((o, k) => {
        const price = poolPrice(o.pricePool, res[1 + 2 * k].sqrtPriceX96);
        const p = poolPrice(o.probPool, res[2 + 2 * k].sqrtPriceX96);
        sumP += p;
        weighted += p * price;
        return { name: o.name, p, price };
    });
    return { spot, sumP, weighted, gap: weighted / spot - 1, options };
}

let ethPriceCache = { value: 0, at: 0 };
async function ethPriceInCurrency() {
    if (Date.now() - ethPriceCache.at < 5 * 60 * 1000 && ethPriceCache.value > 0) return ethPriceCache.value;
    const s = await pool(WETH_USDG_POOL).slot0();
    const r = Number(s.sqrtPriceX96) / Q96;
    ethPriceCache = { value: r * r * 1e12, at: Date.now() };
    return ethPriceCache.value;
}

const toCompany = (x) => ethers.parseUnits(x.toFixed(market.companyDecimals), market.companyDecimals);
const toCurrency = (x) => ethers.parseUnits(x.toFixed(market.currencyDecimals), market.currencyDecimals);
const fromCurrency = (x) => Number(ethers.formatUnits(x, market.currencyDecimals));

/** The contract call for one trade: { fn, args(minProfit) }. */
function spotCall(direction, company, spot) {
    const budget = direction === 1 ? toCurrency(company * spot * CONFIG.budgetFactor) : 0n;
    return { fn: 'executeSpotArbitrage', args: (minProfit) => [CONFIG.marketId, direction, toCompany(company), 0, budget, minProfit] };
}
function probCall(direction, currency) {
    return { fn: 'executeProbabilityArbitrage', args: (minProfit) => [CONFIG.marketId, direction, toCurrency(currency), minProfit] };
}

let lastOddRevertLogAt = 0;
/** Simulated profit of one call, or -1 when it reverts (no arbitrage at that size). */
async function simulate(call) {
    try {
        const profit = await contract[call.fn].staticCall(...call.args(0), { from: market.operator });
        return fromCurrency(profit);
    } catch (e) {
        if (e.code !== 'CALL_EXCEPTION') throw e; // RPC trouble: let the main loop back off
        // ArbitrageFailed means "not profitable at this size". Any other revert is unexpected: say so once a minute.
        if (!(e.revert && e.revert.name === 'ArbitrageFailed') && Date.now() - lastOddRevertLogAt > 60000) {
            lastOddRevertLogAt = Date.now();
            log(`WARN simulation of ${call.fn} reverted without ArbitrageFailed: ${(e.shortMessage || e.message || '').slice(0, 160)}`);
        }
        return -1;
    }
}

/** Profit is concave in size: scan a geometric grid, then narrow around the best point. */
async function findBestSize(grid, makeCall) {
    const profits = await Promise.all(grid.map((a) => simulate(makeCall(a))));
    const scan = grid.map((a, i) => `${a}:${fmt(profits[i], 3)}`).join(' ');
    let best = 0;
    for (let i = 1; i < grid.length; i++) if (profits[i] > profits[best]) best = i;
    if (profits[best] <= 0) return { size: 0, profit: 0, scan };

    let lo = grid[Math.max(0, best - 1)];
    let hi = grid[Math.min(grid.length - 1, best + 1)];
    let bestSize = grid[best];
    let bestProfit = profits[best];
    for (let i = 0; i < 5 && hi - lo > bestSize * 0.05; i++) { // ternary search
        const m1 = lo + (hi - lo) / 3;
        const m2 = hi - (hi - lo) / 3;
        const [p1, p2] = await Promise.all([simulate(makeCall(m1)), simulate(makeCall(m2))]);
        if (p1 > bestProfit) { bestProfit = p1; bestSize = m1; }
        if (p2 > bestProfit) { bestProfit = p2; bestSize = m2; }
        if (p1 < p2) lo = m1; else hi = m2;
    }
    return { size: bestSize, profit: bestProfit, scan };
}

// =============================================================================
// ONE CYCLE
// =============================================================================

const state = {
    startedAt: now(),
    cycles: 0,
    trades: 0,
    totalProfit: 0,
    consecutiveErrors: 0,
    consecutiveReverts: 0,
    pausedUntil: 0,
    lastDecision: '',
    lastQuietLogAt: 0,
    lastTrade: null,
};

/** Log a no-trade decision when it changes, and otherwise once a minute. */
function quiet(line, decision) {
    if (decision !== state.lastDecision || Date.now() - state.lastQuietLogAt > 60000) {
        log(`${line} -> ${decision}`);
        state.lastQuietLogAt = Date.now();
    }
    state.lastDecision = decision;
}

async function cycle() {
    const s = await readState();
    const line = `spot=${fmt(s.spot)} sum p*price=${fmt(s.weighted)} gap=${pct(s.gap)} sum p=${fmt(s.sumP, 5)}`;
    const beat = { ts: now(), spot: s.spot, weightedSum: s.weighted, gap: s.gap, sumP: s.sumP, options: s.options,
        decision: 'NOOP', cycles: state.cycles, trades: state.trades, totalProfit: state.totalProfit, live: CONFIG.confirm,
        contract: CONFIG.contract, marketId: CONFIG.marketId, startedAt: state.startedAt, lastTrade: state.lastTrade };
    const done = (decision) => { beat.decision = decision; writeJsonAtomic(CONFIG.heartbeatFile, beat); };

    // Which identity is off? Probabilities first.
    let plan = null;
    const probGap = s.sumP - 1;
    if (Math.abs(probGap) > CONFIG.minProbGapBps / 10000) {
        const direction = probGap > 0 ? 0 : 1;
        const grid = [1, 2, 5, 10, 20, 50, 100, 200, 500].filter((a) => a <= CONFIG.maxCurrency);
        const best = await findBestSize(grid, (a) => probCall(direction, a));
        if (best.profit > 0) plan = { name: PROB_NAME[direction], unit: 'currency', call: probCall(direction, best.size), ...best };
        else quiet(line, `NOOP ${PROB_NAME[direction]}: no size is profitable (scan ${best.scan})`);
    }
    if (!plan && Math.abs(s.gap) > CONFIG.minGapBps / 10000) {
        const direction = s.gap > 0 ? 0 : 1;
        const grid = [0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10].filter((a) => a <= CONFIG.maxCompany);
        const best = await findBestSize(grid, (a) => spotCall(direction, a, s.spot));
        if (best.profit > 0) plan = { name: SPOT_NAME[direction], unit: 'company', call: spotCall(direction, best.size, s.spot), ...best };
        else quiet(line, `NOOP ${SPOT_NAME[direction]}: no size is profitable (scan ${best.scan})`);
    }
    if (!plan) {
        if (Math.abs(probGap) <= CONFIG.minProbGapBps / 10000 && Math.abs(s.gap) <= CONFIG.minGapBps / 10000) {
            quiet(line, 'NOOP both identities are inside the fee band');
        }
        return done(state.lastDecision);
    }

    // Gas: estimate this exact call, price it in the currency.
    const minProfitWei = toCurrency(plan.profit * CONFIG.minProfitMargin);
    const [gasEstimate, feeData, ethPrice] = await Promise.all([
        contract[plan.call.fn].estimateGas(...plan.call.args(minProfitWei), { from: market.operator }),
        provider.getFeeData(),
        ethPriceInCurrency(),
    ]);
    const gasPrice = feeData.gasPrice ?? 0n;
    const gasCost = Number(ethers.formatEther(gasEstimate * gasPrice)) * ethPrice;
    const net = plan.profit - gasCost;
    const summary = `${plan.name} size=${fmt(plan.size, 3)} ${plan.unit} simulated=${fmt(plan.profit, 3)} gas=${fmt(gasCost, 3)} net=${fmt(net, 3)}`;

    if (net < CONFIG.minNetProfit) {
        quiet(line, `SKIP ${plan.name}: net ${fmt(net, 3)} below ${CONFIG.minNetProfit} (${summary})`);
        return done(state.lastDecision);
    }
    if (CONFIG.startNotBefore && Date.now() < CONFIG.startNotBefore) {
        quiet(line, `HOLD until ${new Date(CONFIG.startNotBefore).toISOString()} (would send ${summary})`);
        return done(state.lastDecision);
    }
    if (!CONFIG.confirm || !signer) {
        log(`${line} -> DRY RUN would send ${summary}`);
        state.lastDecision = 'DRY';
        return done(`DRY ${summary}`);
    }

    // Gas balance guard.
    const balanceEth = Number(ethers.formatEther(await provider.getBalance(signer.address)));
    if (balanceEth < CONFIG.lowGasEth) alert('low-gas', `gas is low: ${fmt(balanceEth, 5)} ETH at ${signer.address}`, 6 * 60 * 60 * 1000);
    if (balanceEth < CONFIG.stopGasEth) {
        quiet(line, `SKIP ${plan.name}: not enough gas (${fmt(balanceEth, 6)} ETH)`);
        return done('SKIP no gas');
    }

    log(`${line} -> SEND ${summary} minProfit=${fmt(plan.profit * CONFIG.minProfitMargin, 4)}`);
    state.lastDecision = 'SEND';
    const tx = await contract[plan.call.fn](...plan.call.args(minProfitWei), {
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

    const record = { ts: now(), tx: tx.hash, kind: plan.name, size: plan.size, unit: plan.unit, simulated: plan.profit,
        gasUsed: receipt.gasUsed.toString(), status: receipt.status,
        before: { spot: s.spot, weightedSum: s.weighted, gap: s.gap, sumP: s.sumP } };
    if (receipt.status === 1) {
        let profit = null;
        for (const l of receipt.logs) {
            try {
                const parsed = contract.interface.parseLog(l);
                if (parsed && /ArbitrageExecuted$/.test(parsed.name)) profit = fromCurrency(parsed.args.profit);
            } catch (_) { /* log from another contract */ }
        }
        const after = await readState();
        record.profit = profit;
        record.after = { spot: after.spot, weightedSum: after.weighted, gap: after.gap, sumP: after.sumP };
        state.trades += 1;
        state.totalProfit += profit || 0;
        state.consecutiveReverts = 0;
        log(`OK ${tx.hash} profit=${fmt(profit ?? 0, 4)} gasUsed=${receipt.gasUsed} -> spot=${fmt(after.spot)} sum p*price=${fmt(after.weighted)} gap=${pct(after.gap)} sum p=${fmt(after.sumP, 5)} (total ${state.trades} trades, ${fmt(state.totalProfit, 3)})`);
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
    beat.lastTrade = record;
    beat.trades = state.trades;
    beat.totalProfit = state.totalProfit;
    done(receipt.status === 1 ? 'TRADED' : 'REVERTED');
}

// =============================================================================
// MAIN LOOP
// =============================================================================

async function main() {
    const url = connect();
    log('MULTI-OPTION FUTARCHY ARBITRAGE BOT - Robinhood Chain (4663)');
    log(`contract=${CONFIG.contract} market=${CONFIG.marketId} rpc=${url} mode=${CONFIG.confirm ? 'LIVE' : 'DRY RUN'} interval=${CONFIG.intervalMs}ms minNet=${CONFIG.minNetProfit} maxCompany=${CONFIG.maxCompany} maxCurrency=${CONFIG.maxCurrency} minGap=${CONFIG.minGapBps}bps minProbGap=${CONFIG.minProbGapBps}bps`);

    const m = await loadMarket();
    log(`market proposal=${m.proposal} options=${m.options.map((o) => o.name).join(',')} operator=${m.operator} treasury=${m.treasury}`);
    if (CONFIG.startNotBefore) log(`will not send before ${new Date(CONFIG.startNotBefore).toISOString()}`);
    if (CONFIG.confirm) {
        if (!signer) throw new Error('CONFIRM=true but no PRIVATE_KEY_ARB_BOT / PRIVATE_KEY_NVDA_ROBINHOOD / PRIVATE_KEY');
        if (signer.address.toLowerCase() !== m.operator.toLowerCase()) throw new Error(`key is for ${signer.address}, the contract operator is ${m.operator}`);
        log(`signer=${signer.address} gas=${ethers.formatEther(await provider.getBalance(signer.address))} ETH`);
    }
    const first = await readState();
    log(`options: ${first.options.map((o) => `${o.name} p=${(o.p * 100).toFixed(2)}% price=${fmt(o.price, 2)}`).join(' | ')}`);

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
