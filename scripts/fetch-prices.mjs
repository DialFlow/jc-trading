// Fetches delayed Yahoo data and writes two files into <outdir>:
//   prices.json — last quote for every symbol in index.html's YAHOO_MAP
//   bars.json   — ES/NQ candles (1m, 5m, 15m, 30m, 1h, 1d) for the multi-timeframe FVG scan
// Run by .github/workflows/prices.yml.  Usage: node scripts/fetch-prices.mjs <outdir>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2] || '.';
const UA = { headers: { 'User-Agent': 'Mozilla/5.0' } };

// ---- prices.json ----
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const m = html.match(/const YAHOO_MAP = (\{[\s\S]*?\});/);
if (!m) throw new Error('YAHOO_MAP not found in index.html');
const yahooSyms = [...new Set(Object.values(Function(`return ${m[1]}`)()))];

const BATCH = 20; // Yahoo spark allows at most 20 symbols per request
const quotes = {};
for (let i = 0; i < yahooSyms.length; i += BATCH) {
  const batch = yahooSyms.slice(i, i + BATCH);
  const url = 'https://query1.finance.yahoo.com/v8/finance/spark?range=1d&interval=5m&symbols='
    + encodeURIComponent(batch.join(','));
  const res = await fetch(url, UA);
  if (!res.ok) { console.error(`batch ${i / BATCH}: HTTP ${res.status}`); continue; }
  const data = await res.json();
  for (const [sym, x] of Object.entries(data)) {
    const closes = x.close || [];
    let k = closes.length - 1;
    while (k >= 0 && closes[k] == null) k--;
    if (k < 0) continue;
    quotes[sym] = {
      price: closes[k],
      prev: x.previousClose ?? x.chartPreviousClose ?? closes[k],
      time: x.timestamp[k],
    };
  }
}
const missing = yahooSyms.filter(s => !quotes[s]);
if (missing.length) console.error('missing: ' + missing.join(', '));
if (!Object.keys(quotes).length) process.exit(1);
const updated = Math.floor(Date.now() / 1000);
writeFileSync(join(outDir, 'prices.json'), JSON.stringify({ updated, source: 'Yahoo Finance (delayed)', quotes }));

// ---- bars.json ----  compact rows: [time, open, high, low, close]
const BAR_SPECS = [
  { tf: '1m',  interval: '1m',  range: '2d',  keep: 300 },
  { tf: '5m',  interval: '5m',  range: '5d',  keep: 300 },
  { tf: '15m', interval: '15m', range: '10d', keep: 300 },
  { tf: '30m', interval: '30m', range: '1mo', keep: 300 },
  { tf: '1h',  interval: '60m', range: '3mo', keep: 1300 }, // 4h is built from these in the page
  { tf: '1d',  interval: '1d',  range: '1y',  keep: 250 },
];
const bars = {};
for (const sym of ['ES=F', 'NQ=F']) {
  bars[sym] = {};
  for (const s of BAR_SPECS) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${s.interval}&range=${s.range}&includePrePost=true`;
    const res = await fetch(url, UA);
    if (!res.ok) { console.error(`${sym} ${s.tf}: HTTP ${res.status}`); continue; }
    const r = (await res.json())?.chart?.result?.[0];
    const q = r?.indicators?.quote?.[0];
    if (!r || !q) continue;
    const rows = [];
    r.timestamp.forEach((t, i) => {
      if ([q.open[i], q.high[i], q.low[i], q.close[i]].some(v => v == null)) return;
      rows.push([t, q.open[i], q.high[i], q.low[i], q.close[i]].map((v, j) => j ? Math.round(v * 100) / 100 : v));
    });
    bars[sym][s.tf] = rows.slice(-s.keep);
  }
}
writeFileSync(join(outDir, 'bars.json'), JSON.stringify({ updated, source: 'Yahoo Finance (delayed)', bars }));
