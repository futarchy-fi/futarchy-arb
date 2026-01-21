# Contract Versions: Legacy vs New

This document tracks the deployed versions of the `GnosisFlashArbitrageV3` contract and explains the major architectural differences between the "Legacy" implementation and the current "New" integration.

## 🚀 Current Active Contract (V2 Integrated)

| Property | Value |
| :--- | :--- |
| **Address** | `0xe0545480aAB67Bc855806b1f64486F5c77F08eCC` |
| **Network** | Gnosis Chain (100) |
| **Deployed On** | 2026-01-21 |
| **Status** | ✅ **Active / Recommended** |

### Major Changes & Features
This version introduces a **Hybrid Vault Architecture** to solve liquidity issues during loan repayment:

1.  **Dual Vault System**:
    *   **Balancer V3 Vault** (`0xba13...ba9`): Used exclusively for the **Flash Loan** (borrowing funds).
    *   **Balancer V2 Vault** (`0xba12...2c8`): Used for **Swaps** (converting tokens).

2.  **Repayment Routing (The Fix)**:
    *   **Problem**: The V3 Vault has low/zero liquidity for GNO/sDAI on Gnosis Chain, making it impossible to swap back profitably to repay the loan using V3 pools.
    *   **Solution**: We integrated Balancer V2 `batchSwap` logic directly into the contract.
    *   **Path**: The contract uses a multi-hop path via V2 pools: `GNO` ↔ `WXDAI` ↔ `USDC` ↔ `sDAI`.

3.  **Why this matters**:
    *   This allows the arbitrage to actually **complete**. Legacy versions would revert on the final swap step due to "Input/Output" errors (lack of liquidity) in V3.

---

## ⚠️ Legacy Contract (Pure V3)

| Property | Value |
| :--- | :--- |
| **Address** | `0x5649CA18945a8cf36945aA2674f74db3634157cC` |
| **Status** | ❌ **Deprecated** (Functional Flash Loan, Broken Repayment) |

### Limitations
*   Uses Balancer V3 for *both* Flash Loans and Swaps.
*   **Critical Failure**: Cannot swap `sDAI` back to `GNO` (or vice-versa) because the V3 pools on Gnosis lack sufficient liquidity.
*   **Use Case**: Only useful for testing the Flash Loan callback mechanism itself, not for executing full arbitrage cycles.

---

## Technical Reference

### Balancer V2 Integration Details
For the "New" contract, the following V2 Pools are hardcoded for the swap path:

*   **GNO / WXDAI**: `0x8189c4c96826d016a99986394103dfa9ae41e7ee0002000000000000000000aa`
*   **WXDAI / USDC**: `0x2086f52651837600180de173b09470f54ef7491000000000000000000000004f`
*   **USDC / sDAI**: `0x7644fa5d0ea14fcf3e813fdf93ca9544f8567655000000000000000000000066`

### Usage Switch
To switch between versions in your scripts, update `CONFIG.CONTRACT` (or equivalent) in:
- `scripts/execute-real.js`
- `scripts/check-opportunities.js`
- `scripts/check-opportunities.js`

## ⛽ Gas Usage & Limits

**Important:** The "New" contract requires significantly higher gas limits than the Legacy version.

*   **Reason:** The V2 Swap path is **multi-hop** (`GNO` → `WXDAI` → `USDC` → `sDAI`). Each hop incurs gas for:
    *   Pool state updates in multiple Balancer V2 pools.
    *   Token transfers for each intermediate step (`WXDAI`, `USDC`).
    *   Balancer V2 Vault overhead.
*   **Recommendation:** Set `gasLimit` to **3,500,000** for arbitrage execution.
*   **Observation:** Actual usage is ~1.5M+, so 3.5M provides a safe buffer against "Out of Gas" failures. Legacy single-hop swaps were much cheaper but failed due to liquidity.
*   **Troubleshooting:** If the transaction fails with `revert FailedInnerCall` (Address.sol) inside the Vault's `unlock` callback, this is often a symptom of **Out of Gas** in the internal execution. The Vault catches the OOG revert and re-throws it as a generic inner call failure. Increasing the gas limit resolves this.
