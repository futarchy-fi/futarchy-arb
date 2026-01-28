/**
 * CoW Swap: USDS → VLR
 * 
 * Uses CoW Protocol SDK to find the best route and execute swap.
 * This is useful for discovering liquidity paths between tokens.
 * 
 * Usage: 
 *   node swap-usds-vlr.js quote     # Get quote only
 *   node swap-usds-vlr.js execute   # Execute the swap
 */

require('dotenv').config({ path: '../../.env' });
const { OrderBookApi, SupportedChainId, OrderQuoteSideKindSell } = require('@cowprotocol/cow-sdk');
const { ethers } = require('ethers');

// ============================================================================
// CONFIGURATION
// ============================================================================

const RPC_URL = process.env.MAINNET_RPC_URL || 'https://ethereum.publicnode.com';
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// Token Addresses (Mainnet)
const USDS = '0xdC035D45d973E3EC169d2276DDab16f1e407384F';
const VLR = '0x4e107a0000DB66f0E9Fd2039288Bf811dD1f9c74';

// Trade parameters
const SELL_AMOUNT = '10';  // 10 USDS

// CoW Protocol Vault Relayer (approval target)
const COW_VAULT_RELAYER = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110';

// CoW Settlement Contract (domain separator)
const COW_SETTLEMENT = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41';

// ============================================================================
// ABIs
// ============================================================================

const ERC20_ABI = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address account) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function name() view returns (string)'
];

// ============================================================================
// HELPERS
// ============================================================================

async function getTokenInfo(contract) {
    const [symbol, name, decimals] = await Promise.all([
        contract.symbol(),
        contract.name(),
        contract.decimals()
    ]);
    return { symbol, name, decimals };
}

// EIP-712 Domain for CoW Protocol
function getDomain(chainId) {
    return {
        name: 'Gnosis Protocol',
        version: 'v2',
        chainId: chainId,
        verifyingContract: COW_SETTLEMENT
    };
}

