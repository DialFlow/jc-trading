# JC Trading — project handoff (updated Wed Oct 7, 2026, Claude Code session)

## What this is
A single-file personal trading dashboard (`index.html`) for Jacob, who day-trades ES/NQ futures on a MyFundedFutures $50K funded (sim) account using TJR's methodology. It started in claude.ai as an artifact ("JC Trading", Version 6). This folder is now the source of truth.

## Files
- `index.html`: the whole site. HTML + CSS + JS in one file, no build step. All user data is saved in `localStorage` (keys prefixed `jct_`).
- `jc_tjr_backtest_v4.pine`: the TradingView Pine Script v6 strategy used for the backtest.
- `jc_tjr_backtest_v5.pine`: v4 plus toggles for stop mode (sweep wick / fixed points / second sweep), sweep level (Any / London / Asian / PDH-PDL) and a displacement filter on the BOS. Not yet run in TradingView. v4 settings reproduce v4 (Sweep wick, max stop 15, Any, displacement off).
- `.nojekyll`, `.gitignore`: for GitHub Pages. Folder is a git repo on `main`.
- `backtest.json` + `scripts/backtest.mjs`: the real-data backtest shown on the Backtesting tab (see below). The old `bt/` screenshots were removed Oct 8.
- `.gitattributes`: forces LF line endings (a CRLF checkout once broke multi-line edits).

## Design system (keep it)
Apple HIG look: black/white/light gray, Inter, iOS system colors as CSS tokens on `:root` (`--bull`, `--bear`, `--warn`, `--blue`…). Light/dark via `prefers-color-scheme` plus `data-theme`. Cards, segmented controls, pill badges.

## Tabs (8)
Dashboard, Charts, Morning Journal, Daily Bias, Playbook (id `strategy`), Trade Log, Edge, Lab (id `backtest`).
Tab switching: `showPage(name)` plus the `tabNames` array in the same order as the buttons. Add new tabs to both. `showPage('levels')` maps to `strategy` (Key Levels merged into Playbook on Oct 8).
The site will be shared with a few of Jacob's friends (beginners): keep wording plain, always show sample size and caveats next to results, and never present examples as real data.

## Trade Readiness (Dashboard hero, Oct 8)
- `readiness(sym)` gives a GO / CAUTION / STAND ASIDE / PREPARE / WATCH verdict per ES1! and NQ1!, from the engine run on today's candles (`todayRun`, same config as the Lab via `cfgFor`) plus checks.
- **Must pass** (they block a GO): track record (`isRobust`), fresh data (≤15 min, only 9:00–12:00), and risk per trade within the Playbook limit (`jct_risk`, shown per full and micro contract).
- **Confirmations:** MTF FVG scan direction, confluence alignment, Jacob's Daily Bias, news within 30 min of 9:50–10:10 (from `analysis.json` events), and reward:risk ≥ his minimum. A disagreeing confirmation gives CAUTION; neutral ones are noted.
- Settings with no robust track record (ES on Oct 8) show "Stand aside" all session. `sessionBar()` draws the 7:00–12:30 timeline with a now marker. It refreshes with `readyCycle()` (60 s, Refresh button, opening the Playbook).
- Tested by time-travelling today's candles (cut at 8:45 / 9:40 / 10:02 / 10:12 / 11:06 / 12:30 with a faked clock): verdicts matched the engine events.

## Playbook tab (Oct 8)
- Auto levels per contract (PDH/PDL, Asia, London, midnight open, marked "swept today"), TJR 4 steps in plain English with glossary terms, a session clock, Jacob's own levels (`jct_levels`), rules (rewritten to TJR; the old ORB/VWAP template text was removed), and editable risk limits (`jct_risk`, synced). The old hardcoded "reference levels" (ES ATH 5878…) were placeholder data and are gone.

