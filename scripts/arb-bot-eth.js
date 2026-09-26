/**
 * ETH/USDS Futarchy Arbitrage Bot - Ethereum Mainnet
 * Uses ETHFlashArbitrageV1 (Universal Router + Permit2 + Sky UsdsPsmWrapper)
 * Ported from arb-bot-vlr.js, plus a scan loop and heartbeat.
 *
 * Features:
 * - Scan loop (default 30s): conditional pool prices vs WETH/USDC spot (USDS == USD)
 * - Fires arb when divergence > threshold (default 1%), direction from sign
 * - Simulates via staticCall before any live send; dry-run unless CONFIRM=true
 * - Heartbeat: logs/eth-arb-heartbeat.json every loop + optional HEARTBEAT_URL GET
 *
 * Env:
 *   RPC_URL               RPC endpoint (default https://ethereum.publicnode.com)
 *   ETH_ARB_CONTRACT      deployed ETHFlashArbitrageV1 (unset => price-scan-only mode)
 *   PRIVATE_KEY_ETH       admin key (unset => price-scan-only mode)
 *   DIVERGENCE_THRESHOLD  fraction, default 0.01 (1%)
 *   SCAN_INTERVAL_MS      default 30000
 *   TEST_AMOUNTS_WETH     comma-separated seed ladder, default
 *                         "0.00005,0.0001,0.0002,0.0005,0.001"
 *   MIN_PROFIT_WETH       on-chain minProfit, default 0 (economics is price alignment)
 *   HEARTBEAT_URL         optional; GET on every loop, fire-and-forget
 *   ONCE=true             single scan then exit (for testing)
 *   CONFIRM=true          live execution
 *
 * Usage:
 *   node scripts/arb-bot-eth.js                 # Dry run (simulation only)
 *   CONFIRM=true node scripts/arb-bot-eth.js    # Live execution
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
    // ETH_RPC_URL preferred: the repo's .env RPC_URL points at Gnosis.
    // Chain is verified at startup; non-mainnet falls back to the public RPC.
    rpc: process.env.ETH_RPC_URL || process.env.RPC_URL || 'https://ethereum.publicnode.com',
    fallbackRpc: 'https://ethereum.publicnode.com',
    contract: process.env.ETH_ARB_CONTRACT || '',   // ETHFlashArbitrageV1 (not yet deployed)
    gasLimit: 3000000n,

    // Amounts to test (in WETH) - conditional pools only hold a few dollars
    testAmounts: (process.env.TEST_AMOUNTS_WETH || '0.00005,0.0001,0.0002,0.0005,0.001')
        .split(',').map(s => parseFloat(s.trim())).filter(n => n > 0),

    divergenceThreshold: parseFloat(process.env.DIVERGENCE_THRESHOLD || '0.01'),
    scanIntervalMs: parseInt(process.env.SCAN_INTERVAL_MS || '30000', 10),
    minProfitWETH: process.env.MIN_PROFIT_WETH || '0',
    gasMargin: parseFloat(process.env.GAS_MARGIN || '1.5'), // execute only if profit > gasCost x margin
    maxBorrowWETH: parseFloat(process.env.MAX_BORROW_WETH || '100'), // adaptive size search ceiling
    sizeGrowth: parseFloat(process.env.SIZE_GROWTH || '2.5'),        // geometric ladder factor

    heartbeatFile: path.join(__dirname, '..', 'logs', 'eth-arb-heartbeat.json'),
    heartbeatUrl: process.env.HEARTBEAT_URL || '',
};

// Contract addresses (ETH/USDS futarchy market, verified on-chain)
const ADDRESSES = {
    WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    USDS: '0xdC035D45d973E3EC169d2276DDab16f1e407384F',
    // YES pool: token0 = YES_WETH, token1 = YES_USDS (fee 500)
    YES_POOL: '0xA95D30C125C20D001F6aed9F2EFF1B8e5577dcA3',
    // NO pool: token0 = NO_USDS, token1 = NO_WETH (fee 500) - inverted vs YES pool!
    NO_POOL: '0x7a3b5F6592186C5d121EC4e48FC9e5d020a0b2dF',
    // Spot reference: WETH/USDC 0.05%, token0 = USDC (6 dec), token1 = WETH (18 dec)
    SPOT_POOL: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640',
};

// ABIs
const CONTRACT_ABI = [
    'function executeArbitrage(uint256 borrowAmount, uint8 direction, uint256 minProfit, uint256 slippageBps) external returns (tuple(bool success, uint256 profit, uint256 borrowAmount, uint256 gasUsed))',
    'error ArbitrageFailed(uint256 balanceAfter, uint256 required, string reason)'
];

const POOL_ABI = [
    'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)'
];

const DIRECTION = { SPOT_SPLIT: 0, MERGE_SPOT: 1 };

/**
 * Normalize configured seed sizes and extend them geometrically to the cap.
 * Every explicit seed is tested once; this avoids silently ignoring all but
 * TEST_AMOUNTS_WETH[0], which hid executable (but usually sub-gas) tiny quotes.
 */
