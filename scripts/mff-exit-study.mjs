// MFF pass study: which exit plan gives the best chance of passing the MyFundedFutures Rapid EOD 50K evaluation with 3 MNQ?
// Same entries as the site (NQ default setting, Lab model); each exit plan is replayed on the real 5m candles (conservative:
// a candle touching both the stop and a target counts the stop first). Then 10,000 shuffled paths per plan: each session
// trades with probability trades/sessions, drawing a random real trade. Rules: start $50,000, $2,000 trailing drawdown
// from the highest end-of-day balance, floor stops rising at $50,100; pass = +$3,000, 4+ trading days, no day over 30% of
// the profit. A trade first dips to its worst open loss (MAE from the rules run, capped at the stop) and fails the account
// if that touches the floor. 3 MNQ = 0.3 × the NQ result, micro costs $0.75/side.
// Usage: JC_CACHE=<dir> node scripts/mff-exit-study.mjs  → prints a table and writes mffexits.json next to index.html
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { BASE, INSTR, run, toBars } from './tjr-engine.mjs';
const here = p => new URL('../' + p, import.meta.url);
const BT = JSON.parse(readFileSync(here('backtest.json'), 'utf8'));
const MODEL = { bosMode: 'bars5', watchStart: 510, watchEnd: 660, entryStart: 590, entryEnd: 660, restEnd: 690, maxTrades: 1 };
const SYM = 'NQ=F', I = INSTR[SYM], SIZE = 3, MICRO = 0.1, MICRO_COST = 2 * 0.75, NQ_COST = 2 * 2.5;
const PATHS = 10000, DAYS = [30, 60];
const ACCT = { start: 50000, mll: 2000, lockAt: 50100, target: 3000, minDays: 4, consistency: 0.30 };

