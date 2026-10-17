// Databento price quote ONLY: asks Databento what each planned download would cost. Downloads and buys nothing.
// Needs a free Databento account and its API key in the environment (never paste the key into chat or a file):
//   PowerShell:  $env:DATABENTO_API_KEY = "db-..."   then   node scripts/databento-quote.mjs
// Uses Databento's metadata.get_cost and metadata.get_billable_size endpoints (historical API, v0).
const KEY = process.env.DATABENTO_API_KEY;
if (!KEY) { console.log('Set DATABENTO_API_KEY first (see the top of this file).'); process.exit(1); }
const auth = 'Basic ' + Buffer.from(KEY + ':').toString('base64');
// The plan (docs/PREREG-tjr1m-v1.md, historical out-of-sample period + an overlap month to cross-check against Yahoo)
const PLAN = [
  { why: '1-minute candles, historical test (the main need)', schema: 'ohlcv-1m', start: '2023-01-01', end: '2026-10-17' },
  { why: 'tick-by-tick trades for realistic fills, last 12 months', schema: 'trades', start: '2025-10-01', end: '2026-10-17' },
  { why: 'tick-by-tick trades, full historical period', schema: 'trades', start: '2023-01-01', end: '2026-10-17' },
  { why: 'contract definitions (roll dates, tick sizes)', schema: 'definition', start: '2023-01-01', end: '2026-10-17' },
];
const base = { dataset: 'GLBX.MDP3', symbols: 'ES.v.0,NQ.v.0', stype_in: 'continuous' };
async function get(path, q) {
  const r = await fetch(`https://hist.databento.com/v0/${path}?` + new URLSearchParams(q), { headers: { Authorization: auth } });
  const t = await r.text(); if (!r.ok) throw new Error(`${path} ${r.status}: ${t.slice(0, 200)}`); return JSON.parse(t);
}
let total = 0;
for (const p of PLAN) {
  const q = { ...base, schema: p.schema, start: p.start, end: p.end };
  try {
    const [cost, size] = await Promise.all([get('metadata.get_cost', q), get('metadata.get_billable_size', q)]);
    total += +cost;
    console.log(`${p.why}\n   ${p.schema} ${p.start} → ${p.end}: $${(+cost).toFixed(2)} usage-based · ${(size / 1e9).toFixed(2)} GB`);
  } catch (e) { console.log(`${p.why}: ${e.message}`); }
}
console.log(`\nAll rows above add up to $${total.toFixed(2)} usage-based (rows 2 and 3 overlap: pick one). New accounts get $125 of free credit.`);
console.log('Nothing was downloaded or charged.');