// EIP-712 Order type
const ORDER_TYPE = {
    Order: [
        { name: 'sellToken', type: 'address' },
        { name: 'buyToken', type: 'address' },
        { name: 'receiver', type: 'address' },
        { name: 'sellAmount', type: 'uint256' },
        { name: 'buyAmount', type: 'uint256' },
        { name: 'validTo', type: 'uint32' },
        { name: 'appData', type: 'bytes32' },
        { name: 'feeAmount', type: 'uint256' },
        { name: 'kind', type: 'string' },
        { name: 'partiallyFillable', type: 'bool' },
        { name: 'sellTokenBalance', type: 'string' },
        { name: 'buyTokenBalance', type: 'string' }
    ]
};

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    const mode = process.argv[2] || 'quote';

    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║  CoW Swap: USDS → VLR                                          ║');
    console.log('╚════════════════════════════════════════════════════════════════╝\n');

    if (!PRIVATE_KEY) {
        console.log('❌ PRIVATE_KEY required in .env file');
        process.exit(1);
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const userAddress = await wallet.getAddress();

    console.log(`👤 Wallet: ${userAddress}`);
    console.log(`🔗 RPC: ${RPC_URL}`);
    console.log(`📋 Mode: ${mode.toUpperCase()}\n`);

    // Setup token contracts
    const usds = new ethers.Contract(USDS, ERC20_ABI, provider);
    const vlr = new ethers.Contract(VLR, ERC20_ABI, provider);

    const usdsInfo = await getTokenInfo(usds);
    const vlrInfo = await getTokenInfo(vlr);

    console.log(`💰 Sell Token: ${usdsInfo.symbol} (${usdsInfo.name})`);
    console.log(`🎯 Buy Token: ${vlrInfo.symbol} (${vlrInfo.name})`);

    // Check balances
    const usdsBalance = await usds.balanceOf(userAddress);
    const vlrBalanceBefore = await vlr.balanceOf(userAddress);
    const sellAmount = ethers.parseUnits(SELL_AMOUNT, usdsInfo.decimals);

    console.log(`\n📊 Balances:`);
    console.log(`   USDS: ${ethers.formatUnits(usdsBalance, usdsInfo.decimals)}`);
    console.log(`   VLR:  ${ethers.formatUnits(vlrBalanceBefore, vlrInfo.decimals)}`);
    console.log(`   Trade: ${SELL_AMOUNT} USDS → VLR\n`);

    if (usdsBalance < sellAmount) {
        console.log(`❌ Insufficient USDS balance`);
        process.exit(1);
    }

    // =========================================================================
    // STEP 1: GET QUOTE FROM CoW PROTOCOL
    // =========================================================================
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📈 STEP 1: Getting Quote from CoW Protocol...');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const orderBookApi = new OrderBookApi({ chainId: SupportedChainId.MAINNET });

    const quoteRequest = {
        sellToken: USDS,
        buyToken: VLR,
        from: userAddress,
        receiver: userAddress,
        sellAmountBeforeFee: sellAmount.toString(),
        kind: OrderQuoteSideKindSell.SELL
    };

    console.log('   Requesting quote...');

    let quote;
    try {
        quote = await orderBookApi.getQuote(quoteRequest);
        console.log('   ✅ Quote received!\n');
    } catch (error) {
        console.log(`   ❌ Quote failed: ${error.message}`);
        if (error.body) {
            console.log(`   Details: ${JSON.stringify(error.body)}`);
        }
        process.exit(1);
    }

    // Parse quote
    const buyAmount = BigInt(quote.quote.buyAmount);
    const feeAmount = BigInt(quote.quote.feeAmount);
    const sellAmountAfterFee = sellAmount - feeAmount;

    console.log('📋 Quote Details:');
    console.log(`   Sell:     ${ethers.formatUnits(sellAmount, usdsInfo.decimals)} ${usdsInfo.symbol}`);
    console.log(`   Fee:      ${ethers.formatUnits(feeAmount, usdsInfo.decimals)} ${usdsInfo.symbol}`);
    console.log(`   Net Sell: ${ethers.formatUnits(sellAmountAfterFee, usdsInfo.decimals)} ${usdsInfo.symbol}`);
    console.log(`   Receive:  ${ethers.formatUnits(buyAmount, vlrInfo.decimals)} ${vlrInfo.symbol}`);

    // Calculate exchange rate
    const rate = Number(ethers.formatUnits(buyAmount, vlrInfo.decimals)) /
        Number(ethers.formatUnits(sellAmountAfterFee, usdsInfo.decimals));
    console.log(`   Rate:     1 USDS = ${rate.toFixed(6)} VLR`);
    console.log(`   Quote ID: ${quote.id}`);
    console.log(`   Valid Until: ${new Date(Number(quote.quote.validTo) * 1000).toISOString()}`);

    if (mode === 'quote') {
        console.log('\n✅ Quote complete. Run with "execute" to place order.');
        process.exit(0);
    }

    // =========================================================================
    // STEP 2: CHECK & SET APPROVAL
    // =========================================================================
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔐 STEP 2: Checking Approval...');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const allowance = await usds.allowance(userAddress, COW_VAULT_RELAYER);
    console.log(`   Current allowance: ${ethers.formatUnits(allowance, usdsInfo.decimals)} USDS`);

    if (allowance < sellAmount) {
        console.log('   📝 Approving USDS to CoW Vault Relayer...');
        const usdsWithSigner = new ethers.Contract(USDS, ERC20_ABI, wallet);
        const approveTx = await usdsWithSigner.approve(COW_VAULT_RELAYER, ethers.MaxUint256);
        console.log(`   TX: ${approveTx.hash}`);
        await approveTx.wait();
        console.log('   ✅ Approved!');
    } else {
        console.log('   ✅ Already approved');
    }

    // =========================================================================
    // STEP 3: SIGN AND SUBMIT ORDER (using native ethers EIP-712)
    // =========================================================================
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✍️ STEP 3: Signing and Submitting Order...');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Build order for signing
    const orderData = {
        sellToken: quote.quote.sellToken,
        buyToken: quote.quote.buyToken,
        receiver: quote.quote.receiver || userAddress,
        sellAmount: quote.quote.sellAmount,
        buyAmount: quote.quote.buyAmount,
        validTo: quote.quote.validTo,
        appData: quote.quote.appData,
        feeAmount: '0',  // CoW Protocol now requires zero fee in order
        kind: quote.quote.kind,
        partiallyFillable: quote.quote.partiallyFillable || false,
        sellTokenBalance: quote.quote.sellTokenBalance || 'erc20',
        buyTokenBalance: quote.quote.buyTokenBalance || 'erc20'
    };

    console.log('   Signing order with EIP-712...');

    // Sign with EIP-712
    const domain = getDomain(1); // Mainnet
    const signature = await wallet.signTypedData(domain, ORDER_TYPE, orderData);

    console.log(`   ✅ Signature: ${signature.slice(0, 20)}...`);

    // Submit the order
    console.log('   Submitting to CoW Protocol...');

    try {
        const orderToSubmit = {
            ...orderData,
            signature: signature,
            signingScheme: 'eip712'
        };

        const orderId = await orderBookApi.sendOrder(orderToSubmit);

        console.log(`   ✅ Order submitted!`);
        console.log(`   Order ID: ${orderId}`);
        console.log(`   Explorer: https://explorer.cow.fi/orders/${orderId}`);

        // =========================================================================
        // STEP 4: MONITOR ORDER
        // =========================================================================
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('⏳ STEP 4: Monitoring Order...');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        console.log('   Waiting for order to be filled (checking every 10s)...');
        console.log('   Press Ctrl+C to exit monitoring.\n');

        let filled = false;
        let attempts = 0;
        const maxAttempts = 30;  // 5 minutes max

        while (!filled && attempts < maxAttempts) {
            attempts++;
            await new Promise(r => setTimeout(r, 10000));

            try {
                const orderStatus = await orderBookApi.getOrder(orderId);
                console.log(`   [${attempts}] Status: ${orderStatus.status}`);

                if (orderStatus.status === 'fulfilled') {
                    filled = true;
                    console.log('\n🎉 ORDER FILLED!');

                    const vlrBalanceAfter = await vlr.balanceOf(userAddress);
                    const received = vlrBalanceAfter - vlrBalanceBefore;

                    console.log(`\n   Sold:     ${SELL_AMOUNT} USDS`);
                    console.log(`   Received: ${ethers.formatUnits(received, vlrInfo.decimals)} VLR`);
                    console.log(`   New VLR Balance: ${ethers.formatUnits(vlrBalanceAfter, vlrInfo.decimals)}`);
                } else if (orderStatus.status === 'cancelled' || orderStatus.status === 'expired') {
                    console.log(`\n❌ Order ${orderStatus.status}`);
                    break;
                }
            } catch (e) {
                console.log(`   [${attempts}] Error checking: ${e.message}`);
            }
        }

        if (!filled && attempts >= maxAttempts) {
            console.log('\n⚠️ Monitoring timeout. Check order on explorer.');
        }

    } catch (error) {
        console.log(`   ❌ Order submission failed: ${error.message}`);
        if (error.body) {
            console.log(`   Details: ${JSON.stringify(error.body)}`);
        }
        process.exit(1);
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ Error:', error.message);
        process.exit(1);
    });
