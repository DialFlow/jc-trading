# TJR 1-minute model v1.1: notes for an independent reviewer

**Status (Oct 17, 2026):** pre-registered and frozen as v1.1 (`docs/PREREG-tjr1m-v1.1.md`). v1 had a look-ahead, found by the independent TradingView port and fixed the same day. Out-of-sample days start Oct 19: none yet. Nothing is on the Liquidity Labs site.

## Hypothesis
A discretionary futures educator ("TJR") describes his intraday setup as:

> high time frame liquidity sweep, five minute breaker structure, five minute fair value gap that gets filled, enter off of a one minute breaker structure

**Claim tested:** a mechanical reading of that setup on NQ (Nasdaq-100 E-mini) earns more than 0R per trade after realistic fills and costs. It must also beat:
- (a) random entries in the same window, with the same stop sizes and exits;
- (b) the same signals traded in the opposite direction.

**Business-relevant test:** does it pass a MyFundedFutures Rapid EOD 50K evaluation at 3 micro contracts?

## Rules, fills and costs
- **Rules:** `scripts/tjr1m-model-v1.1.mjs`. The header has the exact rules. The SHA-256 is in the pre-registration. v1 (`scripts/tjr1m-model.mjs`) is kept as the record.
- **Signals:**
  - computed on 1-minute OHLC
  - 5-minute candles built from the 1-minute bars, aligned to clock :00/:05 Eastern Time
  - trading day starts 18:00 ET
- **Entry:** market order at the open of the 1-minute bar after the signal, plus 1 tick. No look-ahead: each 5-minute candle only uses information up to the 1-minute bar being checked. v1 broke this; see the amendment.
- **Exits:**
  - stops fill 1 tick worse
  - take-profits need price to trade 1 tick through
  - when one bar touches both stop and target, the stop counts first
  - anything open is closed at the 12:00 open
- **Position:** 3 micros, 2 off at 1R with the stop moved to break-even, the last 1 off at 2R.
- **Costs:** $1.90 round trip per micro, MyFundedFutures' published rate.
- **Results unit:** R per trade net of costs, risk measured from the actual fill.

## How the rules were chosen (multiple-testing disclosure)
- About 200 variants of an earlier 5-minute engine were tested on Jul 30 – Oct 9, 2026 (`RESEARCH.md`).
- The 1-minute model's reading was picked on Oct 11 from 156 readings, on Sep 15 – Oct 9. The selection criterion was reproducing 3 trades the educator took on video, not profit.
- At the freeze, two fill rules were changed: next-open entries and stop slippage. Both lower results.
- On the design period, v1.1 is NQ 13 trades −0.38R and ES 13 trades −3.75R (net). That is no evidence of an edge, as expected for a rule chosen to imitate rather than to profit.

## Evaluation design (pre-registered: `docs/PREREG-tjr1m-v1.md` and the v1.1 amendment)
- **Out-of-sample data:**
  - forward days from Oct 19, 2026, saved daily, with git commit times as the timestamp (Oct 12–16 were seen under v1 and don't count)
  - optionally Databento 1-minute data for 2023-01 to 2026-09-11, which predates the design period
- **Primary test:** NQ, at least 100 trades, mean R > 0. The test uses a day-block bootstrap (10,000 resamples), one-sided p < 0.05.
- **Baselines:**
  - **Random:** 1,000 runs. Uniform entry minute 09:50–10:59, random direction, stop distance drawn from the model's own stops, identical exit and cost code.
  - **Opposite:** each signal mirrored.
  - **Comparison:** a paired day-block bootstrap of the difference.
- **Also required:**
  - simulated MFF pass rate ≥ 50% and fail rate ≤ 15%: 10,000 paths, 60 sessions, trailing drawdown, a 30% consistency rule, open-trade drawdown counted;
  - both halves of the out-of-sample period positive.
- **Kill rule:** if the test or the baselines fail at 100 trades, v1 is dropped with no re-tuning on those days.

## Known weaknesses (please attack these)
0. **Found and fixed:** v1 updated each 5-minute candle's setup from its close before checking that candle's 1-minute entries (look-ahead, 2 of 38 design days affected). v1.1 checks entries first. Please re-check v1.1 for any other look-ahead.
1. **Data source:** Yahoo Finance `ES=F`/`NQ=F` 1-minute bars, not exchange data. Missing minutes are possible. The Databento purchase would replace this and allow a Yahoo-vs-exchange check.
2. **OHLC fill uncertainty:** 1-minute bars hide the order of high and low inside a bar. The stop-first rule is conservative, but ordering errors also affect entries. Tick data (`trades`) would remove this.
3. **Contract rolls:** days where the opening gap is over 0.5% are skipped. Continuous series are not back-adjusted, so levels can be wrong around the roll.
4. **"Morning swing" levels:** an interpretation of the educator's words. Other readings exist (`scripts/tjr1m-study.mjs`).
5. **Imitation bias:** the reading was chosen to match 3 trades from his recap videos, which may be selected winners. His full stream recordings, including no-trade days, are being collected (`scripts/tjr-videos.mjs`).
6. **Random baseline stops:** the baseline draws stop distances from the model's own trades. A baseline using volatility-scaled stops (ATR) would be a useful extra check.
7. **MFF simulation:** it resamples single trades independently, so streaks and day-of-week effects are lost.

## Reproduce
```bash
git clone https://github.com/DialFlow/jc-trading && cd jc-trading
git fetch origin archive && mkdir -p /tmp/a && git archive origin/archive 1m | tar -x -C /tmp/a
node scripts/tjr1m-eval.mjs /tmp/a --out report.json   # design + out-of-sample results, graded against the pre-registration
sha256sum scripts/tjr1m-model-v1.1.mjs                  # must equal the hash in docs/PREREG-tjr1m-v1.1.md
```
The forward paper log is `forward/tjr1m-v1.1.csv` on the `archive` branch, written daily by `.github/workflows/archive-1m.yml`.

## What would prove it wrong
Any of these, measured on out-of-sample days:
- mean R ≤ 0 after 100 NQ trades;
- no better than the random or opposite baseline;
- an MFF fail rate above 15%;
- a TradingView implementation of the same rules that disagrees with this file on more than 2 of 20 signals.