async function load(sym) {
  const cache = process.env.JC_CACHE && `${process.env.JC_CACHE}/${sym}-5m.json`;
  if (cache && existsSync(cache)) return toBars(JSON.parse(readFileSync(cache, 'utf8')));
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=5m&range=60d&includePrePost=true`;
  const j = (await (await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })).json()).chart.result[0], q = j.indicators.quote[0];
  const rows = []; j.timestamp.forEach((t, i) => { if ([q.open[i], q.high[i], q.low[i], q.close[i]].every(v => v != null)) rows.push([t, q.open[i], q.high[i], q.low[i], q.close[i]]); });
  if (cache) writeFileSync(cache, JSON.stringify(rows));
  return toBars(rows);
}
// same leg replay as scripts/exit-study.mjs: legs = [fraction, R target]; be = stop to break-even after the 1st leg; beAt2 = stop to +1R after the 2nd
function simulate(bars, i0, dir, entry, stop0, legs, be, beAt2, tick) {
  const lng = dir === 'long', risk = Math.abs(entry - stop0); let stop = stop0, pts = 0, filledLegs = 0;
  const open = legs.map(([f, r]) => ({ f, px: lng ? entry + r * risk : entry - r * risk, done: false }));
  for (let k = i0; k < bars.length; k++) {
    const b = bars[k]; if (b.td !== bars[i0].td) break;
    if (b.m >= 725 || (b.m >= 720 && k > i0)) { for (const l of open) if (!l.done) { pts += l.f * (lng ? b.o - entry : entry - b.o); l.done = true; } return pts; }
    if (lng ? b.l <= stop : b.h >= stop) { const x = lng ? stop - tick : stop + tick; for (const l of open) if (!l.done) { pts += l.f * (lng ? x - entry : entry - x); l.done = true; } return pts; }
    if (k === i0) continue;
    for (const l of open) if (!l.done && (lng ? b.h >= l.px : b.l <= l.px)) { pts += l.f * Math.abs(l.px - entry); l.done = true; filledLegs++;
      if (be && filledLegs === 1) stop = entry; if (beAt2 && filledLegs === 2) stop = lng ? entry + risk : entry - risk; }
    if (open.every(l => l.done)) return pts;
  }
  const last = bars[bars.length - 1]; for (const l of open) if (!l.done) pts += l.f * (lng ? last.c - entry : entry - last.c); return pts;
}
const PLANS = [
  ['Today: half at first liquidity ≥1R, rest to target', 'site'],
  ['Half at 1R, half at 2R (stop to BE)', [[0.5, 1], [0.5, 2]], true],
  ['⅓ at 1R · ⅓ at 2R · ⅓ at 3R (BE, then +1R)', [[1 / 3, 1], [1 / 3, 2], [1 / 3, 3]], true, true],
  ['Half at 1R, rest to 12:00 (stop to BE)', [[0.5, 1], [0.5, 99]], true],
  ['All out at 1R', [[1, 1]]],
  ['All out at 2R', [[1, 2]]],
];
const mnq = nqUsd => SIZE * ((nqUsd + NQ_COST) * MICRO - MICRO_COST); // NQ $ after costs → 3 MNQ $ after micro costs

const bars = await load(SYM);
const sessions = new Set(bars.filter(b => b.m >= 590 && b.m < 660).map(b => b.td)).size;
const r0 = BT.runs.find(r => r.sym === SYM && r.id === 'Fixed points|PDH/PDL|disp');
function tradesFor(stopPts) {
  const cfg = { ...BASE, ...r0, ...MODEL, fixedStop: stopPts };
  const rules = run(bars, SYM, { ...cfg, exitMode: 'rules' }), site = run(bars, SYM, { ...cfg, exitMode: 'scale' });
  const fills = rules.events.filter(e => e.type === 'fill');
  return rules.trades.map((t, n) => {
    const i0 = bars.findIndex(b => b.t === fills[n].t), risk = Math.abs(t.entry - t.stop);
    const dip = SIZE * MICRO * I.pointValue * Math.min(t.maeR ?? 1, 1) * risk; // worst open loss in $ at 3 MNQ
    const res = PLANS.map(([, legs, be, beAt2]) => legs === 'site' ? site.trades[n].pnl : simulate(bars, i0, t.dir, t.entry, t.stop, legs, be, beAt2, I.tick) * I.pointValue - NQ_COST);
    return { d: t.td, risk: +risk.toFixed(2), dip: +dip.toFixed(0), usd: res.map(v => +mnq(v).toFixed(2)) };
  });
}
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function monteCarlo(trades, pi, pTrade) {
  const rand = rng(12345), res = {};
  for (const D of DAYS) res[D] = { pass: 0, fail: 0, failMid: 0, open: 0, heldBy30: 0, daysToPass: [] };
  for (let n = 0; n < PATHS; n++) {
    let bal = ACCT.start, hi = bal, floor = bal - ACCT.mll, best = 0, tdays = 0, outcome = null, at = 0, hit30 = false, mid = false;
    for (let day = 1; day <= DAYS.at(-1) && !outcome; day++) {
      if (rand() >= pTrade) continue;
      const t = trades[Math.floor(rand() * trades.length)], p = t.usd[pi]; tdays++;
      if (bal - t.dip <= floor) { outcome = 'fail'; mid = bal + p > floor; at = day; break; }
      bal += p; best = Math.max(best, p);
      if (bal <= floor) { outcome = 'fail'; at = day; break; }
      hi = Math.max(hi, bal); floor = Math.min(Math.max(floor, hi - ACCT.mll), ACCT.lockAt);
      const prof = bal - ACCT.start;
      if (prof >= ACCT.target && tdays >= ACCT.minDays) { if (best <= ACCT.consistency * prof) { outcome = 'pass'; at = day; } else hit30 = true; }
    }
    for (const D of DAYS) {
      const r = res[D];
      if (outcome === 'pass' && at <= D) { r.pass++; r.daysToPass.push(at); }
      else if (outcome === 'fail' && at <= D) { r.fail++; if (mid) r.failMid++; }
      else { r.open++; if (hit30) r.heldBy30++; }
    }
  }
  const pc = v => +(v / PATHS * 100).toFixed(1);
  return Object.fromEntries(DAYS.map(D => { const r = res[D], s = r.daysToPass.sort((a, b) => a - b);
    return [D, { pass: pc(r.pass), fail: pc(r.fail), failMidTrade: pc(r.failMid), notYet: pc(r.open), notYetOnlyBy30: pc(r.heldBy30), medianDaysToPass: s.length ? s[Math.floor(s.length / 2)] : null }]; }));
}
function summary(trades, pi) {
  let eq = 0, peak = 0, dd = 0, wins = 0, best = 0, worstDip = 0;
  for (const t of trades) { const p = t.usd[pi]; eq += p; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); if (p > 0) wins++; best = Math.max(best, p); worstDip = Math.max(worstDip, t.dip); }
  return { trades: trades.length, winRate: +(wins / trades.length).toFixed(3), net: Math.round(eq), maxDD: Math.round(dd), bestDay: Math.round(best), bestDayShare: eq > 0 ? +(best / eq).toFixed(2) : null, worstOpenLoss: worstDip };
}
const out = { generated: new Date().toISOString(), setting: r0.id, sessions, size: '3 MNQ', account: 'MFF Rapid EOD 50K evaluation', rules: ACCT, paths: PATHS, stops: {} };
for (const stopPts of [80, 60]) {
  const trades = tradesFor(stopPts), pTrade = trades.length / sessions;
  out.stops[stopPts] = { trades: trades.length, tradesPerSession: +pTrade.toFixed(2), plans: PLANS.map(([name], pi) => ({ plan: name, ...summary(trades, pi), mc: monteCarlo(trades, pi, pTrade) })), list: trades };
  console.log(`\nNQ ${stopPts}-pt stop · ${trades.length} trades in ${sessions} sessions · 3 MNQ · ${PATHS} paths`);
  console.log('plan'.padEnd(52) + 'won  net    maxDD  best%  | 30 days: pass fail (mid) not-yet (30% rule) | 60 days: pass fail  median days');
  for (const p of out.stops[stopPts].plans) { const a = p.mc[30], b = p.mc[60];
    console.log(`${p.plan.padEnd(52)}${String(Math.round(p.winRate * 100)).padStart(3)}% ${String(p.net).padStart(6)} ${String(p.maxDD).padStart(6)}  ${String(Math.round((p.bestDayShare || 0) * 100)).padStart(3)}%  | ${String(a.pass).padStart(5)} ${String(a.fail).padStart(5)} (${a.failMidTrade}) ${String(a.notYet).padStart(5)} (${a.notYetOnlyBy30}) | ${String(b.pass).padStart(5)} ${String(b.fail).padStart(5)}  ${b.medianDaysToPass}`); }
}
writeFileSync(here('mffexits.json'), JSON.stringify(out));
