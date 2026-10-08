// Structure study: are we missing trades? Re-runs the strategy with every structure variant
// (BOS rule × time window × setups per day) across all 25 stop/level settings and two exits,
// with the same robustness checks as the backtest (overall, both halves, stress test).
// Usage: node scripts/structure-study.mjs   → structure.json next to index.html
import { writeFileSync } from 'node:fs';
import { INSTR, BASE, configs, et, run, stats } from './tjr-engine.mjs';

const WINDOWS = {
  std: { label: 'Standard: sweep after 9:30, enter 9:50–10:10', watchStart: 570, watchEnd: 610, entryStart: 590, entryEnd: 610, restEnd: 660 },
  am: { label: 'NY AM: sweep after 9:30, enter 9:50–11:00', watchStart: 570, watchEnd: 660, entryStart: 590, entryEnd: 660, restEnd: 690 },
  pre: { label: 'From 8:30: pre-open sweeps count, enter 9:50–11:00', watchStart: 510, watchEnd: 660, entryStart: 590, entryEnd: 660, restEnd: 690 },
};
const VARIANTS = [];
for (const fr of [false, true]) for (const bos of ['bars5', 'swing']) for (const w of Object.keys(WINDOWS)) for (const mt of [1, 2])
  VARIANTS.push({ id: `${bos}|${w}|${mt}${fr ? '|fresh' : ''}`, bosMode: bos, win: w, maxTrades: mt, freshLevels: fr, label: `${bos === 'swing' ? 'Swing BOS' : '5-candle BOS'} · ${WINDOWS[w].label} · ${mt} setup${mt > 1 ? 's' : ''}/day${fr ? ' · fresh levels only' : ''}` });

async function load(sym) {
  const r = (await (await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=5m&range=60d&includePrePost=true`, { headers: { 'User-Agent': 'Mozilla/5.0' } })).json()).chart.result[0];
  const q = r.indicators.quote[0];
  return r.timestamp.map((t, i) => ({ t, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] })).filter(x => [x.o, x.h, x.l, x.c].every(v => v != null)).map(x => ({ ...x, ...et(x.t) }));
}
const slim = s => { const { equity, ...rest } = s; return rest; };
const out = { generated: new Date().toISOString(), windows: WINDOWS, variants: VARIANTS, syms: {} };
for (const sym of Object.keys(INSTR)) {
  const bars = await load(sym);
  const sessions = [...new Set(bars.filter(b => b.m >= 570 && b.m < 610).map(b => b.td))], mid = sessions[sessions.length >> 1];
  const res = { sessions: sessions.length, from: sessions[0], to: sessions.at(-1), variants: {} };
  for (const V of VARIANTS) {
    const rows = [];
    for (const cfg of configs(sym)) for (const exitMode of ['rules', 'scale']) {
      const c = { ...BASE, ...cfg, ...WINDOWS[V.win], bosMode: V.bosMode, maxTrades: V.maxTrades, freshLevels: V.freshLevels, exitMode };
      const r = run(bars, sym, c), st = stats(r.trades);
      const h = [r.trades.filter(t => t.td < mid), r.trades.filter(t => t.td >= mid)].map(ts => stats(ts).net);
      const sx = stats(run(bars, sym, { ...c, fillThrough: 2, slipTicks: 3 }).trades).net;
      rows.push({ cfg: cfg.id, exit: exitMode, n: st.trades, wins: st.wins, net: st.net, pf: st.pf, exp: st.expectancy, maxDD: st.maxDD, h1: h[0], h2: h[1], stress: sx,
        robust: st.net > 0 && h[0] > 0 && h[1] > 0 && sx > 0, days: new Set(r.trades.map(t => t.td)).size,
        trades: r.trades.map(t => ({ td: t.td, dir: t.dir, entryTime: t.entryTime, entry: t.entry, exit: t.exit, pts: t.pts, pnl: t.pnl, r: t.r, why: t.why })) });
    }
    const rob = rows.filter(x => x.robust).sort((a, b) => Math.min(b.h1, b.h2) - Math.min(a.h1, a.h2));
    const avgN = rows.reduce((a, x) => a + x.n, 0) / rows.length;
    res.variants[V.id] = { robust: rob.length, of: rows.length, avgTrades: +avgN.toFixed(1), sumNet: Math.round(rows.reduce((a, x) => a + x.net, 0)),
      positive: rows.filter(x => x.net > 0).length, best: rob[0] || null, rows: rows.map(({ trades, ...x }) => x) };
    const b = rob[0];
    console.log(`${INSTR[sym].name} ${V.id.padEnd(16)} avg trades ${avgN.toFixed(1).padStart(5)} · robust ${String(rob.length).padStart(2)}/${rows.length} · profitable ${String(res.variants[V.id].positive).padStart(2)} · sum net ${String(Math.round(rows.reduce((a, x) => a + x.net, 0))).padStart(8)}${b ? ` · best ${b.cfg}/${b.exit} n=${b.n} net ${b.net} H ${b.h1}/${b.h2} stress ${b.stress}` : ''}`);
  }
  out.syms[sym] = res;
}
writeFileSync(new URL('../structure.json', import.meta.url), JSON.stringify(out));
console.log('wrote structure.json');
