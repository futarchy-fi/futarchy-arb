# Flash Loan Arbitrage - Gnosis Chain

Flash loan arbitrage contract for Gnosis Chain integrating:
- **Balancer V3** - Flash loans and swaps (WAGNO/sDAI pool)
- **Swapr Algebra V3** - Concentrated liquidity AMM swaps
- **Futarchy** - Conditional YES/NO token split/merge operations

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy and configure environment
cp .env.example .env
# Edit .env with your private key and API keys

# 3. Compile contracts
npm run compile

# 4. Deploy to Gnosis Chain
npm run deploy

# 5. Verify contract
npm run verify <CONTRACT_ADDRESS> <CONSTRUCTOR_ARGS...>
```

## Contract Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    GnosisFlashArbitrage                         │
├─────────────────────────────────────────────────────────────────┤
│  Flash Loan Provider: Balancer V3 Vault                        │
│  DEX 1: Balancer V3 Pool (WAGNO/sDAI)                          │
│  DEX 2: Swapr Algebra V3 Router                                 │
│  Conditional Tokens: Futarchy Router                            │
└─────────────────────────────────────────────────────────────────┘

Arbitrage Flow:
1. Borrow tokens via Balancer flash loan (no fee)
2. Execute swaps between protocols
3. Repay flash loan
4. Keep profit
```

## Arbitrage Types

| Type | Description |
|------|-------------|
| `BALANCER_TO_SWAPR` | Buy on Balancer, sell on Swapr |
| `SWAPR_TO_BALANCER` | Buy on Swapr, sell on Balancer |
| `FUTARCHY_MERGE` | Buy YES+NO tokens, merge to collateral |
| `FUTARCHY_SPLIT` | Split collateral to YES+NO, sell separately |

## Contract Addresses (Gnosis Chain)

| Contract | Address |
|----------|---------|
| Balancer Vault | `0xBA12222222228d8Ba445958a75a0704d566BF2C8` |
| Swapr Router | `0x9C162F975Ad0497d321aDAE092e273481357E545` |
| Futarchy Router | `0x7495a583ba85875d59407781b4958ED6e0E1228f` |
| GNO Token | `0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb` |
| sDAI Token | `0xaf204776c7245bF4147c2612BF6e5972Ee483701` |
| WAGNO Token | `0x7c16f0185a26db0ae7a9377f23bc18ea7ce5d644` |

## Usage Example

```javascript
// Execute Balancer -> Swapr arbitrage
await contract.executeArbitrage(
    sdaiAddress,        // Token to borrow
    ethers.parseEther("1000"),  // Amount to borrow
    0,                  // ArbitrageType.BALANCER_TO_SWAPR
    ethers.ZeroAddress, // No proposal for DEX arb
    ethers.parseEther("1")  // Minimum 1 sDAI profit
);
```

## Verification

The contract uses Gnosisscan (Etherscan v2 compatible):

```bash
npx hardhat verify --network gnosis <CONTRACT_ADDRESS> \
  "0xBA12222222228d8Ba445958a75a0704d566BF2C8" \
  "0x9C162F975Ad0497d321aDAE092e273481357E545" \
  "0x7495a583ba85875d59407781b4958ED6e0E1228f" \
  "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb" \
  "0xaf204776c7245bF4147c2612BF6e5972Ee483701" \
  "0x7c16f0185a26db0ae7a9377f23bc18ea7ce5d644" \
  "0x0000000000000000000000000000000000000000000000000000000000000000"
```

## Security Considerations

- Any address can execute arbitrage; profits are returned to the caller
- Owner-only access remains for administrative actions and fund recovery
- Reentrancy protection on all state-changing functions
- Flash loan callback validates caller is Balancer Vault
- Minimum profit requirement prevents dust attacks

## License

MIT

## Contract Versions

For a detailed breakdown of the Legacy vs New contract architecture, see [CONTRACTS.md](./docs/CONTRACTS.md).

- **Legacy (V3-only)**: `0x5649CA18945a8cf36945aA2674f74db3634157cC` (Deprecated - broken repayment)
- **Active (V2-integrated)**: `0xe0545480aAB67Bc855806b1f64486F5c77F08eCC` (Recommended - fixes repayment via V2 batchSwap)
