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
JC_CACHE=<dir> node scripts/entry-study.mjs   # → entry.json (~20 s; JC_CACHE keeps the same candles across reruns)
```

## Studies

| Date | Study | Script → output | Result |
| --- | --- | --- | --- |
| Oct 10 | Entry timing and improvements (~59 variants: windows, entry price, stops, filters) | `entry-study.mjs` → `entry.json` | Earlier entries no help; ES is the leak; NQ 60-pt stop = paper-trade candidate. Details below. |
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
Jul 31 – Oct 9 (50 sessions, halves split Sep 4). ~59 variants × 25 settings × 2 contracts. Engine options added for it (defaults unchanged, parity + replay check pass, old/new engine identical on 450 runs): `restStart`, `entryAt` ('mid' | 'edge' | 'far' | 'market' | 'bos' | 'ifvg'), `stopMode` 'ATR' / 'Sweep+buffer' / 'FVG far' (`atrMult`, `stopBuf`), `pause` [start, end].

- **Where it loses:** ES default (v4) 30 trades, 23% won, −$4,700/contract, max DD $7,393; lost 9 of last 11 weeks, 0/5 since Oct 1; no ES setting profitable since Sep 14, none robust under any variant. NQ default (Fixed 80 · PDH/PDL · displacement · scale) 19 trades, 53%, +$16,915, PF 3.31, DD $1,795, halves 6,915/10,000, stress +$16,185; since Oct 1 2 trades +$1,173; all 25 NQ settings ≈ flat the last two weeks.
- **Earlier entries:** fills 8:30–9:29 ≈ 0R on NQ (+0.03R, n 92 pooled; −0.77R / +0.36R by half), ES −0.65R. 9:30–9:50 fills NQ +0.30R but +0.56R → −0.11R by half; entries 9:30–11:00 cut robust NQ settings 24 → 17/25. Fully open 8:30–11:00: NQ default $14,713, DD $2,285, 74% won (gain = swapping which trade is taken, not good early fills). Cut-off 11:30 ≈ 11:00; 10:10/10:30 worse.
- **Fill time (NQ pooled):** 9:50–9:59 n 314 +0.47R · 10:00–10:29 n 99 ≈ −0.45R · 10:30–10:59 n 94 +0.39R. A 10:00–10:30 pause makes it worse (default $9,568, 21/25 robust).
- **Candidate (paper-trade first):** NQ fixed stop 60 vs 80 pts: 63% vs 53%, +$19,035 vs +$16,915, PF 5.83 vs 3.31, DD $1,170 vs $1,795, stress +$18,325 (DD $1,180). 8/8 fixed-stop settings robust; sum +$138k vs +$91k (scale). Bumpy by size (40 $71k · 50 $102k · 60 $138k · 70 $85k · 80 $91k · 90 $65k), so the DD cut is the reliable part.
- **Small, not adopted:** skip entries inside an opposing 1H FVG/IFVG: NQ default 18 trades +$17,820 DD $1,618; helps 13/25 NQ.
- **No help:** entry at FVG near edge (19/25 robust), far edge, market at FVG close (9/25), BOS close (~7 trades), IFVG retest (15/25); stops sweep wick, sweep+buffer, ATR×3/×5, beyond FVG; filters SMT, same-way 1H gap, 1H trend, sweep depth, minutes since sweep, opening gap. VIX untestable (14–18 all period); no free news history.
- **Sizing:** 1 NQ at 80 pts risks $1,600, DD ≈ whole $2,000 MFF limit; 3 MNQ ≈ +$5,000, DD ≈ $540.
