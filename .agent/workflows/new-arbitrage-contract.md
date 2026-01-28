---
description: How to create a new flash arbitrage contract for a Futarchy proposal
---

# 🚀 New Arbitrage Contract Workflow

This workflow documents the complete process for creating a new flash arbitrage contract for a Futarchy proposal.

---

## Phase 1: Discovery & Research

### Step 1: Choose a Proposal
1. Go to the Futarchy platform and select a proposal to arbitrage
2. Note the proposal name/identifier (e.g., "AAVE", "GNO", etc.)

### Step 2: Identify Tokens
Extract the token addresses from the proposal:

| Token Type | Description | Example |
|------------|-------------|---------|
| **CompanyToken** | The governance token of the project | AAVE, GNO |
| **CollateralToken** | Token used as collateral in conditional markets | sDAI, WETH |
| **CurrencyToken** | Base currency for trading | USDC, DAI |

### Step 3: Find Liquidity Sources
Search for liquidity pools between tokens:

1. **Balancer** - Check [balancer.fi](https://balancer.fi) for pools
2. **Swapr** - Check [swapr.eth.limo](https://swapr.eth.limo) for Gnosis Chain pools
3. **Uniswap** - Check Uniswap V3 pools (Mainnet)

Try to swap between **CompanyToken ↔ CurrencyToken** to verify liquidity exists.

### Step 4: Acquire Test Tokens (If Needed)
If you don't have any tokens for testing:

1. Use native tokens (ETH/xDAI) to buy one of the tokens
2. Use Balancer API/Quoter for automatic routing
3. Example: ETH → USDC → CompanyToken

---

## Phase 2: Data Collection

### Step 5: Execute Test Swap
1. Perform a small test swap on Balancer/Swapr
2. Open the transaction on block explorer (Etherscan/Gnosisscan)
3. Go to **Logs** tab

### Step 6: Extract Transaction Data
From the transaction logs, collect:

```
- Pool addresses used
- Token addresses (verify against Step 2)
- Swap selectors and function signatures
- Any router/vault addresses
```

---

## Phase 3: Contract Development

### Step 7: Reference Existing Contracts
Read the most updated Flash Arbitrage contract version:

```bash
# Check existing contracts
ls contracts/

# Key reference files:
# - contracts/AaveFlashArbitrageV2.sol (Mainnet + Aave flash loans)
# - contracts/GnosisFlashArbitrageV4.sol (Gnosis + Balancer flash loans)
```

### Step 8: Reference Documentation
Read the docs for context:

```bash
# Key documentation
cat docs/GUIDE_ARB_BOTS.md
cat docs/BALANCER_V2_ULTIMATE_GUIDE.md
cat docs/BALANCER_V3_ULTIMATE_GUIDE.md
cat docs/UNISWAP_POOL_DISCOVERY.md
cat docs/UNISWAP_SWAP_FLOW.md
```

**Key concepts:**
- Futarchy uses **Uniswap V3 pools** for Conditional YES/NO tokens (Chain 100)
- Flash loan repayment logic can be copied from existing contracts
- Balancer V2 Vault handles flash loans on Gnosis
- Aave V3 handles flash loans on Mainnet

### Step 9: Create New Contract
Prompt AI with:

```
Create a new flash arbitrage contract for [PROPOSAL_NAME]:
- CompanyToken: [ADDRESS]
- CurrencyToken: [ADDRESS]
- CollateralToken: [ADDRESS]

Reference:
- Existing contract: [AaveFlashArbitrageV2.sol or GnosisFlashArbitrageV4.sol]
- Pool addresses from transaction logs: [ADDRESSES]
- Swap flow: [DESCRIBE THE HOPS]

Flash loan repay: Copy pattern from existing contract.
```

---

## Phase 4: Deployment

### Step 10: Update Environment Variables
Add to `.env.example` and `.env`:

```bash
# Add new private key for the proposal
PRIVATE_KEY_COMPANYNAME=your_private_key_here

# Example:
PRIVATE_KEY_AAVE=0x...
PRIVATE_KEY_GNO=0x...
```

### Step 11: Create Deployment Script
// turbo
```bash
# Create deployment script based on existing ones
cp scripts/deployV2.js scripts/deploy_companyname.js
```

Edit the new script with correct:
- Contract name
- Constructor arguments (token addresses, pool addresses)

### Step 12: Deploy Contract
```bash
# Deploy to target network
npx hardhat run scripts/deploy_companyname.js --network mainnet
# OR
npx hardhat run scripts/deploy_companyname.js --network gnosis
```

### Step 13: Verify Contract
```bash
# Verify on block explorer
npx hardhat verify --network mainnet CONTRACT_ADDRESS "arg1" "arg2" ...
```

---

## Phase 5: Bot Development

### Step 14: Create Arbitrage Bot Script
// turbo
```bash
# Copy existing bot as template
cp scripts/arb-bot-aave.js scripts/arb-bot-companyname.js
```

### Step 15: Configure Bot Script
Edit the new bot script:

1. Update contract address
2. Update token addresses
3. Update pool references
4. Adjust profit thresholds
5. Configure RPC endpoints

### Step 16: Update .env with Contract Address
```bash
# Add to .env
COMPANYNAME_ARB_CONTRACT=0x...
```

---

## Phase 6: Testing

### Step 17: Dry Run Test
```bash
# Test without executing (dry run)
node scripts/arb-bot-companyname.js
```

### Step 18: Live Test with Small Amount
```bash
# Execute with confirmation
CONFIRM=true node scripts/arb-bot-companyname.js
```

### Step 19: Monitor & Iterate
- Watch transaction logs
- Adjust parameters based on results
- Add to BOT_MANUAL.md documentation

---

## Quick Reference: File Locations

| Type | Location |
|------|----------|
| Contracts | `contracts/*.sol` |
| Deploy Scripts | `scripts/deploy*.js` |
| Bot Scripts | `scripts/arb-bot-*.js` |
| Documentation | `docs/*.md` |
| Environment | `.env`, `.env.example` |

## Quick Reference: Networks

| Network | Chain ID | Flash Loan Provider |
|---------|----------|---------------------|
| Gnosis | 100 | Balancer V2 Vault |
| Ethereum Mainnet | 1 | Aave V3 Pool |

---

## Checklist

- [ ] Proposal selected
- [ ] Tokens identified (Company, Collateral, Currency)
- [ ] Liquidity verified on DEX
- [ ] Test swap executed
- [ ] Transaction logs collected
- [ ] Contract code written
- [ ] Environment variables added
- [ ] Contract deployed
- [ ] Contract verified
- [ ] Bot script created
- [ ] Dry run successful
- [ ] Live test successful
- [ ] Documentation updated
