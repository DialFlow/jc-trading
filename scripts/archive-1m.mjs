// 1-minute candle archive: Yahoo only keeps 1m data for ~30 days, so this saves it before it ages out.
// Writes <outDir>/1m/<ES|NQ>/<YYYY-MM-DD>.json (ET calendar date) as [[t, o, h, l, c], ...] (t = UTC seconds),
// merging with any file already there, so re-running is safe and a missed day is filled on the next run.
// Usage: node scripts/archive-1m.mjs <outDir> [days back, default 7] [seed.json:SYM ...]
//   seed files (e.g. ../market-data/ES-1m.json:ES) are merged in too, for a one-time backfill.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2], daysBack = +(process.argv[3] || 7), seeds = process.argv.slice(4);
if (!outDir) { console.error('usage: node scripts/archive-1m.mjs <outDir> [daysBack] [seed.json:SYM ...]'); process.exit(1); }
const SYMS = { ES: 'ES=F', NQ: 'NQ=F' };
const etDate = t => new Date(t * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

async function fetchYahoo(sym, days) {
  const rows = new Map(), now = Math.floor(Date.now() / 1000);
  // Yahoo serves 1m in windows of at most 7 days
  for (let end = now; end > now - days * 86400; end -= 7 * 86400) {
    const start = Math.max(end - 7 * 86400, now - days * 86400);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&period1=${start}&period2=${end}&includePrePost=true`;
    const j = await (await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })).json();
    const r = j.chart && j.chart.result && j.chart.result[0];
    if (!r || !r.timestamp) { console.log(sym, 'no data for', new Date(start * 1000).toISOString().slice(0, 10), JSON.stringify(j.chart && j.chart.error)); continue; }
    const q = r.indicators.quote[0];
    r.timestamp.forEach((t, i) => { if ([q.open[i], q.high[i], q.low[i], q.close[i]].every(v => v != null)) rows.set(t, [t, q.open[i], q.high[i], q.low[i], q.close[i]]); });
  }
  return [...rows.values()];
}

const bySym = { ES: [], NQ: [] };
for (const s of seeds) { const [file, k] = s.split(/:(?=[A-Z]+$)/); bySym[k].push(...JSON.parse(readFileSync(file, 'utf8'))); }
for (const [k, sym] of Object.entries(SYMS)) bySym[k].push(...await fetchYahoo(sym, daysBack));

for (const [k, rows] of Object.entries(bySym)) {
  const days = new Map();
  for (const r of rows) { const d = etDate(r[0]); if (!days.has(d)) days.set(d, new Map()); days.get(d).set(r[0], r); }
  const dir = join(outDir, '1m', k); mkdirSync(dir, { recursive: true });
  let wrote = 0;
  for (const [d, m] of days) {
    const f = join(dir, `${d}.json`);
    if (existsSync(f)) for (const r of JSON.parse(readFileSync(f, 'utf8'))) if (!m.has(r[0])) m.set(r[0], r);
    writeFileSync(f, JSON.stringify([...m.values()].sort((a, b) => a[0] - b[0])));
    wrote++;
  }
  console.log(k, rows.length, 'bars in', wrote, 'day files');
}