function candidateSizeLadder(seedAmounts, growth, maxBorrow) {
    if (!Number.isFinite(growth) || growth <= 1) {
        throw new Error('SIZE_GROWTH must be greater than 1');
    }
    if (!Number.isFinite(maxBorrow) || maxBorrow <= 0) {
        throw new Error('MAX_BORROW_WETH must be greater than 0');
    }

    const amounts = [...new Set(seedAmounts)]
        .filter(n => Number.isFinite(n) && n > 0 && n <= maxBorrow)
        .sort((a, b) => a - b);
    if (amounts.length === 0) {
        throw new Error('TEST_AMOUNTS_WETH must contain a positive size within MAX_BORROW_WETH');
    }

    let next = amounts[amounts.length - 1] * growth;
    while (next <= maxBorrow) {
        amounts.push(next);
        next *= growth;
    }
    return amounts;
}

// =============================================================================
// PRICES
// =============================================================================

/** price of token1 per token0 in raw units, from sqrtPriceX96 */
function rawPrice(sqrtPriceX96) {
    const p = Number(sqrtPriceX96) / 2 ** 96;
    return p * p;
}

async function getPrices(provider) {
    const yesPool = new ethers.Contract(ADDRESSES.YES_POOL, POOL_ABI, provider);
    const noPool = new ethers.Contract(ADDRESSES.NO_POOL, POOL_ABI, provider);
    const spotPool = new ethers.Contract(ADDRESSES.SPOT_POOL, POOL_ABI, provider);

    const [yesSlot, noSlot, spotSlot, feeData, block] = await Promise.all([
        yesPool.slot0(), noPool.slot0(), spotPool.slot0(),
        provider.getFeeData(), provider.getBlockNumber(),
    ]);

    // YES pool: token0 YES_WETH (18), token1 YES_USDS (18) => raw = USDS per WETH
    const yesPrice = rawPrice(yesSlot.sqrtPriceX96);
    // NO pool: token0 NO_USDS (18), token1 NO_WETH (18) => raw = WETH per USDS => invert
    const noPrice = 1 / rawPrice(noSlot.sqrtPriceX96);
    // Spot: token0 USDC (6), token1 WETH (18) => raw = WETH-wei per USDC-unit
    // USDC per WETH = 1e12 / raw (decimal adjustment 10^(18-6)); USDS == USD == USDC
    const spotPrice = 1e12 / rawPrice(spotSlot.sqrtPriceX96);

    const condMid = (yesPrice + noPrice) / 2;
    const divergence = (condMid - spotPrice) / spotPrice;

    const gasGwei = parseFloat(ethers.formatUnits(feeData.gasPrice ?? 0n, 'gwei'));
    const gasCostUSD = parseFloat(ethers.formatEther((feeData.gasPrice ?? 0n) * 1300000n)) * spotPrice;

    return { yesPrice, noPrice, spotPrice, condMid, divergence, gasGwei, gasCostUSD, block };
}

// =============================================================================
// HEARTBEAT
// =============================================================================

function heartbeat(status) {
    // (a) JSON status file
    try {
        fs.mkdirSync(path.dirname(CONFIG.heartbeatFile), { recursive: true });
        fs.writeFileSync(CONFIG.heartbeatFile, JSON.stringify(status, null, 2) + '\n');
    } catch (e) {
        console.log('⚠️ heartbeat file write failed:', e.message);
    }
    // (b) optional HTTP GET, fire-and-forget (node >= 18 global fetch, dependency-free)
    if (CONFIG.heartbeatUrl) {
        fetch(CONFIG.heartbeatUrl).catch(e => console.log('⚠️ heartbeat URL failed:', e.message));
    }
}

