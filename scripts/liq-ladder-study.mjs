// Liquidity-ladder exit study. Same entries as the Lab model; exits laddered at the liquidity pools the rules know at
// order time (Asian / London / prior-day highs & lows, midnight open, NY high/low since 9:30), compared with the site's
// current scale-out. Run for every NQ setting and ES, with the Lab's robustness checks (both halves of the period, and
// a stress test: limit fills only after trading 2 ticks through, 3 ticks slippage on stops).
// Conservative fills: stop before target when a candle touches both; on the fill candle only the stop counts; 12:00 flat.
// Usage: node scripts/liq-ladder-study.mjs   → prints the comparison and writes ladder.json next to index.html
import { readFileSync, writeFileSync } from 'node:fs';
import { BASE, run, toBars } from './tjr-engine.mjs';
const here = p => new URL('../' + p, import.meta.url);
const BT = JSON.parse(readFileSync(here('backtest.json'), 'utf8'));
const MODEL = { bosMode: 'bars5', watchStart: 510, watchEnd: 660, entryStart: 590, entryEnd: 660, restEnd: 690, maxTrades: 1 };
const isRobust = r => r.stats.net > 0 && r.halves[0].net > 0 && r.halves[1].net > 0 && r.stress.stats.net > 0;
const weak = r => Math.min(r.halves[0].net, r.halves[1].net);
const PV = { 'ES=F': 50, 'NQ=F': 20 }, TICK = 0.25;
async function load(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=5m&range=60d&includePrePost=true`;
  const j = (await (await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })).json()).chart.result[0], q = j.indicators.quote[0];
  const rows = []; j.timestamp.forEach((t, i) => { if ([q.open[i], q.high[i], q.low[i], q.close[i]].every(v => v != null)) rows.push([t, q.open[i], q.high[i], q.low[i], q.close[i]]); });
  return toBars(rows);
}
// legs: [[fraction, price]], moves: after leg n fills, the stop moves to moves[n] (a price) if given
function sim(bars, i0, dir, entry, stop0, legs, moves, slip) {
  const lng = dir === 'long'; let stop = stop0, pts = 0, filled = 0; const open = legs.map(([f, px]) => ({ f, px, done: false }));
  for (let k = i0; k < bars.length; k++) {
    const b = bars[k]; if (b.td !== bars[i0].td) break;
    if (b.m >= 725 || (b.m >= 720 && k > i0)) { for (const l of open) if (!l.done) { pts += l.f * (lng ? b.o - entry : entry - b.o); l.done = true; } return pts; }
    if (lng ? b.l <= stop : b.h >= stop) { const x = lng ? stop - slip : stop + slip; for (const l of open) if (!l.done) { pts += l.f * (lng ? x - entry : entry - x); l.done = true; } return pts; }
    if (k === i0) continue;
    for (const l of open) if (!l.done && (lng ? b.h >= l.px : b.l <= l.px)) { pts += l.f * Math.abs(l.px - entry); l.done = true; filled++; if (moves[filled - 1] != null) stop = moves[filled - 1]; }
    if (open.every(l => l.done)) return pts;
  }
  const last = bars[bars.length - 1]; for (const l of open) if (!l.done) pts += l.f * (lng ? last.c - entry : entry - last.c); return pts;
}
// liquidity pools beyond the entry at order time, nearest first (deduplicated within 2 ticks)
function poolsFor(snap, lng, from) {
  const L = snap.levels, ps = [L.asianH, L.asianL, L.londonH, L.londonL, L.pdH, L.pdL, L.mOpen, L.nyH, L.nyL]
    .filter(p => p != null && !Number.isNaN(p) && (lng ? p >= from : p <= from)).sort((a, b) => lng ? a - b : b - a);
  return ps.filter((p, i) => !i || Math.abs(p - ps[i - 1]) > 2 * TICK);
}
const PLANS = {
  current: 'Current: ½ at first liquidity ≥1R, ½ to target',
  ladder3: 'Liquidity ladder ⅓ · ⅓ · ⅓',
  ladder2: 'Liquidity ladder ½ · ½',
  early: 'Early half: ½ at first liquidity ≥0.5R, ½ to target',
};
function plansFor(t, snap) {
  const lng = t.dir === 'long', e = t.entry, risk = Math.abs(e - t.stop), at = r => lng ? e + r * risk : e - r * risk;
  const tgt = t.target, beyond = (p, q) => lng ? p > q : p < q;
  const pools1 = poolsFor(snap, lng, at(1)), L1 = pools1.length && beyond(tgt, pools1[0]) ? pools1[0] : at(1);
  const L2c = poolsFor(snap, lng, L1 + (lng ? TICK : -TICK)).find(p => beyond(p, L1)), L2 = L2c != null && beyond(tgt, L2c) ? L2c : tgt;
  const p05 = poolsFor(snap, lng, at(0.5)), E1 = p05.length && beyond(tgt, p05[0]) ? p05[0] : at(1);
  return {
    current: [[[0.5, L1], [0.5, tgt]], [e]],
    ladder3: [[[1 / 3, L1], [1 / 3, L2], [1 / 3, tgt]], [e, L1]],
    ladder2: [[[0.5, L1], [0.5, L2]], [e]],
    early: [[[0.5, E1], [0.5, tgt]], [e]],
  };
}
const summ = arr => { let eq = 0, pk = 0, dd = 0; for (const p of arr) { eq += p; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
  const w = arr.filter(p => p > 0), l = arr.filter(p => p <= 0), gw = w.reduce((a, v) => a + v, 0), gl = -l.reduce((a, v) => a + v, 0);
  return { n: arr.length, net: Math.round(eq), win: arr.length ? +(w.length / arr.length).toFixed(3) : 0, pf: gl ? +(gw / gl).toFixed(2) : null, maxDD: Math.round(dd), avgWin: w.length ? Math.round(gw / w.length) : 0, avgLoss: l.length ? Math.round(-gl / l.length) : 0 }; };
const out = { generated: new Date().toISOString(), plans: PLANS, syms: {} };
for (const sym of ['NQ=F', 'ES=F']) {
  const bars = await load(sym), runs = BT.runs.filter(r => r.sym === sym), pv = PV[sym];
  const sessions = [...new Set(bars.filter(b => b.m >= 570 && b.m < 610).map(b => b.td))], mid = sessions[Math.floor(sessions.length / 2)];
  const def = (runs.filter(isRobust).sort((a, b) => weak(b) - weak(a))[0] || runs.find(x => x.id === 'v4')).id;
  const perSetting = [], all = Object.fromEntries(Object.keys(PLANS).map(k => [k, []]));
  for (const r of runs) {
    const one = (stress) => {
      const cfg = { ...BASE, ...r, ...MODEL, exitMode: 'rules', ...(stress ? { fillThrough: 2, slipTicks: 3 } : {}) };
      const res = run(bars, sym, cfg, { snapshots: true }), fills = res.events.filter(e => e.type === 'fill'), orders = res.events.filter(e => e.type === 'order');
      const by = Object.fromEntries(Object.keys(PLANS).map(k => [k, []]));
      res.trades.forEach((t, n) => { const f = fills[n], o = orders.filter(e => e.t <= f.t).pop(), i0 = bars.findIndex(b => b.t === f.t), snap = res.snapshots[bars.findIndex(b => b.t === o.t)];
        const P = plansFor(t, snap);
        for (const k of Object.keys(PLANS)) by[k].push({ td: t.td, pnl: sim(bars, i0, t.dir, t.entry, t.stop, P[k][0], P[k][1], (stress ? 3 : 1) * TICK) * pv - 5 }); });
      return by;
    };
    const base = one(false), str = one(true), row = { id: r.id, plans: {} };
    for (const k of Object.keys(PLANS)) {
      const p = base[k].map(x => x.pnl);
      row.plans[k] = { ...summ(p), h1: Math.round(base[k].filter(x => x.td < mid).reduce((a, x) => a + x.pnl, 0)), h2: Math.round(base[k].filter(x => x.td >= mid).reduce((a, x) => a + x.pnl, 0)), stress: Math.round(str[k].reduce((a, x) => a + x.pnl, 0)) };
      row.plans[k].robust = row.plans[k].net > 0 && row.plans[k].h1 > 0 && row.plans[k].h2 > 0 && row.plans[k].stress > 0;
      all[k].push(...p);
    }
    perSetting.push(row);
  }
  const cmp = k => ({ beatsCurrentNet: perSetting.filter(s => s.plans[k].net >= s.plans.current.net).length, smallerDD: perSetting.filter(s => s.plans[k].maxDD < s.plans.current.maxDD).length,
    robust: perSetting.filter(s => s.plans[k].robust).length, of: perSetting.length });
  out.syms[sym] = { default: def, defaultRow: perSetting.find(s => s.id === def), allTrades: Object.fromEntries(Object.keys(PLANS).map(k => [k, summ(all[k])])), compare: Object.fromEntries(Object.keys(PLANS).map(k => [k, cmp(k)])) };
  const D = out.syms[sym].defaultRow.plans;
  console.log(`\n${sym} · site setting ${def}`);
  for (const k of Object.keys(PLANS)) console.log(`  ${PLANS[k].padEnd(52)} net ${String(D[k].net).padStart(7)} win ${Math.round(D[k].win * 100)}% PF ${D[k].pf} maxDD ${D[k].maxDD} halves ${D[k].h1}/${D[k].h2} stress ${D[k].stress} avgWin ${D[k].avgWin} avgLoss ${D[k].avgLoss}`);
  console.log(`  all ${perSetting.length} settings, ${all.current.length} trades:`);
  for (const k of Object.keys(PLANS)) { const A = out.syms[sym].allTrades[k], C = out.syms[sym].compare[k];
    console.log(`  ${PLANS[k].padEnd(52)} net ${String(A.net).padStart(8)} win ${Math.round(A.win * 100)}% PF ${A.pf} · robust ${C.robust}/${C.of} · ≥ current net in ${C.beatsCurrentNet}/${C.of} · smaller DD in ${C.smallerDD}/${C.of}`); }
}
writeFileSync(here('ladder.json'), JSON.stringify(out));
