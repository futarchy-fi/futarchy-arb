# The Saga of Aave Flash Arbitrage V6

## Executive Summary
The development of the Aave Flash Arbitrage bot evolved through 6 versions, overcoming major technical hurdles related to Uniswap V3 pathing, Universal Router integration, low-liquidity traps, and dynamic token loading. **V6 is the stable, functional release** that successfully executes arbitrage on Mainnet.

## The Journey

### V1-V3: The Foundational Flaws
*   **Initial Design**: Simple AAVE/GHO arbitrage using Uniswap V3 Router.
*   **Blocker**: "ERC20: transfer to the zero address" errors during execution.
*   **Diagnosis**: The standard `SwapRouter` was failing to handle certain token transfers correctly in the context of the Futarchy ecosystem, or approval logic was flawed.

### V4: The Dynamic Attempt
*   **Features**: Introduced dynamic proposal loading.
*   **Failure**: Complexity in `bytes` encoding for swaps resulted in reverting transactions. The path encoding for multi-hop swaps (AAVE -> WETH -> USDC -> GHO) was fragile.

### V5: Universal Router & The "Liquidity Trap"
*   **Pivot**: Switched to **Universal Router** + **Permit2** (mirroring the successful VLR High-Frequency Bot).
*   **Hardcoding**: Hardcoded all tokens and paths to isolate variables.
*   **The Bug**: `SPOT_SPLIT` strategy kept failing with "out of gas" or "transfer to zero address".
*   **Root Cause Discovery**: The path `GHO -> USDC` was hardcoded to the **0.01% Fee Tier**.
    *   **The Trap**: This pool had **zero liquidity** at the active tick.
    *   **Consequence**: The router tried to traverse infinite ticks to find liquidity, ran out of gas, or failed to pull tokens (resulting in "transfer to zero").
*   **Fix**: Switched GHO/USDC to the **0.05% Fee Tier** (114k USDC liquidity).

### V6: The Final Form
*   **Architecture**:
    *   **Universal Router**: Handles complex multi-hop swaps efficiently.
    *   **Permit2**: Manages token permissions securely.
    *   **Dynamic Loading**: Successfully inspecting `FutarchyProposal` collateral to determine YES/NO tokens dynamically.
*   **Execution**:
    *   Verified LIVE on Mainnet (Tx: `0x0140...`).
    *   Confirmed execution logic is sound.
*   **Current State**:
    *   Logic is perfect.
    *   **Market State**: MEV bots have closed the easy arbitrage windows. Fees (~0.45%) currently exceed spread (~0.2%).
    *   **Ready**: The bot is deployed and ready to strike when volatility returns.

## Technical verification
*   **Contract**: `0xBc69Db11D5Eb837926E8f5Bb6Dd20069193919AE`
*   **Router**: Universal Router (0x66a9...)
*   **Fee Tiers**:
    *   GHO/USDC: 500 (0.05%) - *CRITICAL FIX*
    *   USDC/WETH: 500 (0.05%)
    *   WETH/AAVE: 3000 (0.3%)
    *   Outcome Pools: 500 (0.05%)

## MEV Protection Strategy
To protect against sandwich attacks and front-running:
1.  **Atomic Execution**: Flash loan execution is atomic. If `minProfit` is not met at the end of the transaction, the **entire transaction reverts**.
2.  **Revert Protection**: This ensures we never lose principal, only gas.
3.  **Flashbots (Recommended)**: To avoid gas loss on reverts, we should route transactions through a private mempool (Flashbots) so failed transactions are not included on-chain.