## Exits, scenarios, alerts (Oct 8, late)
- **Engine exit modes** (`cfg.exitMode`, `EXITS`): `rules` (Pine target, the default; TradingView parity intact), `liq` (all out at the first liquidity pool ≥1R: session H/L, midnight open, NY high/low since 9:30), `scale` (half out there, stop to break-even, rest to the rules target). Trades now carry MFE/MAE (`mfeR`, `maeR`), `mins` and `scaled`. `stats().reach` = % of trades that reached 0.5/1/1.5/2/3R. `cfg.restEnd` (default 660 = 11:00) lets scenarios ask "what if the order had stayed open to 12:00".
- **Evidence (Jul 30–Oct 8):** on NQ, liquidity exits raise the sum of net across all 25 settings by ~30% (137k → 179k) and robust settings 11 → 12. Default NQ setting: rules +$7,705 · liq +$9,820 · scale +$9,438 (most even halves 4,470/4,968). 80% of trades reach +1R but only 20% reach +2R. ES: no exit helps (0 robust).
- `backtest.json` has `exits.{liq,scale}` per run (trades, stats, halves, stress); about 780 KB. `--validate` checks replay = full run for every exit mode × setting.
- **Lab:** an exit picker (`labExit`, default = robust exit with the strongest weaker half; `jct_lab_exit`). `viaExit(r)` gives a run's stats under the chosen exit, and `engCfg(r)` feeds every engine call (live, readiness, replay, scenarios).
- **Exit plan** (`exitPlanHtml`): a liquidity ladder beyond the entry, combining session pools with 1H/4H swing highs/lows and unfilled HTF FVG edges from the MTF scan, in R, with TP1/target marked and the historical reach %. Shown in the Live ticket and in Readiness when an order exists. Oct 8 check: it listed the 1H swing high 31369.75, which was the exact top.
- **Scenarios** (Lab): every replay session written as a play-by-play (Simple = plain English, Detailed = engine events + R/MFE/MAE). Categories: win/loss/missed/skipped/none, each with a lesson. Missed orders get the what-if (Oct 8: a fill at 11:25 would have lost $920, so the cancel saved money). "Replay this day" opens the replay.
- **Alerts:** a 🔔 toggle on Readiness (`jct_alerts`). Notification + vibrate + beep when the verdict changes to watch/go/caution/done. Only while the page is open; real-time also depends on fresh candles (Cloudflare).

## Dashboard rebuild (Oct 8, evening)
- **Order:** Trade Readiness › AI Signal › Market panel (ES1!, NQ1!, VIX, Gold + CME status/session/time; DXY dropped) › Morning Analysis › Confluence checklist › FVG scan › Pre-market checklist › Market notes › Today's events › Sector strength.
- **Morning Analysis** (`renderAnalysis`) is generated live on every refresh from `todayRun`, the MTF scan/checklist, `signalFor`, backtest + confstats, news, sectors and Jacob's notes (simple bull/bear keyword read). It shows a headline, 3 key numbers, rows (SMT, HTF, 1–4, invalidation, backtest), context, and collapsible levels. After 10:10 the step rows are labelled "this morning", and the current 15m structure is added. `analysis.json` is now only an optional "Claude's note".
- **AI Signal** (`computeAISignal` → `signalFor(sym)` per contract): bullish/bearish/neutral from the confluence checklist per TF (weights 5m .5, 15m .75, 30m 1, 1H 1.5, 4H 2), 15m/1H structure (latest BOS), the HTF FVG scan, today's engine sweep and SMT. ES/NQ disagreeing = neutral. Daily Bias is displayed but doesn't set the direction. The old function is kept as `computeAISignalOld`.
- **News:** Forex Factory weekly JSON (`nfs.faireconomy.media/ff_calendar_thisweek.json`), USD High (= red folder) + Medium → `news.json` (Action) or Worker `/news`. Readiness' news check uses it. **Sectors:** 11 SPDR ETFs 1d/5d → `sectors.json` or `/sectors`. Finviz actively blocks automation (bot-detection scripts that target automation tools), so it's linked rather than read.
- **Confluence history:** `scripts/confluence-stats.mjs` evaluates the checklist code from index.html (between the `CONFLUENCE-CORE START/END` markers; keep that block free of top-level DOM access) over history and writes `confstats.json`. Signal = ≥5 of 6 aligned; win = +1 ATR before −1 ATR; first candle per run only. Oct 8 result: 1m–15m ≤ random, 30m–4H above (NQ 4H 63% vs 45%, NQ 30m 64% vs 47%; n 28–143). Shown as a History row in the checklist and in Lab → Confluence edge.

