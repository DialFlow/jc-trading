// Backtest of jc_tjr_backtest_v5.pine on real ES1!/NQ1! 5-minute candles (Yahoo ES=F / NQ=F,
// the CME front-month E-mini), using the shared engine in tjr-engine.mjs.
//
// Writes (next to index.html):
//   backtest.json — v4 + 24 v5 settings per symbol: trades, stats, walk-forward halves, execution stress test
//   replay.json   — per session: levels at 07:25 ET + 5m candles 07:30–12:30, for the Lab's session replay
//
// Usage: node scripts/backtest.mjs              write both files
//        node scripts/backtest.mjs --validate   print the ES v4 trade list (compare with TradingView) and check replay seeding
import { writeFileSync } from 'node:fs';
import { INSTR, COMMISSION, SLIP_TICKS, BASE, EXITS, configs, et, run, stats } from './tjr-engine.mjs';

const VALIDATE = process.argv.includes('--validate');
const here = p => new URL('../' + p, import.meta.url);

async function load(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=5m&range=60d&includePrePost=true`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`${sym}: HTTP ${res.status}`);
  const r = (await res.json()).chart.result[0], q = r.indicators.quote[0];
  const bars = [];
  r.timestamp.forEach((t, i) => {
    if ([q.open[i], q.high[i], q.low[i], q.close[i]].some(v => v == null)) return;
    bars.push({ t, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], ...et(t) });
  });
  return { bars, contract: r.meta.longName || r.meta.shortName || sym };
}

const slim = s => { const { equity, ...rest } = s; return rest; };

const out = { generated: new Date().toISOString(), costs: { commissionPerSide: COMMISSION, slippageTicks: SLIP_TICKS, contracts: 1 }, instruments: {}, runs: [] };
const replay = { generated: out.generated, days: {} };

for (const sym of Object.keys(INSTR)) {
  const I = INSTR[sym], data = await load(sym), bars = data.bars;
  const sessions = [...new Set(bars.filter(b => b.m >= 570 && b.m < 610).map(b => b.td))];
  const mid = sessions[Math.floor(sessions.length / 2)];
  out.instruments[sym] = { name: I.name, contract: data.contract, from: bars[0].date, to: bars[bars.length - 1].date,
    nySessions: sessions.length, sessions, splitAt: mid };

  for (const cfg of configs(sym)) {
    const c = { ...BASE, ...cfg };
    const r = run(bars, sym, c);
    const st = stats(r.trades);
    // walk-forward check: same settings, first half of sessions vs second half
    const halves = [r.trades.filter(t => t.td < mid), r.trades.filter(t => t.td >= mid)].map(ts => slim(stats(ts)));
    // execution stress test: limit fills only after trading 2 ticks through; 3 ticks slippage on stops and market exits
    const cons = run(bars, sym, { ...c, fillThrough: 2, slipTicks: 3 });
    // exit rules compared: same entries, different ways out (each with the same robustness checks)
    const exits = {};
    for (const ex of Object.keys(EXITS)) {
      if (ex === 'rules') continue;
      const re = run(bars, sym, { ...c, exitMode: ex }), se = run(bars, sym, { ...c, exitMode: ex, fillThrough: 2, slipTicks: 3 });
      exits[ex] = { trades: re.trades.map(({ td, dir, entryTime, entry, exitTime, exit, stop, target, tp1, scaled, risk, r, mfe, mae, mfeR, maeR, mins, pts, pnl, why }) => ({ td, dir, entryTime, entry, exitTime, exit, stop, target, tp1, scaled, risk, r, mfe, mae, mfeR, maeR, mins, pts, pnl, why })),
        stats: slim(stats(re.trades)), halves: [re.trades.filter(t => t.td < mid), re.trades.filter(t => t.td >= mid)].map(ts => slim(stats(ts))),
        stress: { stats: slim(stats(se.trades)), trades: se.trades.map(t => ({ td: t.td, pts: t.pts, pnl: t.pnl, r: t.r })) } };
    }
    out.runs.push({ sym, name: I.name, ...cfg, trades: r.trades, funnel: r.funnel, skipped: r.skipped, stats: slim(st), equity: st.equity,
      halves, stress: { stats: slim(stats(cons.trades)), trades: cons.trades.map(t => ({ td: t.td, pts: t.pts, pnl: t.pnl, r: t.r })) }, exits });
  }

  // replay data: levels as of the 07:25 bar (from a full run), then candles 07:30–12:30
  const full = run(bars, sym, { ...BASE, ...configs(sym)[0] }, { snapshots: true });
  replay.days[sym] = {};
  for (const td of sessions) {
    const idx = bars.findIndex(b => b.td === td && b.m === 445); // 07:25
    if (idx < 0) continue;
    const s = full.snapshots[idx];
    const seed = { aH: s.levels.asianH, aL: s.levels.asianL, lH: s.levels.londonH, lL: s.levels.londonL, pdH: s.levels.pdH, pdL: s.levels.pdL, dH: s.levels.dH, dL: s.levels.dL, mOpen: s.levels.mOpen };
    const day = bars.filter((b, i) => i > idx && b.td === td && b.m <= 750); // 07:30–12:30
    // 20 candles before 07:30 for the displacement average and the 5-bar BOS lookback
    const pre = bars.slice(Math.max(0, idx - 19), idx + 1);
    replay.days[sym][td] = { seed, seedPrevM: 445, pre: pre.map(b => [b.t, b.o, b.h, b.l, b.c]), bars: day.map(b => [b.t, b.o, b.h, b.l, b.c]) };
  }

  if (VALIDATE) {
    const v4 = out.runs.find(r => r.sym === sym && r.id === 'v4');
    console.log(`${I.name} v4 funnel`, v4.funnel, 'stats', v4.stats.trades, 'trades', v4.stats.net);
    if (sym === 'ES=F') for (const t of v4.trades) console.log('  ', t.dir.padEnd(5), t.entryTime, t.entry, '->', t.exitTime, t.exit, t.why.padEnd(10), t.pnl);
    // replay seeding must reproduce the full-history run exactly, for every setting
    let bad = 0;
    for (const ex of Object.keys(EXITS)) for (const cfg of configs(sym)) {
      const c = { ...BASE, ...cfg, exitMode: ex }, ref = ex === 'rules' ? out.runs.find(r => r.sym === sym && r.id === cfg.id).trades : run(bars, sym, c).trades;
      for (const [td, d] of Object.entries(replay.days[sym])) {
        const { toBars } = await import('./tjr-engine.mjs');
        const rb = toBars([...d.pre, ...d.bars]);
        const rr = run(rb, sym, c, { seed: d.seed, seedFrom: d.pre.length });
        const a = JSON.stringify(rr.trades.map(t => [t.entryTime, t.entry, t.exit, t.pnl]));
        const b = JSON.stringify(ref.filter(t => t.td === td).map(t => [t.entryTime, t.entry, t.exit, t.pnl]));
        if (a !== b) { bad++; if (bad <= 3) console.log('  replay mismatch', cfg.id, td, a, b); }
      }
    }
    console.log(`  replay seeding check: ${bad ? bad + ' mismatches' : 'all sessions × all settings match the full run'}`);
  }
}
if (!VALIDATE) {
  writeFileSync(here('backtest.json'), JSON.stringify(out));
  writeFileSync(here('replay.json'), JSON.stringify(replay));
  console.log('wrote backtest.json', out.runs.length, 'runs; replay.json', Object.values(replay.days).map(d => Object.keys(d).length).join('/'), 'sessions');
}
