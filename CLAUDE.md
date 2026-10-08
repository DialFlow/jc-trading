# JC Trading — project handoff (updated Wed Oct 7, 2026, Claude Code session)

## What this is
A single-file personal trading dashboard (`index.html`) for Jacob, who day-trades ES/NQ futures on a MyFundedFutures $50K funded (sim) account using TJR's methodology. It started in claude.ai as an artifact ("JC Trading", Version 6). This folder is now the source of truth.

## Files
- `index.html`: the whole site. HTML + CSS + JS in one file, no build step. All user data is saved in `localStorage` (keys prefixed `jct_`).
- `jc_tjr_backtest_v4.pine`: the TradingView Pine Script v6 strategy used for the backtest.
- `jc_tjr_backtest_v5.pine`: v4 plus toggles for stop mode (sweep wick / fixed points / second sweep), sweep level (Any / London / Asian / PDH-PDL) and a displacement filter on the BOS. Not yet run in TradingView. v4 settings reproduce v4 (Sweep wick, max stop 15, Any, displacement off).
- `.nojekyll`, `.gitignore`: for GitHub Pages. Folder is a git repo on `main`.
- `bt/`: the 4 annotated TradingView screenshots the Backtesting tab loads (`bt/01-…jpg` to `bt/04-…jpg`).

## Design system (keep it)
Apple HIG look: black/white/light gray, Inter, iOS system colors as CSS tokens on `:root` (`--bull`, `--bear`, `--warn`, `--blue`…). Light/dark via `prefers-color-scheme` plus `data-theme`. Cards, segmented controls, pill badges.

## Tabs (9)
Dashboard, Charts, Morning Journal, Daily Bias, Key Levels, Strategy, Trade Log, Edge, Backtesting with AI.
Tab switching: `showPage(name)` plus the `tabNames` array in the same order as the buttons. Add new tabs to both.

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

## Data feeds (how prices work now)
- **Charts:** free TradingView embeds can't show CME futures (ES1!/NQ1!, GC1!) or CBOE VIX ("only available on TradingView"). The Charts tab uses CFD proxies, labelled as such: `OANDA:SPX500USD`, `OANDA:NAS100USD`, `CAPITALCOM:VIX`, `OANDA:XAUUSD`. Also embeddable: `CAPITALCOM:DXY`. The Technical Analysis widget has no data for any CFD, so it uses `AMEX:SPY` / `NASDAQ:QQQ`.
- **Prices in the page JS:** corsproxy.io now returns 401 without an API key, and free keyless proxies (allorigins, codetabs, thingproxy, cors.lol) all failed. So `.github/workflows/prices.yml` runs `scripts/fetch-prices.mjs` every 5 min Sun–Fri. It batch-fetches Yahoo `/v8/finance/spark` (max 20 symbols per call) for every value in `YAHOO_MAP` and force-pushes `prices.json` to the `data` branch. The page reads `raw.githubusercontent.com/DialFlow/jc-trading/data/prices.json` via `loadPrices()`/`fetchYahoo()`. Prices are delayed ~5–15 min; the freshness pill says "Delayed", never "Live".
- To add a symbol: add it to `YAHOO_MAP` (and `ALL_JOURNAL_SYMS` for the journal); the workflow picks it up automatically.

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