## Account sim = MyFundedFutures rules (Oct 8, night)
- `MFF_PLANS` holds the 50K Rapid, Rapid EOD, Builder (+$1,500 MLL add-on) and Pro rules, taken from help.myfundedfutures.com on Oct 8 2026. Values: target $3,000; MLL $2,000 (add-on $1,500); trailing EOD, except Rapid sim-funded = intraday from the equity high-water mark; locks at +$100; Builder DLL $1,000 soft pause; eval consistency Rapid 50%, Rapid EOD 30%, Pro 50%, Builder none; min days 2/4/1/2; max size 5/3/4/5 minis. Payouts: buffer $2,100 ($1,600 add-on), min $500 (Pro $1,000), Builder max $2,000/cycle with 50% cycle consistency and 2 days, split 90% (Rapid) / 80%. **Pro's eval target isn't on the help page: $3,000 is assumed.** Rapid eval lock level isn't stated: +$100 assumed. Plans change often; re-check before relying on them. Settings (plan, stage, overrides) live in `jct_plan` (synced).
- `simAccount()` replays each bootstrapped trade's path: winners dip to their MAE first, then reach MFE; losers reach MFE first, then fall. An open-trade dip touching the floor = fail (counted as "fail mid-trade" when the trade would have closed above it). Intraday trailing raises the floor with unrealised highs. The DLL caps a day's loss. Funded: payouts withdraw down to the buffer and the floor stays locked. Stress-test trades now carry `mfe`/`mae`. Eight hand-worked unit cases pass (dip fail, intraday vs EOD, lock, consistency, payout maths).
- Oct 8 results, NQ default setting with the scale-out exit and stress trades, 30-day eval / 60-day funded: 3 MNQ is about 21–26% pass and ~7% fail on every plan. 1 NQ fails 51–54% on Rapid/Rapid EOD/Pro (35–40% of failures mid-trade), and is blown 98–99% in Rapid funded (intraday trailing). Builder's $1,000 DLL changes 1 NQ to 65% pass / 34% fail.

