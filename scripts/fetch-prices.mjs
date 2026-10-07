// Fetches delayed quotes from Yahoo for every symbol in index.html's YAHOO_MAP
// and prints prices.json to stdout. Run by .github/workflows/prices.yml.
// Usage: node scripts/fetch-prices.mjs > prices.json
import { readFileSync } from 'node:fs';

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
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
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
process.stdout.write(JSON.stringify({ updated: Math.floor(Date.now() / 1000), source: 'Yahoo Finance (delayed)', quotes }));
