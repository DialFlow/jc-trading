# JC Trading — Research log

Every strategy study run on the TJR model, newest first. Plain-English version for Jacob: the "JC Trading — Strategy Research in Plain English" doc (claude.ai). Details and code notes: `CLAUDE.md`.

Data: Yahoo 5m ES=F / NQ=F (~60 days, ~50 NY sessions, Jul 30 – Oct 9 2026) unless noted; Yahoo 1H for ~2 years. Costs $2.50/side, 1 tick slippage on stops. **Robust** = net > 0 overall + both date halves + stress test (fill only after trading 2 ticks through, 3 ticks slippage). All results are in-sample unless noted; ~100 variants tried so far, so discount small edges.

## Reproduce
```bash
node scripts/backtest.mjs --validate     # TradingView parity: 7 ES trades, −$2,760; replay = full run
node scripts/backtest.mjs                # → backtest.json, replay.json
node scripts/structure-study.mjs         # → structure.json
node scripts/exit-study.mjs              # → exits.json
node scripts/liq-ladder-study.mjs        # → ladder.json
node scripts/research.mjs                # → research.json (forecast, gaps, off-hours)
node scripts/confluence-stats.mjs        # → confstats.json
```

## Studies

| Date | Study | Script → output | Result |
| --- | --- | --- | --- |
| Oct 10 | Entry timing and improvements (earlier entries, entry price, filters, stops) | see "Oct 10 entry study" below | pending |
| Oct 10 | Liquidity ladder ⅓ (TP1 first pool ≥1R, TP2 next pool, final = target; BE after TP1, stop to TP1 after TP2) | `liq-ladder-study.mjs` → `ladder.json` | +$273.7k vs +$269.6k (½ scale-out) over 25 NQ settings, better in 15/25, same DD. ½·½ ladder = tie. Exits unchanged; levels drawn on charts. |
| Oct 10 | Exits in R | `exit-study.mjs` → `exits.json` | NQ default: targets avg 8.6R; reached +1R 63%, +2R 37%, +3R 16%. Fixed 1/2/3R ladder: win rate 53% → 79% but +$240k vs +$251k (25 settings). Half at 0.5R: 57% vs 49% wins, 2–38% less profit. ES loses with every exit. |
| Oct 9 | Forecast (direction, liquidity race, move size) | `research.mjs` → `research.json` | Direction 43–47% out of sample (no edge). Nearer liquidity first 75–78%. |
| Oct 9 | Gap (FVG/IFVG) first-retest trades, 5m–4H, ~15,000 trades | `research.mjs` part C | Plain FVG/IFVG retests lose on every TF. Holds: 1H gap ≥1 ATR with 4H trend (NQ 209 trades +0.15R, ES 191 +0.06R). Promising: 15m gap inside same-way 1H gap +0.15R (61–70 trades). ~80 variants. |
| Oct 9 | Off-hours setups | `research.mjs` | ES Asian negative; NQ outside-hours rows positive but n < 35. |
| Oct 8 | Structure: BOS type × window × setups/day × fresh levels (24 variants × 25 settings × 2 exits) | `structure-study.mjs` → `structure.json` | Window drives it: sweeps from 8:30 + entries 9:50–11:00 = 23 trades avg, 46/50 robust vs std 13 and 23/50. Swing BOS, 2 setups/day, fresh-only levels: worse. Adopted as the Lab model. |
| Oct 8 | Exit modes rules / liq / scale | `backtest.mjs` (`exits`) | NQ sum over 25 settings 137k → 179k with liquidity exits; robust 11 → 12. ES: no exit helps. Scale-out adopted as NQ default. |
| Oct 8 | MFF account Monte Carlo (5,000 paths) | page `simAccount` | NQ default, scale exit: 3 MNQ ≈ 21–26% pass / ~7% fail on every plan; 1 NQ fails 51–54% (Rapid/EOD/Pro), Rapid funded blown 98–99%. |
| Oct 8 | Confluence checklist history | `confluence-stats.mjs` → `confstats.json` | 1m–15m ≤ random; 30m–4H above (NQ 4H 63% vs 45%, 30m 64% vs 47%; n 28–143). |
| Oct 8 | v5 settings: stop mode × sweep level × displacement, ES + NQ (stops ×4) | `backtest.mjs` → `backtest.json` | ES 0/24 profitable (best −$970). NQ 24/24 profitable (+$1,570 to +$11,362). NQ default now: Fixed 80 · PDH/PDL · displacement · scale = 20 trades, 55%, +$19,240, PF 3.6, DD $1,795. |
| Oct 7 | TradingView v4, ES1! 5m, Aug 16 – Oct 7 | `jc_tjr_backtest_v4.pine` | 7 trades, 0 wins, −$2,760. Sweep rule too loose (37/38 days); stops behind the wick get hit by noise. |

## Oct 10 entry study
Pending: a research run is testing entry windows (from 8:30 / 9:00 / 9:30 / 9:40 vs 9:50), entry price (FVG edge / midpoint / market on BOS), filters (HTF trend, SMT, swept level, VIX) and structure-based stops.
