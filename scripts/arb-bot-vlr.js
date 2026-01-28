/**
 * VLR Arbitrage Bot - Ethereum Mainnet
 * Uses VLRFlashArbitrageV3 with Universal Router + Permit2
 * 
 * Features:
 * - Scans multiple amounts to find optimal trade size
 * - Calculates NET profit after gas in USD
 * - Uses minProfit protection against MEV
 * - Finds break-even point
 * 
 * Usage:
 *   node scripts/arb-bot-vlr.js                 # Dry run (simulation only)
 *   CONFIRM=true node scripts/arb-bot-vlr.js   # Live execution
 */

const { ethers } = require('ethers');
require('dotenv').config();

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
    rpc: 'https://eth.llamarpc.com',
    contract: '0xe0A988Ccb9b65036Bc7C6E307De6e5518a0F3B62',  // VLRFlashArbitrageV3
    gasLimit: 3000000n,  // CRITICAL: Must be explicit for VLR arb!

    // Amounts to test (in VLR) - 30k is max before liquidity limit
    testAmounts: [1000, 5000, 10000, 20000, 30000],

    // Minimum net profit to execute (in USD)
    minNetProfitUSD: 1.00,

    // Safety margin for minProfit (80% of expected)
    minProfitMargin: 0.80,
};

// Contract addresses
const ADDRESSES = {
    VLR: '0x4e107a0000DB66f0E9Fd2039288Bf811dD1f9c74',
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    QUOTER_V2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
};

// ABIs
const CONTRACT_ABI = [
    'function executeArbitrage(uint256 borrowAmount, uint8 direction, uint256 minProfit, uint256 slippageBps) external returns (tuple(bool success, uint256 profit, uint256 borrowAmount, uint256 gasUsed))',
    'error ArbitrageFailed(uint256 balanceAfter, uint256 required, string reason)'
];

const QUOTER_ABI = [
    'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)'
];

// =============================================================================
// MAIN BOT
// =============================================================================