// =============================================================================
// SCAN + EXECUTE
// =============================================================================

async function scanOnce(provider, contract) {
    const prices = await getPrices(provider);
    const ts = new Date().toISOString();

    console.log(`[${ts}] block ${prices.block}` +
        ` | YES ${prices.yesPrice.toFixed(2)} | NO ${prices.noPrice.toFixed(2)}` +
        ` | spot ${prices.spotPrice.toFixed(2)}` +
        ` | div ${(prices.divergence * 100).toFixed(3)}%`);

    let action = 'none';
    let executionState = 'NO_OPPORTUNITY';

    if (Math.abs(prices.divergence) <= CONFIG.divergenceThreshold) {
        action = 'below-threshold';
    } else if (!contract) {
        action = 'no-contract-or-key (price-scan-only)';
        executionState = 'PRICE_SCAN_ONLY';
        console.log('  ⚠️ Divergence above threshold but ETH_ARB_CONTRACT/PRIVATE_KEY_ETH not set');
    } else {
        // Conditional pools rich vs spot => sell conditional WETH => SPOT_SPLIT
        // Conditional pools cheap vs spot => buy conditional WETH => MERGE_SPOT
        const direction = prices.divergence > 0 ? DIRECTION.SPOT_SPLIT : DIRECTION.MERGE_SPOT;
        const dirName = prices.divergence > 0 ? 'SPOT_SPLIT' : 'MERGE_SPOT';
        console.log(`  🔍 Divergence ${(prices.divergence * 100).toFixed(3)}% > threshold, simulating ${dirName}...`);

        const minProfit = ethers.parseEther(CONFIG.minProfitWETH);
        let best = null;

        // Adaptive size search: profit(size) is unimodal (grows until price impact
        // eats the edge), so walk a geometric ladder and stop after the peak.
        // Simulations are free; this finds the max-profit size at any pool depth.
        let declines = 0;
        let revertStreak = 0;
        const candidateAmounts = candidateSizeLadder(
            CONFIG.testAmounts, CONFIG.sizeGrowth, CONFIG.maxBorrowWETH
        );
        const configuredSeedMax = Math.max(
            ...CONFIG.testAmounts.filter(n => n > 0 && n <= CONFIG.maxBorrowWETH)
        );
        for (const amountNum of candidateAmounts) {
            // Honor every explicit seed. Peak/revert early-stop applies only to
            // the generated geometric extension beyond the configured ladder.
            if (amountNum > configuredSeedMax && (declines >= 2 || revertStreak >= 3)) break;
            const amount = ethers.parseEther(amountNum.toFixed(18));
            try {
                const result = await contract.executeArbitrage.staticCall(
                    amount, direction, minProfit, 0,
                    { gasLimit: CONFIG.gasLimit }
                );
                const profitWETH = parseFloat(ethers.formatEther(result.profit));
                const profitUSD = profitWETH * prices.spotPrice;
                console.log(`    ${amountNum} WETH => profit ${profitWETH.toFixed(8)} WETH ($${profitUSD.toFixed(4)})`);
                revertStreak = 0;
                if (!best || result.profit > best.profit) {
                    best = { amountNum, amount, profit: result.profit, profitWETH, profitUSD };
                    declines = 0;
                } else {
                    declines++;
                }
            } catch (e) {
                let msg = e.shortMessage || e.reason || 'REVERT';
                if (e.revert && e.revert.name === 'ArbitrageFailed') {
                    const shortfall = ethers.formatEther(e.revert.args[1] - e.revert.args[0]);
                    msg = `${e.revert.args[2]} (shortfall ${shortfall} WETH)`;
                }
                console.log(`    ${amountNum} WETH => ❌ ${msg}`);
                revertStreak++;
                if (best) declines++; // reverts past the peak also end the search
            }
        }

        if (!best) {
            action = `${dirName}: all simulations reverted`;
            executionState = 'NO_EXECUTABLE_QUOTE';
        } else if (best.profitUSD < prices.gasCostUSD * CONFIG.gasMargin) {
            // Kimi adversary finding: without this gate, every fire at thin depth
            // loses money to gas even when the sim shows on-chain "profit".
            action = `${dirName}: skipped, profit $${best.profitUSD.toFixed(4)} < gas $${prices.gasCostUSD.toFixed(4)} x${CONFIG.gasMargin}`;
            executionState = 'NO_POST_GAS_PROFIT';
            console.log(`  ⛽ ${action}`);
        } else if (process.env.CONFIRM !== 'true') {
            action = `${dirName}: dry-run, best ${best.amountNum} WETH => +${best.profitWETH.toFixed(8)} WETH`;
            executionState = 'PROFITABLE_DRY_RUN';
            console.log('  💡 To execute, run with: CONFIRM=true node scripts/arb-bot-eth.js');
        } else {
            console.log(`  🔥 EXECUTING: ${dirName} ${best.amountNum} WETH...`);
            try {
                const tx = await contract.executeArbitrage(
                    best.amount, direction, minProfit, 0,
                    { gasLimit: CONFIG.gasLimit }
                );
                console.log('  TX Hash:', tx.hash);
                const receipt = await tx.wait();
                console.log(`  ✅ SUCCESS! Block ${receipt.blockNumber}, gas ${receipt.gasUsed}`);
                console.log('  View: https://etherscan.io/tx/' + tx.hash);
                action = `${dirName}: EXECUTED ${best.amountNum} WETH, tx ${tx.hash}`;
                executionState = 'EXECUTED';
            } catch (e) {
                const msg = e.shortMessage || e.reason || e.message.slice(0, 100);
                console.log('  ❌ EXECUTION FAILED:', msg);
                action = `${dirName}: execution failed: ${msg}`;
                executionState = 'EXECUTION_FAILED';
            }
        }
    }

    heartbeat({
        timestamp: ts,
        block: prices.block,
        prices: {
            yesConditional: prices.yesPrice,
            noConditional: prices.noPrice,
            conditionalMid: prices.condMid,
            spot: prices.spotPrice,
        },
        divergence: prices.divergence,
        threshold: CONFIG.divergenceThreshold,
        gasGwei: prices.gasGwei,
        runtimeHealth: 'healthy',
        executionState,
        action,
    });
}

