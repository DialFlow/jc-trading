# Pre-registration: TJR 1-minute model v1

Written Sat Oct 17, 2026, **before** the frozen rules were run on any day after Oct 9, 2026. The commit that adds this file is the timestamp. Nothing here goes on the Liquidity Labs site unless every success test below passes.

## 1. The rules (frozen)
- File: `scripts/tjr1m-model.mjs`, `VERSION = 'tjr1m-v1'`.
- SHA-256: `5a24c04c0dc4d6a1a06940a4cd7a9d17149d1cc29372b2c37d09c954b757ec41`. Check: `git show <this commit>:scripts/tjr1m-model.mjs | sha256sum`.
- In plain words (the file header has the exact version):
  1. **Liquidity:** Asian high/low (18:00–03:00 ET), London high/low (03:00–08:30), prior trading day high/low, plus morning 5-minute swing highs/lows from 07:00. Morning levels count from 09:30, session levels from 08:30.
  2. **Sweep:** price trades through a level, then a 5-minute candle closes back inside, within 2 candles for morning levels or 12 for session levels. A sell-side sweep arms a long, a buy-side sweep a short.
  3. **Break:** a 5-minute close beyond the latest 5-minute swing (2 candles each side) in the trade direction. If both sides are armed, the latest break wins.
  4. **Pullback:** the impulse is measured from the sweep, then the pullback against it.
  5. **Entry, 09:50–11:00:**
     - **Trigger:** a 1-minute close breaks the pullback leg, then a market order fills at the next 1-minute open + 1 tick.
     - **Stop:** pullback extreme ± 1 pt (ES) or 4 pts (NQ).
     - **Stop size limits:** 2–25 pts ES, 8–100 pts NQ.
     - **Frequency:** one trade per contract per day.
  6. **Exits (funded plan, 3 micros):**
     - **Take-profits:** 2 contracts off at 1R with the stop moved to break-even, the last 1 off at 2R. A take-profit fills only after price trades 1 tick through it.
     - **Stops and conflicts:** stops fill 1 tick worse. If one candle touches both the stop and a target, the stop counts first.
     - **Time limit:** anything still open is flat at 12:00.
  7. **Costs:** $1.90 round trip per micro (MFF). R is measured from the actual fill.
- **How the rules were chosen:** on Oct 11, out of 156 readings of TJR's checklist, because this one reproduced his logged trades (Sep 17 exact, Sep 30 same time, Oct 6 right direction but late). About 200 earlier rule versions were tried in older studies. The design period cannot count as evidence.
- **Two changes added at the freeze:** the next-open fill and the stop slippage. Both make results worse, not better. On the design period, v1 is ES 13 trades −3.02R and NQ 13 trades −0.07R.

## 2. Data
| Period | Dates | Role |
| --- | --- | --- |
| Design | Sep 15 – Oct 9, 2026 | Used to choose the rules. Reported, never counted as evidence. |
| Forward (out of sample) | Oct 12, 2026 onward | `archive` branch, saved daily. Not looked at with v1 before this file. |
| Historical (out of sample) | Jan 2, 2023 – Sep 11, 2026 | Only if Jacob approves the Databento download. These days predate the design period, so v1 has never seen them. |

## 3. What counts as success (all must hold)
Primary sample: **NQ**, all out-of-sample days (forward + historical). ES is reported separately as secondary.
1. **Enough trades:** at least 100 NQ out-of-sample trades.
2. **Makes money after costs:** mean R per trade > 0, one-sided p < 0.05. The test is a bootstrap, resampling whole days, 10,000 times.
3. **Beats the baselines:** the model's mean R minus each baseline's mean R must be > 0, with the 95% bootstrap interval above 0. Both baselines get the same exits, slippage and costs.
   - **Random:** on every out-of-sample day, a random entry minute 09:50–10:59, random direction, and a stop distance drawn from the model's own stop distances. Repeated 1,000 times.
   - **Opposite:** every model signal traded in the other direction at the same fill, with a mirrored stop.
4. **Passes MFF:** a Rapid EOD 50K evaluation simulation with 3 MNQ passes ≥ 50% within 60 sessions and fails ≤ 15%. The simulation has these rules:
   - $2,000 trailing drawdown from the end-of-day high, locked at $50,100
   - target +$3,000, at least 4 trading days
   - no day over 30% of profit
   - open-trade dips count
5. **Not just one lucky stretch:** mean R > 0 in both halves of the out-of-sample period, split by date.

Multiple testing: the out-of-sample test is one pre-registered test, so no correction applies to it. For transparency, the design-period result is also reported with a correction for the ~356 versions tried: a Šidák adjustment and the rank among the 156 readings.

## 4. Kill rules
- **Final test:** once there are ≥ 100 NQ out-of-sample trades, if test 2 or test 3 fails, v1 is dropped. Its rules are not re-tuned on those days. Any v2 needs its own pre-registration and is judged only on days after its freeze.
- **Early stop:** if forward paper trading reaches 40 NQ trades with total ≤ −10R, paper trading of v1 stops.
- **Pausing:** if the TradingView version (Pine) disagrees with this file on more than 2 of the first 20 forward signals, the test pauses until the difference is explained.

## 5. Independent checks
- **TradingView:** a Pine v6 version of the same rules, run in TradingView's strategy tester. It must give the same signals day by day.
- **Forward paper log:** every new day is run automatically and written to `forward/tjr1m-v1.csv` on the `archive` branch, with the commit as the timestamp.
- **Review:** the write-up for a quant reviewer is `docs/REVIEW-tjr1m-v1.md`.
