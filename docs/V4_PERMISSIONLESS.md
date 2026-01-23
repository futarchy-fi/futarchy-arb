# 🔓 V4 Permissionless Upgrade

> **Status**: DEPLOYED & VERIFIED ✅  
> **Contract**: `GnosisFlashArbitrageV4`  
> **Address**: [`0x0ECD7369cFe4CD2f35b47B3c66e32AaC2016B25a`](https://gnosisscan.io/address/0x0ECD7369cFe4CD2f35b47B3c66e32AaC2016B25a#code)  
> **Network**: Gnosis Chain  
> **Deployed**: 2026-01-23

---

## 🚀 What Changed?

**V4 is fully PERMISSIONLESS** - anyone can execute arbitrage!

| Feature | V3 (Old) | V4 (New) |
|---------|----------|----------|
| Access Control | `onlyOwner` | **None** - Open to all |
| Inheritance | `Ownable`, `ReentrancyGuard` | `ReentrancyGuard` only |
| Who can call | Contract owner only | **Anyone** |
| Profit recipient | Caller | Caller |
| Admin functions | Owner recovers tokens | Admin recovers tokens (emergency only) |

---

## 📋 Contract Addresses

| Version | Address | Status |
|---------|---------|--------|
| V4 (PERMISSIONLESS) | `0x0ECD7369cFe4CD2f35b47B3c66e32AaC2016B25a` | ✅ **ACTIVE** |
| V3 (Owner-Only) | `0xe0545480aAB67Bc855806b1f64486F5c77F08eCC` | Deprecated |
| Legacy (Broken) | `0x5649CA18945a8cf36945aA2674f74db3634157cC` | Deprecated |

---

## 🔐 Security Model

### What Was Removed
```solidity
// V3 - Required owner
function executeArbitrage(...) external onlyOwner nonReentrant { ... }

// V4 - Anyone can call
function executeArbitrage(...) external nonReentrant { ... }
```

### What Remains Protected

| Protection | Still Active | Purpose |
|------------|--------------|---------|
| `nonReentrant` | ✅ | Prevents reentrancy attacks |
| Flash loan repayment check | ✅ | `require(balance >= borrowAmount)` |
| Minimum profit check | ✅ | `require(profit >= minProfit)` |
| Vault callback validation | ✅ | `require(msg.sender == balancerVault)` |

### Why It's Safe

1. **Profits go to caller** - The `msg.sender` receives all profits
2. **No stored funds** - Contract holds no assets between calls
3. **Flash loan must repay** - Failed arbs just revert, no loss
4. **Stateless execution** - Each call is independent

---

## 📖 Usage

### Execute Arbitrage (Anyone Can Call!)

```javascript
const { ethers } = require("hardhat");

// Connect to V4 contract
const contract = await ethers.getContractAt(
    "GnosisFlashArbitrageV4",
    "0x0ECD7369cFe4CD2f35b47B3c66e32AaC2016B25a",
    signer
);

// SPOT_SPLIT: Borrow GNO → Split → Sell outcomes → Merge sDAI → Swap back
await contract.executeArbitrage(
    "0x45e1064348fD8A407D6D1F59Fc64B05F633b28FC",  // proposal
    "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb",  // borrow GNO
    ethers.parseEther("1"),  // amount
    0,  // SPOT_SPLIT
    ethers.parseEther("0.001")  // min profit
);

// MERGE_SPOT: Borrow sDAI → Split → Buy outcomes → Merge GNO → Swap back
await contract.executeArbitrage(
    "0x45e1064348fD8A407D6D1F59Fc64B05F633b28FC",  // proposal
    "0xaf204776c7245bF4147c2612BF6e5972Ee483701",  // borrow sDAI
    ethers.parseEther("100"),  // amount
    1,  // MERGE_SPOT
    ethers.parseEther("1")  // min profit
);
```

### Run the Bot

```bash
# Dry run (simulation only)
npx hardhat run scripts/arb-bot.js --network gnosis

# Live execution
CONFIRM=true npx hardhat run scripts/arb-bot.js --network gnosis
```

### Check Opportunities

```bash
npx hardhat run scripts/check-opportunities.js --network gnosis
```

---

## 🛠️ Admin Functions (Emergency Only)

The admin role exists **only** for emergency token recovery:

```solidity
// Transfer admin (for hand-off)
function transferAdmin(address newAdmin) external;

// Recover stuck tokens
function recoverTokens(address token, uint256 amount) external;
```

> ⚠️ **Note**: Admin has NO power over arbitrage execution. Anyone can still call `executeArbitrage()`.

---

## 📁 Files Updated

The following files were updated to use V4:

| File | Change |
|------|--------|
| `contracts/GnosisFlashArbitrageV4.sol` | **NEW** - Permissionless contract |
| `scripts/deployV4.js` | **NEW** - Deployment script |
| `scripts/arb-bot.js` | Updated contract address & name |
| `scripts/check-opportunities.js` | Updated contract address & name |
| `scripts/safe-execute.js` | Updated contract address & name |
| `scripts/find-arb.js` | Updated contract address & name |
| `README.md` | Added V4 to contract versions |
| `USAGE_GUIDE.md` | Updated header with V4 address |
| `last_deployment.txt` | Contains V4 address |

---

## 🔍 Verification

Contract verified on GnosisScan:
- **URL**: https://gnosisscan.io/address/0x0ECD7369cFe4CD2f35b47B3c66e32AaC2016B25a#code

### Verification Command (Reference)
```bash
npx hardhat verify --network gnosis 0x0ECD7369cFe4CD2f35b47B3c66e32AaC2016B25a \
  "0xbA1333333333a1BA1108E8412f11850A5C319bA9" \
  "0xBA12222222228d8Ba445958a75a0704d566BF2C8" \
  "0xfFB643E73f280B97809A8b41f7232AB401a04ee1" \
  "0x7495a583ba85875d59407781b4958ED6e0E1228f" \
  "0xA0864cCA6E114013AB0e27cbd5B6f4c8947da766" \
  "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb" \
  "0xaf204776c7245bF4147c2612BF6e5972Ee483701"
```

---

## 🎉 Benefits

1. **No wallet restrictions** - Use any wallet to execute arbs
2. **Public utility** - Contract is a tool for the community
3. **Same security** - All critical checks remain in place
4. **Lower gas** - Removed Ownable storage/checks

---

*Deployed: 2026-01-23*  
*Contract: GnosisFlashArbitrageV4*  
*Network: Gnosis Chain (ID: 100)*
