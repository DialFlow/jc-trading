# Pre-registration amendment: TJR 1-minute model v1.1

Written Sat Oct 17, 2026, the same day as v1 (`docs/PREREG-tjr1m-v1.md`). It replaces v1 because of two defects found while building the independent TradingView version. Everything in the v1 pre-registration still applies unless changed here. The commit that adds this file is the timestamp.

## Why v1 was replaced
1. **Look-ahead.**
   - **What v1 did:** for each 5-minute candle, it first updated the setup with that candle's close (new sweeps, breaks, which side is in play). Only then did it check the same candle's 1-minute bars for an entry. That close is not known until the candle ends.
   - **The effect:** v1 could skip or change a trade using information from up to 4 minutes in the future.
   - **How it was found:** while porting the rules to Pine, where that order is impossible.
   - **Size:** 2 of 38 contract-days in the design period changed: NQ Sep 25 and Oct 8, both still losses.
2. **Costs left out of R.**
   - **The problem:** v1's R excluded the $1.90 per micro. Only its dollar figure included it.
   - **What the pre-registration says:** "makes money after costs", so R must be net of costs.

Neither change was chosen by looking at results. Both are corrections to match what the pre-registration already said: no look-ahead, results after costs.

## v1.1
- **File:** `scripts/tjr1m-model-v1.1.mjs`, `VERSION = 'tjr1m-v1.1'`.
- **SHA-256:** `e8b179404765ad55ff3ea21f606714a5eea053d54f5426338d679c254005fff6`. Check: `git show <this commit>:scripts/tjr1m-model-v1.1.mjs | sha256sum`.
- **What changed from v1:**
  - Each candle's 1-minute bars are checked against the setup as it stood before that candle closed. Then the candle's close updates levels, sweeps and breaks.
  - `r` is net of costs: dollars after costs ÷ dollars at risk. `rGross` keeps the old figure.
  - Nothing else changed.
- **Design-period result, for the record:** NQ 13 trades −0.38R, ES 13 trades −3.75R.

## Which days count
| Days | Status |
| --- | --- |
| Sep 15 – Oct 9, 2026 | Design: chose the rules. Not evidence. |
| Oct 12 – 16, 2026 | Seen: run under v1 before this fix. Reported, never counted. |
| From Mon Oct 19, 2026 | Out of sample (forward). |
| Jan 2023 – Sep 11, 2026 | Out of sample (historical), if the Databento data is bought. |

The success bar and kill rules are unchanged from v1:
- ≥ 100 NQ out-of-sample trades
- mean net R > 0 with one-sided p < 0.05
- beats the random and opposite-direction baselines
- MFF pass ≥ 50% and fail ≤ 15% at 3 MNQ
- both halves positive

## Files
- **Forward log:** `forward/tjr1m-v1.1.csv` on the `archive` branch. Rows start Oct 12; official rows start Oct 19.
- **Evaluation:** `scripts/tjr1m-eval.mjs`.
- **TradingView version:** `jc_tjr1m_v1.pine`, to be matched to v1.1.
- **v1 record:** `scripts/tjr1m-model.mjs` and `forward/tjr1m-v1.csv` stay unchanged.
