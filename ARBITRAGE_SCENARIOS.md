# Futarchy Flash Arbitrage - Test Scenarios

## Current Market Prices (from debug-spot.js)
- **GNO SPOT**: 112.20 sDAI/GNO (from Balancer WAGNO/sDAI pool)
- **YES Pool**: 115.26 sDAI per YES_GNO  
- **NO Pool**: 115.26 sDAI per NO_GNO

---

## SCENARIO 1: SPOT_SPLIT (Profitable when outcome prices > spot)

**Condition**: YES_GNO price + NO_GNO price > SPOT price (after selling)
**Current**: 115.26 > 112.20 ✅ **~2.7% edge**

### Flow (Borrow GNO):

```
Step | Action                           | Token In       | Token Out      | Amount
-----|----------------------------------|----------------|----------------|--------
1    | Flash loan GNO                   | -              | GNO            | 100 GNO
2    | Split GNO → YES_GNO + NO_GNO     | 100 GNO        | 100 YES_GNO    | 
     |                                  |                | 100 NO_GNO     |
3    | Swap YES_GNO → YES_SDAI          | 100 YES_GNO    | ~11,526 YES_SDAI|
4    | Swap NO_GNO → NO_SDAI            | 100 NO_GNO     | ~11,526 NO_SDAI |
5    | Merge YES_SDAI + NO_SDAI → sDAI  | 11,526 YES_SDAI| 11,526 sDAI    |
     |                                  | 11,526 NO_SDAI |                |
6    | Swap sDAI → GNO (for repay)      | 11,220 sDAI    | ~100 GNO       |
7    | Repay flash loan                 | 100 GNO        | -              |
-----|----------------------------------|----------------|----------------|--------
     | PROFIT                           |                | ~306 sDAI      | 2.7%
```

### Contract Calls:
```solidity
// executeProposalArbitrage(proposal, GNO, amount, SPOT_SPLIT, minProfit)
contract.executeProposalArbitrage(
    "0x45e1064348fD8A407D6D1F59Fc64B05F633b28FC",  // proposal
    "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb",  // GNO (borrow token)
    ethers.parseEther("100"),                       // 100 GNO
    2,                                              // ArbitrageDirection.SPOT_SPLIT
    ethers.parseEther("200")                        // min profit 200 sDAI
);
```

### Internal Function Calls:
1. `futarchyRouter.splitPosition(proposal, GNO, 100e18)`
2. `swaprRouter.exactInputSingle({tokenIn: YES_GNO, tokenOut: YES_SDAI, ...})`
3. `swaprRouter.exactInputSingle({tokenIn: NO_GNO, tokenOut: NO_SDAI, ...})`
4. `futarchyRouter.mergePositions(proposal, sDAI, 11526e18)` ← **CRITICAL**
5. `balancerVault.swap({sDAI → GNO})` ← **MISSING IN CONTRACT**

---

## SCENARIO 2: MERGE_SPOT (Profitable when outcome prices < spot)

**Condition**: SPOT price > YES_GNO price + NO_GNO price (when buying)
**Current**: NOT profitable (spot 112.20 < combined ~230)

### Flow (If it were profitable):

```
Step | Action                           | Token In       | Token Out      
-----|----------------------------------|----------------|----------------
1    | Flash loan sDAI                  | -              | 10,000 sDAI    
2    | Split sDAI → YES_SDAI + NO_SDAI  | 10,000 sDAI    | 10k each       
3    | Swap YES_SDAI → YES_GNO          | 5,000 YES_SDAI | ~43 YES_GNO    
4    | Swap NO_SDAI → NO_GNO            | 5,000 NO_SDAI  | ~43 NO_GNO     
5    | Merge YES_GNO + NO_GNO → GNO     | 43 each        | 43 GNO         
6    | Sell GNO at spot for sDAI        | 43 GNO         | ~4,825 sDAI    
7    | Repay flash loan                 | 10,000 sDAI    | -              
-----|----------------------------------|----------------|----------------
     | RESULT                           |                | LOSS (need >10k)
```

**Not profitable in current market conditions.**

---

## SCENARIO 3: YES_TO_NO (Cross-pool arbitrage)

**Condition**: YES pool price significantly different from NO pool price

### Current Prices:
- YES: 115.26 sDAI/YES_GNO
- NO:  115.26 sDAI/NO_GNO
- Spread: 0% → **NOT profitable**

### If YES was 120 and NO was 110:
```
Step | Action                           | Result
-----|----------------------------------|--------
1    | Borrow YES_SDAI                  | 
2    | Buy YES_GNO cheap (120 rate)     | Get YES_GNO
3    | Merge YES_GNO + NO_GNO → GNO     | Need matching NO_GNO
     | ... This doesn't work directly   |
```

**This strategy needs more thought - pools are isolated.**

---

## MISSING CONTRACT FUNCTIONALITY

### 1. sDAI → GNO Swap (for SPOT_SPLIT repayment)
```solidity
function _swapSdaiToGno(uint256 sdaiAmount) internal returns (uint256 gnoOut) {
    // Option A: Use Algebra GNO/sDAI pool if exists
    // Option B: Use Balancer WAGNO/sDAI pool (requires WAGNO wrapping)
}
```

### 2. sDAI Split (for MERGE_SPOT)
```solidity
// Need to split sDAI into YES_SDAI + NO_SDAI before buying GNO tokens
futarchyRouter.splitPosition(proposal, sDAI, amount);
```

---

## RECOMMENDED TEST ORDER

1. **Test `loadProposal()`** - Verify tokens are discovered correctly
2. **Test `splitPosition()`** - Can we split GNO into outcome tokens?
3. **Test pool swaps** - Can we swap YES_GNO → YES_SDAI?
4. **Test `mergePositions()`** - Can we merge YES_SDAI + NO_SDAI?
5. **Test full SPOT_SPLIT flow** - End to end with static call

---

## QUICK WIN: Simplest Profitable Trade

Given spot = 112.20 and outcome = 115.26:

```
1. Have 1 GNO in wallet
2. Split → 1 YES_GNO + 1 NO_GNO
3. Sell YES_GNO for ~115.26 YES_SDAI
4. Sell NO_GNO for ~115.26 NO_SDAI  
5. Merge → 115.26 real sDAI
6. Buy back GNO at spot → costs 112.20 sDAI
7. Profit: 3.06 sDAI per GNO (~2.7%)
```

No flash loan needed for this test - just needs GNO in wallet!
