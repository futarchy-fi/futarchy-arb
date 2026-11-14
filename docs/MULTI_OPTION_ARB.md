# Multi-option futarchy arb bot (Robinhood Chain, 4663)

Keeps a multi-option futarchy market (FutarchyMultiProposal) consistent with spot. Live market: "NVDA next CEO",
proposal `0x36dF9e82479D1B172277dD99269C88B04E68F9A7`, 7 options.

| What | Where |
|---|---|
| Contract | `contracts/FutarchyMultiOptionArbitrage.sol`, deployed at `0x355281efa67e0daf09c5f50206c0d957b8fff2a8` (verified on Sourcify), market id 0 |
| Roles | owner and treasury `0x645A3D9208523bbFEE980f7269ac72C61Dd3b552`; operator (the bot key, gas only) `0xDf56Df34749C43fFa6Df08F7281D7D985135F4b1` |
| Runner | `scripts/arb-bot-multi-option.js` |
| Watchdog | `scripts/arb-bot-nvda-robinhood-watch.sh` with the environment in `deploy/systemd/nvda-multi-arb-watch.service` |
| Units | `deploy/systemd/nvda-multi-arb-*` (`systemctl --user`, installed on farol) |
| Fork tests | `foundry-robinhood/test/FutarchyMultiOptionArbitrage.t.sol`: `forge test --match-contract FutarchyMultiOptionArbitrageTest -vv -j 2` |

## The two identities

Option k has a price pool (k_NVDA / k_USDG: what NVDA is worth if k wins) and a probability pool (k_USDG / USDG:
p_k). Splitting 1 NVDA gives one of every k_NVDA, splitting 1 USDG one of every k_USDG, and merging is the reverse.
So two things must hold, and each has a riskless trade when it does not:

| Identity | When it is off | Trade |
|---|---|---|
| sum p_k * price_k = spot | sum above spot | buy NVDA at spot (flash swap), split, sell every k_NVDA, merge the k_USDG back into USDG, pay |
| | sum below spot | borrow USDG, split, buy the same amount of every k_NVDA, merge into NVDA, sell at spot, repay |
| sum p_k = 1 | above one | borrow USDG, split, sell every k_USDG, repay |
| | below one | borrow USDG, buy one of every k_USDG, merge, repay |

Each is one transaction that reverts unless it nets `minProfit` USDG. The contract holds nothing between calls and
gives no standing approvals; profit and leftover outcome tokens go to the treasury.

Two details that are easy to get wrong:

- **Merge first, trade only the remainder.** After selling every k_NVDA the contract holds a different amount of
  each k_USDG. It merges the common part (worth exactly 1 USDG per set) and trades only the differences in the
  probability pools, which are thin. Selling everything through them would waste most of the profit.
- **The spot arbitrage really enforces `sum p*price + level * (1 - sum p) = spot`,** where `level` is the merged
  amount per NVDA. When option prices differ it can therefore leave the probabilities off one, and the probability
  arbitrage then brings them back. The bot checks the probabilities first every cycle; the fork tests alternate the
  two until neither finds anything.

## Capital

Sum-above-spot is a flash swap on the spot pool: the NVDA arrives first and is paid for at the end. The other three
need USDG up front and borrow it with a Uniswap V3 flash loan from the WETH/USDG 0.01% pool
(`0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca`), so the fee is 0.01% of the amount. A working balance in the contract
would save that fee but would mean holding funds, which the contract is designed never to do.

## What it can correct at current liquidity

Each price pool holds about 11.4 k_NVDA and 2,235 k_USDG within ±20%; each probability pool about 500 of the
option's USDG. Measured on a fork (2026-11-14):

- **Common gap between sum p*price and spot.** The split/merge trade moves all seven price pools together, so the
  sum moves one for one. Profit grows with the square of the gap: a 2% gap is worth about 1.9 USDG. A spot
  arbitrage costs about 3.7M gas (about 0.2 USDG). With the 0.5 USDG net threshold the bot acts on gaps above
  roughly **1.25%** and trades them down to about 0.1–0.2% (the pool fees).
- **One option's price out of line.** It moves the sum only by p_k times its own deviation. NONE (86%) counts almost
  in full; BUCK (4.5%) would have to be about 28% off to open a 1.25% gap. Nothing arbitrages a single option's
  price on its own: that is a view on the option, not a riskless trade.
- **Probabilities not summing to one.** A 5.8% excess created in the NONE pool was worth 1.44 USDG, a 4.7% shortfall
  1.02 USDG. A probability arbitrage costs about 2.1M gas (about 0.1 USDG). The bot acts on deviations above
  roughly **3.5–4%** and trades them down to about 0.1%.

Lowering `MIN_NET_PROFIT` narrows both bands (0.1 USDG net gives about 0.85% and 2.2%); deeper pools narrow them
more, because profit at a given gap is proportional to depth.

## Operating it (farol)

```bash
systemctl --user status nvda-multi-arb-bot.service
tail -f ~/data/arb-logs/nvda-multi-arb-bot.log               # one line per decision: spot, sum p*price, gap, sum p
cat ~/shared/nvda-multi-arb-heartbeat.json                    # written every cycle, with every option's p and price
tail ~/data/arb-logs/nvda-multi-arb-trades.jsonl              # one line per transaction
systemctl --user stop nvda-multi-arb-bot.service nvda-multi-arb-watch.timer   # stop (disable to keep it off after a reboot)
```

Alerts go to the Fleet - Status group, rate-limited: repeated RPC failures, three reverted transactions in a row
(the bot then pauses ten minutes), low gas, and (from the watchdog timer) a stopped unit or a heartbeat older than
five minutes. Single trades never alert.

Dry run anywhere, no key needed: `NODE_PATH=<dir with ethers>/node_modules node scripts/arb-bot-multi-option.js`.

## Adding a market

`addMarket(proposal, spotPool, flashPool, pricePools[], probPools[])`, owner only, no redeploy. The outcome tokens
are read from the proposal, and every pool must be the Uniswap V3 factory's pool for exactly the expected pair, so a
wrong or fake pool is rejected. Run a second bot with `MARKET_ID` set.

A nested market (for example a child proposal under OTHER) fits the same call: its collateral is the parent
option's tokens, its "spot" pool is the parent option's price pool, and its flash pool can be the parent option's
probability pool. That path is written but has not been run: no nested market exists yet.

## Sizing

Profit is concave in size. The runner simulates a geometric grid of sizes with `eth_call`, narrows around the best
one, and sends only when simulated profit minus gas is at least `MIN_NET_PROFIT`. The on-chain `minProfit` is 80%
of the simulated profit. The contract's `level` argument (how many full sets to merge or split) is left at 0, which
picks it automatically; tuning it is a possible refinement when option prices differ a lot.