// =============================================================================
// MAIN LOOP
// =============================================================================

async function main() {
    console.log('═'.repeat(70));
    console.log('🤖 ETH/USDS FUTARCHY ARBITRAGE BOT - Ethereum Mainnet');
    console.log('═'.repeat(70));
    console.log('Contract:', CONFIG.contract || '(not set - price-scan-only)');
    console.log('Mode:', process.env.CONFIRM === 'true' ? '🔥 LIVE EXECUTION' : '📊 DRY RUN (simulation)');
    console.log('Threshold:', (CONFIG.divergenceThreshold * 100).toFixed(2) + '%',
        '| Interval:', CONFIG.scanIntervalMs / 1000 + 's');
    console.log('');

    let provider = new ethers.JsonRpcProvider(CONFIG.rpc);
    let network = await provider.getNetwork();
    if (network.chainId !== 1n) {
        console.log(`⚠️ RPC ${CONFIG.rpc} is chain ${network.chainId}, not mainnet - using ${CONFIG.fallbackRpc}`);
        provider = new ethers.JsonRpcProvider(CONFIG.fallbackRpc);
        network = await provider.getNetwork();
        if (network.chainId !== 1n) throw new Error('No mainnet RPC available');
    }

    let contract = null;
    if (CONFIG.contract && process.env.PRIVATE_KEY_ETH) {
        const wallet = new ethers.Wallet(process.env.PRIVATE_KEY_ETH, provider);
        contract = new ethers.Contract(CONFIG.contract, CONTRACT_ABI, wallet);
        console.log('Wallet:', wallet.address);
        console.log('ETH Balance:', ethers.formatEther(await provider.getBalance(wallet.address)), 'ETH');
        console.log('');
    }

    // Scan loop - per-iteration errors are logged, never fatal
    for (;;) {
        try {
            await scanOnce(provider, contract);
        } catch (e) {
            console.log('⚠️ scan error:', e.shortMessage || e.message);
            heartbeat({
                timestamp: new Date().toISOString(),
                runtimeHealth: 'error',
                executionState: 'SCAN_ERROR',
                error: e.shortMessage || e.message,
                action: 'scan-error',
            });
        }
        if (process.env.ONCE === 'true') break;
        await new Promise(r => setTimeout(r, CONFIG.scanIntervalMs));
    }
}

if (require.main === module) {
    main().catch(e => {
        console.error('Fatal error:', e.message);
        process.exit(1);
    });
}

module.exports = { candidateSizeLadder };
