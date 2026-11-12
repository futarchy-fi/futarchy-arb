# NVDA arb bot on Robinhood Chain (4663)

Keeps the YES and NO conditional NVDA/USDG pools of the futarchy market
`0x9693989EF16C43274D0b85138BaF22F21651970a` consistent with the NVDA/USDG spot pool.

| What | Where |
|---|---|
| Contract | `contracts/NVDAFlashArbitrageRobinhood.sol`, deployed at `0xdbc389d2b4637bbd85f640f1e66397a14da003ae` (owner `0x645A3D9208523bbFEE980f7269ac72C61Dd3b552`, verified on Sourcify) |
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
holds nothing between calls. `executeArbitrage` is owner-only and reverts unless the USDG gained is at least
`minProfit`: only gas is at risk. Profit and any unmatched outcome tokens go to the owner in the same transaction.

If only one conditional pool moves, spot is still between YES and NO and there is nothing to arbitrage.

## Operating it (farol)

```bash
systemctl --user status nvda-robinhood-arb-bot.service
journalctl --user -u nvda-robinhood-arb-bot.service -f      # one line per decision
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
