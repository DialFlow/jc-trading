// Exit study: same entries (the Lab model's site-default setting per contract), different ways out.
// For every trade: risk (R), how far price went in your favour before the stop / 12:00 (MFE in R), and the result of
// each exit plan replayed on the real 5m candles after the fill. Conservative: a candle that touches both the stop
// and a target counts the stop first; on the fill candle only the stop counts. Costs $2.50/side, 1 tick slippage on stops.
// Usage: node scripts/exit-study.mjs  → prints a table (and exits.json next to index.html)
import { readFileSync, writeFileSync } from 'node:fs';
import { BASE, INSTR, run, toBars, stats } from './tjr-engine.mjs';
const here = p => new URL('../' + p, import.meta.url);
const BT = JSON.parse(readFileSync(here('backtest.json'), 'utf8'));
const MODEL = { bosMode: 'bars5', watchStart: 510, watchEnd: 660, entryStart: 590, entryEnd: 660, restEnd: 690, maxTrades: 1 };
const isRobust = r => r.stats.net > 0 && r.halves[0].net > 0 && r.halves[1].net > 0 && r.stress.stats.net > 0;
const weak = r => Math.min(r.halves[0].net, r.halves[1].net);
async function load(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=5m&range=60d&includePrePost=true`;
  const j = (await (await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })).json()).chart.result[0], q = j.indicators.quote[0];
  const rows = []; j.timestamp.forEach((t, i) => { if ([q.open[i], q.high[i], q.low[i], q.close[i]].every(v => v != null)) rows.push([t, q.open[i], q.high[i], q.low[i], q.close[i]]); });
  return toBars(rows);
}
// plan = list of [fraction, R target] legs; be = move the stop to break-even after the first leg fills; beAt2 = after the 2nd leg the stop goes to +1R
const PLANS = [
  ['All out at 1R', [[1, 1]]], ['All out at 1.5R', [[1, 1.5]]], ['All out at 2R', [[1, 2]]], ['All out at 3R', [[1, 3]]],
  ['½ at 1R, ½ at 2R (BE)', [[0.5, 1], [0.5, 2]], true], ['½ at 1R, ½ at 3R (BE)', [[0.5, 1], [0.5, 3]], true],
  ['⅓ at 1R · ⅓ at 2R · ⅓ at 3R (BE, then +1R)', [[1 / 3, 1], [1 / 3, 2], [1 / 3, 3]], true, true],
  ['½ at 1R, rest to 12:00 (BE)', [[0.5, 1], [0.5, 99]], true],
];
function simulate(bars, i0, dir, entry, stop0, legs, be, beAt2, tick) {
  const lng = dir === 'long', risk = Math.abs(entry - stop0); let stop = stop0, open = legs.map(([f, r]) => ({ f, px: lng ? entry + r * risk : entry - r * risk, done: false })), pts = 0, filledLegs = 0;
  for (let k = i0; k < bars.length; k++) {
    const b = bars[k]; if (b.td !== bars[i0].td) break;
    if (b.m >= 725 || (b.m >= 720 && k > i0)) { for (const l of open) if (!l.done) { pts += l.f * (lng ? b.o - entry : entry - b.o); l.done = true; } return pts; } // 12:00 flat at the next open
    if (lng ? b.l <= stop : b.h >= stop) { const x = lng ? stop - tick : stop + tick; for (const l of open) if (!l.done) { pts += l.f * (lng ? x - entry : entry - x); l.done = true; } return pts; }
    if (k === i0) continue;
    for (const l of open) if (!l.done && (lng ? b.h >= l.px : b.l <= l.px)) { pts += l.f * Math.abs(l.px - entry); l.done = true; filledLegs++;
      if (be && filledLegs === 1) stop = entry; if (beAt2 && filledLegs === 2) stop = lng ? entry + risk : entry - risk; }
    if (open.every(l => l.done)) return pts;
  }
  const last = bars[bars.length - 1]; for (const l of open) if (!l.done) pts += l.f * (lng ? last.c - entry : entry - last.c); return pts;
}
const out = { generated: new Date().toISOString(), syms: {} };
for (const sym of ['NQ=F', 'ES=F']) {
  const I = INSTR[sym], bars = await load(sym), runs = BT.runs.filter(r => r.sym === sym);
  const r0 = runs.filter(isRobust).sort((a, b) => weak(b) - weak(a))[0] || runs.find(x => x.id === 'v4');
  const res = run(bars, sym, { ...BASE, ...r0, ...MODEL, exitMode: 'rules' }), cur = run(bars, sym, { ...BASE, ...r0, ...MODEL, exitMode: sym === 'NQ=F' ? 'scale' : 'rules' });
  const fills = res.events.filter(e => e.type === 'fill');
  const trades = res.trades.map((t, n) => ({ ...t, i0: bars.findIndex(b => b.t === fills[n].t) }));
  const pv = I.pointValue, cost = 2 * 2.5;
  const R = t => Math.abs(t.entry - t.stop);
  const rows = [['What the site uses now', cur.trades.map(t => t.pnl)]];
  for (const [name, legs, be, beAt2] of PLANS) rows.push([name, trades.map(t => +(simulate(bars, t.i0, t.dir, t.entry, t.stop, legs, be, beAt2, I.tick) * pv - cost).toFixed(2))]);
  const sum = pnls => { const s = stats(pnls.map(p => ({ pnl: p, r: 0 }))); return { n: s.trades, winRate: +s.winRate.toFixed(3), net: s.net, pf: s.pf, maxDD: s.maxDD, avg: s.expectancy }; };
  const reach = [0.5, 1, 1.5, 2, 3].map(k => [k, trades.filter(t => t.mfeR >= k).length]);
  const plannedR = trades.map(t => Math.abs(t.target - t.entry) / R(t));
  out.syms[sym] = { setting: r0.id, trades: trades.length, avgRiskPts: +(trades.reduce((a, t) => a + R(t), 0) / trades.length).toFixed(1), plannedR: +(plannedR.reduce((a, v) => a + v, 0) / plannedR.length).toFixed(2),
    reach, plans: rows.map(([n, p]) => ({ plan: n, ...sum(p) })) };
  console.log(`\n${I.name} · ${r0.id} · ${trades.length} trades · avg risk ${out.syms[sym].avgRiskPts} pts ($${Math.round(out.syms[sym].avgRiskPts * pv)}/contract) · avg planned target ${out.syms[sym].plannedR}R`);
  console.log('  reached in your favour before stop/12:00: ' + reach.map(([k, n]) => `${k}R ${Math.round(n / trades.length * 100)}%`).join(' · '));
  for (const p of out.syms[sym].plans) console.log(`  ${p.plan.padEnd(44)} net ${String(p.net).padStart(9)}  win ${Math.round(p.winRate * 100)}%  PF ${p.pf}  avg ${p.avg}  maxDD ${p.maxDD}`);
}
writeFileSync(here('exits.json'), JSON.stringify(out));
