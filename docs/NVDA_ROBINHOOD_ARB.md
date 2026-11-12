# NVDA arb bot on Robinhood Chain (4663)

Keeps the YES and NO conditional NVDA/USDG pools of the futarchy market
`0x9693b5d541B64c370987A3b2A569d8db96c4D38E` consistent with the NVDA/USDG spot pool.

| What | Where |
|---|---|
| Contract | `contracts/NVDAFlashArbitrageRobinhood.sol`, deployed at `0x20e3f7227e78f398c6b0f58b9271855717c4352f` (verified on Sourcify) |
| Roles | owner and treasury `0x645A3D9208523bbFEE980f7269ac72C61Dd3b552`; operator (the bot's own key, gas only) `0xDf56Df34749C43fFa6Df08F7281D7D985135F4b1` |
| Runner | `scripts/arb-bot-nvda-robinhood.js` |
| Watchdog | `scripts/arb-bot-nvda-robinhood-watch.sh` |
| Units | `deploy/systemd/` (`systemctl --user`, installed on farol) |
| Fork tests | `foundry-robinhood/test/`, run with `forge test -vv` from the repo root |

## How it works

Spot should lie between the YES and NO prices. When it does not, there is a riskless trade:

- **Both conditional prices above spot (`SPOT_SPLIT`):** take NVDA from the spot pool, split it into YES_NVDA and
  NO_NVDA, sell each in its pool, merge the YES_USDG and NO_USDG back into USDG, pay the spot pool.
- **Both conditional prices below spot (`MERGE_SPOT`):** sell NVDA at spot for USDG, split the USDG, buy YES_NVDA and
  NO_NVDA, merge them into NVDA, deliver the NVDA to the spot pool, sell the surplus for USDG.

The working capital is a flash swap on the spot pool (there is no Balancer vault on this chain), so the contract
holds nothing between calls. `executeArbitrage` can be called only by the operator (or the owner) and reverts
unless the USDG gained is at least `minProfit`: only gas is at risk. Profit and any unmatched outcome tokens go to
the treasury in the same transaction. The operator key cannot change roles or withdraw anything.

If only one conditional pool moves, spot is still between YES and NO and there is nothing to arbitrage.

## Operating it (farol)

```bash
systemctl --user status nvda-robinhood-arb-bot.service
tail -f ~/data/arb-logs/nvda-robinhood-arb-bot.log          # one line per decision
cat ~/shared/nvda-robinhood-arb-heartbeat.json               # written every cycle
tail ~/data/arb-logs/nvda-robinhood-trades.jsonl             # one line per transaction
systemctl --user stop nvda-robinhood-arb-bot.service         # stop (disable to keep it off after a reboot)
```

Alerts go to the Fleet - Status group, rate-limited: repeated RPC failures, three reverted transactions in a row
(the bot then pauses ten minutes), low gas, and (from the watchdog timer) a stopped unit or a heartbeat older than
five minutes. Single trades never alert.

Dry run anywhere, no key needed: `NODE_PATH=<dir with ethers>/node_modules node scripts/arb-bot-nvda-robinhood.js`.

## Sizing

Profit is concave in trade size. The runner simulates a geometric grid of sizes with `eth_call`, narrows around the
best one, and sends only when simulated profit minus gas is at least `MIN_NET_PROFIT_USDG` (0.5). The on-chain
`minProfit` is 80% of the simulated profit. An oversized trade can be profitable on average while pushing the
conditional prices past spot, which is why the runner looks for the maximum instead of the largest passing size.

## Pointing it at a new market

The market is a constructor argument: `constructor(proposal, yesPool, noPool, operator, treasury)`. The constructor
reads the four outcome tokens from the proposal and refuses to deploy unless each pool trades the expected pair at
fee 500, in either token order. For a new NVDA/USDG market: deploy again, set `ARB_CONTRACT_ADDRESS` in the unit,
restart. The runner reads the proposal and pools from the contract.

History: `0xdbc389d2b4637bbd85f640f1e66397a14da003ae` served the first market (`0x9693989E…970a`, migrated away on
2026-11-12). It is owner-only, hardcoded to that market, holds nothing, and is no longer used.