## Lab Highlights (Oct 8)
- Default Lab view: a feed of post cards (today's verdict, result + equity spark, win rate vs win size, robustness checks, account survival via `mcQuick`, best/worst trade, 4-step diagram). Every results card carries the sample-size caveat.
- `.gl` terms open a plain-English `GLOSSARY` popover. `hlShare(id)` draws a 1080×1350 PNG on a canvas and uses the Web Share sheet, else downloads it and copies the caption.

## TJR methodology (Jacob's rules)
- 4 steps: Potential → Confirmation (BOS + IFVG) → Continuation (FVG + EQ) → Exit (draw on liquidity).
- Sessions (ET): Asian 6pm–3am, London 3am–8:30am, NY Open 8:30–9:30, Manipulation 9:30–9:50 (NO TRADE), Entry Macro 9:50–10:10.
- SMT divergence: ES/NQ split at a key level = signal.

## Done this session
1. Fixed all tabs being dead: an orphaned block of old simulated-price code caused a JS syntax error that killed the whole script.
2. AI Trade Signal now reads the Daily Bias tab (`jct_bias`) as a fallback. It used to read only `tjr_bias`, which nothing writes.
3. Charts tab: replaced `tradingview.com/chart` iframes (they refuse framing) with the embeddable `s.tradingview.com/widgetembed` charts and added a TradingView ticker tape.
4. Built the TJR strategy in Pine and backtested it in TradingView (ES1!, 5m).
5. Added the "Backtesting with AI" tab: chat-style thread, 4 annotated screenshots, plus a follow-up box that uses the claude.ai artifact `sample` capability (`window.claude.use('sample')`). Outside claude.ai that capability doesn't exist and the box hides itself.

## Backtest result (v4)
ES1! 5-min, Aug 16 – Oct 7, 2026 (38 NY sessions; free plan history limit). 1 contract, $2.50/side commission, 1 tick slippage, 5% margin.
- Funnel: sweep 37 days → BOS 20 → FVG 16 → orders 12 → fills 7.
- 7 trades, 0 winners, −$2,760 (−5.52%), profit factor 0. Losses 3.75–14 pts.
- Sep 14: long 7,614.25 at 9:55, stopped 7,600.50 at 10:25, then ES rallied to ~7,650.
- Conclusion: not profitable as coded. Sample far too small to judge TJR itself.
- Lessons: the "sweep" rule is too loose (fires 37/38 days); stops right behind the sweep wick get hit by noise.
- Pine gotcha: v6 defaults to 100% margin, so on $50K every ES order was silently rejected until `margin_long/short=5`.

## Done in the Claude Code session (Oct 7, evening)
- Fixed SSL/BSL in `computeAISignal()`: SSL sweep → bull points, BSL sweep → bear points. Verified by calling the function headless.
- `SESSIONS` now holds the TJR windows (plus NY AM 10:10–12, NY PM 1:30–4); `ALL_PHASES` is derived from it. Checked minute-by-minute against `getCurrentSession()`: 0 mismatches. 12:00–1:30 and 4–6pm show "Market Closed", same as getCurrentSession.
- Wrote `jc_tjr_backtest_v5.pine`. Not yet run in TradingView.
- Deployed: https://dialflow.github.io/jc-trading/ (repo github.com/DialFlow/jc-trading, Pages from `main` / root). Push from Jacob's own terminal; Claude Code's shell can't do the GitHub sign-in.
- Headless check: Playwright with `channel: 'msedge'` (Edge is preinstalled; Chromium download was slow).

## Instruments: ES1! and NQ1! (Jacob trades these)
- All analysis runs on Yahoo `ES=F` / `NQ=F`, which is the CME front-month E-mini (Dec 26 as of Oct 8): the same contract as TradingView ES1!/NQ1!. `bars.json` carries `contracts` (e.g. "E-Mini S&P 500 Dec 26"); check it around roll weeks, since Yahoo may roll on a different day than TradingView.
- TradingView free embeds refuse every CME futures variant (`CME_MINI:ES1!`, `CME_MINI_DL:ES1!`, `ESZ2026`…; tested Oct 8). So the Charts tab draws its own ES1!/NQ1! candle charts (`drawCandles`, 1m–Daily, FVG boxes, PDH/PDL/Asia/London lines from `sessionLevels`) and links to the live chart in Jacob's TradingView. The ticker tape keeps only real symbols (SPY, QQQ, NVDA, TSLA, gold, BTC). UI labels say ES1!/NQ1!.

## Data feeds (how prices work now)
- **Prices in the page JS:** corsproxy.io now returns 401 without an API key, and free keyless proxies (allorigins, codetabs, thingproxy, cors.lol) all failed. So `.github/workflows/prices.yml` runs `scripts/fetch-prices.mjs` every 5 min Sun–Fri. It batch-fetches Yahoo `/v8/finance/spark` (max 20 symbols per call) for every value in `YAHOO_MAP` and force-pushes `prices.json` to the `data` branch. The page reads `raw.githubusercontent.com/DialFlow/jc-trading/data/prices.json` via `loadPrices()`/`fetchYahoo()`. Prices are delayed ~5–15 min; the freshness pill says "Delayed", never "Live".
- To add a symbol: add it to `YAHOO_MAP` (and `ALL_JOURNAL_SYMS` for the journal); the workflow picks it up automatically.

## Multi-timeframe FVG scan (Dashboard, added Oct 8)
- Replaces clicking through 5m/15m/1H/4H/Daily for HTF FVG respect/disrespect. Candles come from `bars.json` (data branch, written by the same Action as prices; 5m/15m 300 bars, 1h 1300, 1d 250) or the Worker's `/bars` once `JC_API` is set. 4H is built in the page from 1H, anchored to 18:00 ET.
- `scanFVGs`: 3-candle gaps ≥ 0.3× ATR(14). Status: `disrespected` (later candle closed through the far side, so it's an IFVG until a close back through, `invEnd`), `respected` (traded into, never closed through), `untested`.
- `tfBias`: 5 most recent events in the last 60 candles, weights 1/.8/.6/.4/.2. Bull respected or bear disrespected = +1, the reverse = −1. ≥0.3 Bullish, ≤−0.3 Bearish. Overall weights D 3, 4H 2.5, 1H 2, 15m 1, 5m 0.5 (≥0.25 Bullish). It feeds the AI Signal (+1 point to the side) and runs on Refresh.
- The SVG chart per symbol/TF draws the 8 FVGs nearest price.

## TJR confluence checklist (Dashboard, added Oct 8)
- A grid of TJR confluences × 1m/5m/15m/30m/1H/4H for ES or NQ, with a bull/bear ✓ per cell and tap-for-detail. Groups follow TJR's own terms (transcripts in `../TJR Path to Profitability/`): Potential = liquidity sweep + SMT; Confirmation = BOS + IFVG; Continuation = FVG + equilibrium. Time (9:50–10:10 macro) is a global row.
- `confChecks` looks at the last 40 candles per TF and counts only the most recent event per check. Sweep = wick through a 2-bar pivot and close back inside. BOS = latest close through the latest pivot. IFVG = latest disrespected gap not yet voided. FVG = latest gap still holding. EQ = discount/premium of the 40-candle range. SMT (`smtCheck`) = ES vs NQ new low/high in the last 10 candles vs the prior 30.
- A TF is "aligned" at ≥4 of 6 in one direction. ES alignment adds +1 to the AI Signal when ≥2 TFs align.

## Cloud sync + price API (built Oct 8, waiting on Jacob's Cloudflare account)
- `cloudflare/worker.js`: Cloudflare Worker (free plan). `GET /prices?symbols=` (Yahoo spark, 15 s edge cache) and `GET/PUT /sync` (KV binding `JC`, secret `SYNC_KEY`, header `X-Sync-Key`). Stores `{key: {v, t}}`; newest `t` wins per key.
- `index.html`: `const JC_API = ''`. Empty means sync is off and prices come from the GitHub Actions `prices.json`. Set it to the Worker URL to turn both on. `Sync` patches `Storage.prototype.setItem` so writes to `SYNC_KEYS` are timestamped and pushed (2 s debounce). It pulls before `init()` (3 s cap) and on `visibilitychange`, reloading if data changed. A device's first sync merges `jct_journal` (by date) and `jct_trades` (by id); other keys keep the synced copy and back up the local one to `jct_backup_<key>`. The header "Sync" pill prompts for the key. `jct_tab` is deliberately per-device.
- Tested with a Node mock of the Worker and two Playwright contexts (merge, add, delete, wrong key, prices): all passed.
- Setup still to do with Jacob: create Worker → paste worker.js → create KV namespace → bind as `JC` → add secret `SYNC_KEY` → put the workers.dev URL in `JC_API` → push → enter the key on each device (PC first).
- Once live, the GitHub Actions price job can stay as a fallback or be removed.

## Known bugs / open items (priority order)
1. Prices are delayed, not real-time. GitHub's 5-min schedule only ran ~2×/11 h on Oct 7–8; the Cloudflare Worker above fixes this. For live futures numbers in the page you'd need a paid feed (Polygon/Databento) or a Cloudflare Worker proxy (free, but needs Jacob's account).
2. GitHub disables scheduled workflows after 60 days with no repo activity. If prices go stale, re-enable it under Actions → Update prices.
3. Morning Analysis card + Today's Events now come from `analysis.json` (written by Claude on request; card greys out when the date isn't today). The old hardcoded events (CPI, Waller…) were sample data and are gone.

## Real-data backtest (Oct 8)
- `scripts/backtest.mjs` is a bar-by-bar port of `jc_tjr_backtest_v5.pine` on Yahoo 5m ES=F/NQ=F (60 days max). It includes TradingView's intrabar fill path (open → nearer extreme first), limit prices rounded to the tick (longs down, shorts up), 1 tick slippage on stop/market orders and $2.50/side. **Validated:** v4 settings reproduce the TradingView trade list for Aug 16–Oct 7 exactly (7 trades, −$2,760).
- Run `node scripts/backtest.mjs` → `backtest.json` (v4 + 24 v5 combos per symbol; NQ stops ×4). `--validate` prints the ES v4 trade list.
- Results Jul 30–Oct 8 (49 sessions): ES1! 0/24 variations profitable (best −$970; v4 −$1,657.50 on 9 trades). NQ1! 24/24 profitable (+$1,570 to +$11,362.50; v4 −$2,650 because the 60-pt cap skipped setups). 4–21 trades per run, so suggestive only. NQ stops run up to 100 pts = $2,000/contract and the worst DD is ~$5K: check the MFF drawdown limit (MNQ = 1/10).
- The Backtesting tab renders this: symbol + setting pickers, stat tiles, equity curve, funnel, every trade, a comparison table, and a verdict. The follow-up chat context is built from backtest.json; the old chat was cleared once via `jct_bt_ver`.

## Lab tab (simulations, Oct 8): was "Backtesting with AI"; page id still `backtest`
- **One engine:** `scripts/tjr-engine.mjs` (ES module) is the only implementation of the strategy. `backtest.mjs` imports it in Node, and the page imports it with `<script type="module">` (exposed as `window.TJR`, with a `tjr-ready` event). This is a deliberate exception to "single index.html", so live, replay and backtest can never disagree. `--validate` checks TradingView parity, and that replay seeding equals the full run for every session × setting.
- **Robust** = profitable overall + both halves (split at mid-session date) + stress test (fill only after trading 2 ticks through, 3 ticks slippage on stops/market). Oct 8: ES 0/25, NQ 11/25. The Lab's default setting per symbol is the robust one whose weaker half is strongest (ES falls back to v4). The selector marks ✔/✗.
- **Live setup:** runs the engine on bars.json 5m (600 bars = ≥2 sessions for PDH/PDL) and shows the step list, an order ticket with $ risk per full/micro contract, and historical edge (Wilson 90% win-rate band, halves, stress). The banner refuses to show an order when data is >15 min old during 9:00–12:00. The Dashboard has a compact `#live-mini` card; refreshes every 60 s and on Refresh.
- **Account sim:** Monte Carlo, 5,000 paths. Each day trades with probability trades/sessions, bootstrapping real trade pts. EOD trailing drawdown (optionally locks at the starting balance), profit target, optional daily loss limit; full vs micro ($0.75/side). Fan chart plus a size ladder (1/2/3/5 micro, 1/2 full). The MFF defaults ($3,000 target, $2,000 trailing) are editable; confirm them against Jacob's plan.
- **Replay:** `replay.json` holds, per session, the levels at 07:25, 20 lookback candles and 07:30–12:30 candles. The slider re-runs the engine up to the chosen candle ("hide the future" on by default).

## Next backtest ideas (v5)
- Wider stop (20–25 pts) or stop under the second sweep.
- Count a sweep only at one chosen level (e.g. London H/L or PDH/PDL), not any level.
- Require a displacement candle (body > X× average) for the BOS.
- Run the same rules on NQ with a scaled stop (~4× ES).
- Log every run as a new entry in the Backtesting tab thread.

## Working rules for Claude Code
- Keep it one self-contained `index.html` unless Jacob asks to split it.
- After any edit, load the page headless (Playwright) and click all 9 tabs. Zero JS errors is the bar.
- Don't hardcode fake prices or present examples as real data.
- Jacob develops on Windows.