async function main() {
    console.log('═'.repeat(70));
    console.log('🤖 VLR ARBITRAGE BOT - Ethereum Mainnet');
    console.log('═'.repeat(70));
    console.log('Contract:', CONFIG.contract);
    console.log('Mode:', process.env.CONFIRM === 'true' ? '🔥 LIVE EXECUTION' : '📊 DRY RUN (simulation)');
    console.log('');

    // Setup
    const provider = new ethers.JsonRpcProvider(CONFIG.rpc);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY_VLR, provider);
    const contract = new ethers.Contract(CONFIG.contract, CONTRACT_ABI, wallet);
    const quoter = new ethers.Contract(ADDRESSES.QUOTER_V2, QUOTER_ABI, provider);

    console.log('Wallet:', wallet.address);
    const balance = await provider.getBalance(wallet.address);
    console.log('ETH Balance:', ethers.formatEther(balance), 'ETH');
    console.log('');

    // Get prices
    console.log('📈 Fetching prices...');
    const prices = await getPrices(quoter, provider);
    console.log('  VLR Price:', prices.vlr.toFixed(6), 'USD');
    console.log('  ETH Price:', prices.eth.toFixed(2), 'USD');
    console.log('  Gas Price:', prices.gasGwei.toFixed(4), 'gwei');
    console.log('  Est. Gas Cost:', prices.gasCostUSD.toFixed(4), 'USD');
    console.log('');

    // Scan opportunities
    console.log('🔍 Scanning opportunities...');
    console.log('─'.repeat(70));
    console.log('| Amount VLR  | Gross VLR   | Gross USD   | Gas USD   | NET USD    |');
    console.log('─'.repeat(70));

    let bestOpportunity = null;

    for (const amountNum of CONFIG.testAmounts) {
        const amount = ethers.parseEther(amountNum.toString());

        try {
            // Simulate
            const result = await contract.executeArbitrage.staticCall(
                amount, 0, 0, 0,
                { gasLimit: CONFIG.gasLimit }
            );

            const profitVLR = parseFloat(ethers.formatEther(result.profit));
            const grossUSD = profitVLR * prices.vlr;
            const netUSD = grossUSD - prices.gasCostUSD;
            const profitable = netUSD > 0;

            console.log(
                '| ' + amountNum.toString().padStart(10) +
                '  | ' + profitVLR.toFixed(2).padStart(10) +
                '  | $' + grossUSD.toFixed(4).padStart(9) +
                '  | $' + prices.gasCostUSD.toFixed(2).padStart(6) +
                '  | ' + (netUSD >= 0 ? '+' : '') + '$' + netUSD.toFixed(4).padStart(7) +
                (profitable ? ' ✅' : ' ❌') + ' |'
            );

            if (profitable && netUSD > CONFIG.minNetProfitUSD) {
                if (!bestOpportunity || netUSD > bestOpportunity.netUSD) {
                    bestOpportunity = {
                        amount: amountNum,
                        amountWei: amount,
                        profitVLR,
                        grossUSD,
                        netUSD,
                        result
                    };
                }
            }
        } catch (e) {
            // Try to parse ArbitrageFailed error for better reporting
            let errorMsg = 'REVERT';
            if (e.revert && e.revert.name === 'ArbitrageFailed') {
                const balanceAfter = parseFloat(ethers.formatEther(e.revert.args[0]));
                const required = parseFloat(ethers.formatEther(e.revert.args[1]));
                const reason = e.revert.args[2];
                const loss = required - balanceAfter;
                const lossPct = (loss / required * 100).toFixed(2);
                const lossUSD = loss * prices.vlr;

                console.log(
                    '| ' + amountNum.toString().padStart(10) +
                    '  | ' + ('-' + loss.toFixed(2)).padStart(10) +
                    '  | -$' + lossUSD.toFixed(4).padStart(8) +
                    '  | (no arb)  | ' + reason.slice(0, 15).padStart(7) + ' ❌ |'
                );
            } else {
                console.log(
                    '| ' + amountNum.toString().padStart(10) +
                    '  | ' + 'ERROR'.padStart(10) +
                    '  | ' + (e.shortMessage || e.reason || 'REVERT').slice(0, 30).padStart(40) + ' |'
                );
            }
        }
    }

    console.log('─'.repeat(70));

    // Calculate break-even
    const breakEvenVLR = Math.ceil(prices.gasCostUSD / (0.0135 * prices.vlr));  // Assume ~1.35% profit
    console.log('');
    console.log('📊 Break-even: ~' + breakEvenVLR.toLocaleString() + ' VLR (at 1.35% profit)');

    // Report best opportunity
    console.log('');
    if (bestOpportunity) {
        console.log('═'.repeat(70));
        console.log('🎯 BEST OPPORTUNITY FOUND');
        console.log('═'.repeat(70));
        console.log('  Amount:', bestOpportunity.amount.toLocaleString(), 'VLR');
        console.log('  Gross Profit:', bestOpportunity.profitVLR.toFixed(4), 'VLR = $' + bestOpportunity.grossUSD.toFixed(4));
        console.log('  Gas Cost:', '$' + prices.gasCostUSD.toFixed(4));
        console.log('  NET PROFIT:', '$' + bestOpportunity.netUSD.toFixed(4));
        console.log('');

        if (process.env.CONFIRM === 'true') {
            console.log('🔥 EXECUTING LIVE TRANSACTION...');

            // Calculate safe minProfit (80% of expected)
            const safeMinProfit = ethers.parseEther(
                (bestOpportunity.profitVLR * CONFIG.minProfitMargin).toFixed(18)
            );

            console.log('  Min Profit (safety):', ethers.formatEther(safeMinProfit), 'VLR');

            try {
                const tx = await contract.executeArbitrage(
                    bestOpportunity.amountWei,
                    0,  // SPOT_SPLIT
                    safeMinProfit,
                    0,
                    { gasLimit: CONFIG.gasLimit }
                );

                console.log('  TX Hash:', tx.hash);
                console.log('  Waiting for confirmation...');

                const receipt = await tx.wait();
                console.log('');
                console.log('✅ SUCCESS! Block:', receipt.blockNumber);
                console.log('  Gas used:', receipt.gasUsed.toString());
                console.log('  View: https://etherscan.io/tx/' + tx.hash);

            } catch (e) {
                console.log('❌ EXECUTION FAILED:', e.shortMessage || e.reason || e.message.slice(0, 100));
            }
        } else {
            console.log('💡 To execute, run with: CONFIRM=true node scripts/arb-bot-vlr.js');
        }
    } else {
        console.log('═'.repeat(70));
        console.log('❌ NO PROFITABLE OPPORTUNITY');
        console.log('═'.repeat(70));
        console.log('  Min required net profit: $' + CONFIG.minNetProfitUSD.toFixed(2));
        console.log('  Try larger amounts or wait for better prices.');
    }

    console.log('');
}

// =============================================================================
// HELPERS
// =============================================================================

async function getPrices(quoter, provider) {
    // VLR/USDC price
    const vlrQuote = await quoter.quoteExactInputSingle.staticCall({
        tokenIn: ADDRESSES.VLR,
        tokenOut: ADDRESSES.USDC,
        amountIn: ethers.parseEther('10000'),  // Use 10k for better accuracy
        fee: 3000,
        sqrtPriceLimitX96: 0
    });
    const vlrPrice = parseFloat(ethers.formatUnits(vlrQuote.amountOut, 6)) / 10000;

    // ETH/USDC price
    const ethQuote = await quoter.quoteExactInputSingle.staticCall({
        tokenIn: ADDRESSES.WETH,
        tokenOut: ADDRESSES.USDC,
        amountIn: ethers.parseEther('1'),
        fee: 500,
        sqrtPriceLimitX96: 0
    });
    const ethPrice = parseFloat(ethers.formatUnits(ethQuote.amountOut, 6));

    // Gas price
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice;
    const gasGwei = parseFloat(ethers.formatUnits(gasPrice, 'gwei'));

    // Estimated gas cost (1.3M gas for VLR arb - verified on mainnet!)
    const estimatedGas = 1300000n;
    const gasCostETH = parseFloat(ethers.formatEther(gasPrice * estimatedGas));
    const gasCostUSD = gasCostETH * ethPrice;

    return { vlr: vlrPrice, eth: ethPrice, gasGwei, gasCostETH, gasCostUSD };
}

// =============================================================================
// RUN
// =============================================================================

main().catch(e => {
    console.error('Fatal error:', e.message);
    process.exit(1);
});
