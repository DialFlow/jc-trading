// Evaluation of the frozen TJR 1-minute model v1.1 against its pre-registration (docs/PREREG-tjr1m-v1.1.md, amending v1).
// Runs the model on every day, keeps the design days apart from out-of-sample days, and grades each pre-registered test:
// enough trades, mean R > 0 (day-block bootstrap), beats a random-entry and an opposite-direction baseline (same exits,
// slippage and costs), MFF Rapid EOD pass/fail with 3 micros, and both halves positive.
// Usage: node scripts/tjr1m-eval.mjs <data dir> [more data dirs…] [--out report.json] [--csv forward.csv]
//   a data dir is either <dir>/ES-1m.json + NQ-1m.json, or an archive layout <dir>/1m/ES/*.json; all dirs are merged.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION, INSTR, toBars, byDay, runDay, signal, manage, sessionBars } from './tjr1m-model-v1.1.mjs';

const args = process.argv.slice(2), opt = k => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null; };
const OUT = opt('--out'), CSV = opt('--csv'), DIRS = args;
// design = Sep 15–Oct 9 (chose the rules) + Oct 12–16 (looked at under v1 before the v1.1 fix): reported, never counted.
// out of sample = days after the v1.1 freeze (from Oct 19) and historical days before Sep 12.
const DESIGN = ['2026-09-15', '2026-10-09'], SEEN = ['2026-10-12', '2026-10-16'], FIRST_FORWARD = '2026-10-19', HIST_END = '2026-09-11';
const isDesign = td => (td >= DESIGN[0] && td <= DESIGN[1]) || (td >= SEEN[0] && td <= SEEN[1]);
const isOOS = td => td >= FIRST_FORWARD || td <= HIST_END;

// ---------- seeded random ----------
let seed = 20261017; const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

// ---------- data ----------
function load(sym) {
  const m = new Map();
  for (const d of DIRS) {
    const add = rows => { for (const r of rows) m.set(r[0], r); };
    if (existsSync(join(d, `${sym}-1m.json`))) add(JSON.parse(readFileSync(join(d, `${sym}-1m.json`), 'utf8')));
    const dir = join(d, '1m', sym); if (existsSync(dir)) for (const f of readdirSync(dir)) add(JSON.parse(readFileSync(join(dir, f), 'utf8')));
  }
  return [...m.values()];
}
// a trading day is usable if it has a full morning (07:00–12:00 present) and the previous trading day exists (prior-day levels)
const usable = (bars) => bars.filter(b => b.m >= 420 && b.m < 720).length >= 280;

// ---------- run ----------
const SYMS = ['NQ', 'ES'], trades = [], days = {};
for (const s of SYMS) {
  const d = byDay(toBars(load(s))), tds = [...d.keys()].sort(); days[s] = [];
  tds.forEach((td, k) => {
    if (!k || !usable(d.get(td)) || !(isDesign(td) || isOOS(td))) return;
    // skip roll days: a gap of > 0.5% between the previous day's last close and this day's first open
    const prev = d.get(tds[k - 1]), gap = Math.abs(d.get(td)[0].o - prev.at(-1).c) / prev.at(-1).c;
    if (gap > 0.005) return;
    days[s].push({ td, bars: d.get(td), prev });
    const { trade } = runDay(s, d.get(td), prev);
    if (trade) trades.push({ sym: s, td, period: isDesign(td) ? 'design' : 'oos', ...trade });
  });
}

// ---------- stats helpers ----------
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))]; };
// day-block bootstrap of mean R: resample trading days (with their trades) with replacement
function bootMean(list, dayList, B = 10000) {
  const byD = new Map(dayList.map(td => [td, []])); for (const t of list) byD.get(t.td)?.push(t.r);
  const ds = [...byD.values()], out = [];
  for (let b = 0; b < B; b++) { let s = 0, n = 0; for (let i = 0; i < ds.length; i++) { const x = ds[(rnd() * ds.length) | 0]; for (const r of x) { s += r; n++; } } out.push(n ? s / n : 0); }
  return { lo: pct(out, 0.025), hi: pct(out, 0.975), pLE0: out.filter(x => x <= 0).length / B };
}
// paired day-block bootstrap of (model mean R − baseline mean R)
function bootDiff(model, base, dayList, B = 10000) {
  const m = new Map(dayList.map(td => [td, { a: [], b: [] }]));
  for (const t of model) m.get(t.td)?.a.push(t.r); for (const t of base) m.get(t.td)?.b.push(t.r);
  const ds = [...m.values()], out = [];
  for (let k = 0; k < B; k++) { let sa = 0, na = 0, sb = 0, nb = 0; for (let i = 0; i < ds.length; i++) { const x = ds[(rnd() * ds.length) | 0]; for (const r of x.a) { sa += r; na++; } for (const r of x.b) { sb += r; nb++; } } out.push((na ? sa / na : 0) - (nb ? sb / nb : 0)); }
  return { est: mean(model.map(t => t.r)) - mean(base.map(t => t.r)), lo: pct(out, 0.025), hi: pct(out, 0.975), pLE0: out.filter(x => x <= 0).length / B };
}

// ---------- baselines (out-of-sample days only) ----------
function baselines(sym, period) {
  const own = trades.filter(t => t.sym === sym && t.period === period), dists = own.map(t => Math.abs(t.signalClose - t.stop));
  const dl = days[sym].filter(d => (period === 'design' ? isDesign(d.td) : isOOS(d.td)));
  // opposite: every model signal traded the other way, same next-open fill, stop mirrored at the same distance
  const opposite = [];
  for (const t of own) { const d = dl.find(x => x.td === t.td), b1 = sessionBars(d.bars), dist = Math.abs(t.signalClose - t.stop);
    const dir = t.dir === 'long' ? 'short' : 'long', stop = dir === 'long' ? t.signalClose - dist : t.signalClose + dist;
    const r = manage(sym, b1, t.i + 1, dir, stop); if (r) opposite.push({ td: t.td, r: r.r }); }
  // random: on every day, a random minute 09:50–10:59, random direction, stop distance drawn from the model's own
  const REPS = 1000, randMeans = [], randOne = [];
  if (dists.length) for (let rep = 0; rep < REPS; rep++) {
    let s = 0, n = 0;
    for (const d of dl) { const b1 = sessionBars(d.bars), cand = b1.map((b, i) => i).filter(i => b1[i].m >= 590 && b1[i].m < 660 && i + 1 < b1.length);
      if (!cand.length) continue; const i = cand[(rnd() * cand.length) | 0], dir = rnd() < 0.5 ? 'long' : 'short', dist = dists[(rnd() * dists.length) | 0];
      const stop = dir === 'long' ? b1[i].c - dist : b1[i].c + dist, r = manage(sym, b1, i + 1, dir, stop);
      if (r) { s += r.r; n++; if (rep === 0) randOne.push({ td: d.td, r: r.r }); } }
    randMeans.push(n ? s / n : 0);
  }
  return { own, dl: dl.map(d => d.td), opposite, randMeans, randOne };
}

// ---------- MFF Rapid EOD 50K evaluation, 3 micros ----------
function mffSim(sym, list, nSessions, paths = 10000, horizon = 60) {
  if (!list.length) return null;
  const p = list.length / nSessions; let pass = 0, fail = 0;
  for (let k = 0; k < paths; k++) {
    let bal = 50000, hi = 50000, floor = 48000, best = 0, td = 0, done = false;
    for (let d = 0; d < horizon && !done; d++) {
      if (rnd() >= p) continue; const t = list[(rnd() * list.length) | 0]; td++;
      if (bal - t.maeUsd <= floor) { fail++; done = true; break; }
      bal += t.usd; best = Math.max(best, t.usd);
      if (bal <= floor) { fail++; done = true; break; }
      hi = Math.max(hi, bal); floor = Math.min(Math.max(floor, hi - 2000), 50100);
      const prof = bal - 50000; if (prof >= 3000 && td >= 4 && best <= 0.3 * prof) { pass++; done = true; }
    }
  }
  return { pass: pass / paths, fail: fail / paths };
}

// ---------- report ----------
const rep = { version: VERSION, generated: new Date().toISOString(), data: {}, periods: {} };
for (const s of SYMS) { const t = days[s].map(d => d.td); rep.data[s] = { days: t.length, first: t[0], last: t.at(-1), oosDays: t.filter(isOOS).length, designDays: t.filter(isDesign).length }; }
const f2 = x => (x >= 0 ? '+' : '') + x.toFixed(2), P = x => (x * 100).toFixed(1) + '%';
console.log(`TJR 1m model ${VERSION} · evaluation vs pre-registration`);
for (const s of SYMS) console.log(`  ${s}: ${rep.data[s].days} usable days (${rep.data[s].first} → ${rep.data[s].last}), design ${rep.data[s].designDays}, out-of-sample ${rep.data[s].oosDays}`);
for (const period of ['design', 'oos']) {
  console.log(`\n=== ${period === 'design' ? 'DESIGN + SEEN days (Sep 15–Oct 9 chose the rules, Oct 12–16 seen under v1; not evidence)' : 'OUT-OF-SAMPLE (the test)'} ===`);
  rep.periods[period] = {};
  for (const s of SYMS) {
    const B = baselines(s, period), own = B.own, n = own.length, R = own.map(t => t.r);
    const o = { trades: n, days: B.dl.length, wins: own.filter(t => t.r > 0).length, meanR: mean(R), sumR: R.reduce((a, x) => a + x, 0), usd3: own.reduce((a, t) => a + t.usd, 0) };
    if (n) {
      o.boot = bootMean(own, B.dl); o.opposite = { meanR: mean(B.opposite.map(t => t.r)), diff: bootDiff(own, B.opposite, B.dl) };
      o.random = { meanR: mean(B.randMeans), lo: pct(B.randMeans, 0.025), hi: pct(B.randMeans, 0.975), pModelNotBetter: B.randMeans.filter(x => x >= o.meanR).length / B.randMeans.length, diff: bootDiff(own, B.randOne, B.dl) };
      const half = B.dl[Math.floor(B.dl.length / 2)]; o.halves = [mean(own.filter(t => t.td < half).map(t => t.r)), mean(own.filter(t => t.td >= half).map(t => t.r))];
      o.mff = mffSim(s, own, B.dl.length);
    }
    rep.periods[period][s] = o;
    if (!n) { console.log(`  ${s}: no trades on ${B.dl.length} days`); continue; }
    console.log(`  ${s}: ${n} trades on ${B.dl.length} days, ${o.wins} won, mean ${f2(o.meanR)}R (95% ${f2(o.boot.lo)} to ${f2(o.boot.hi)}), total ${f2(o.sumR)}R, ${o.usd3 >= 0 ? '+' : '−'}$${Math.abs(Math.round(o.usd3))} with 3 micros`);
    console.log(`      random baseline mean ${f2(o.random.meanR)}R (95% of random runs ${f2(o.random.lo)} to ${f2(o.random.hi)}); random runs as good or better: ${P(o.random.pModelNotBetter)}`);
    console.log(`      opposite-direction mean ${f2(o.opposite.meanR)}R; model minus opposite ${f2(o.opposite.diff.est)}R (95% ${f2(o.opposite.diff.lo)} to ${f2(o.opposite.diff.hi)})`);
    console.log(`      halves ${o.halves.map(f2).join(' / ')}R · MFF 3 micros, 60 sessions: pass ${P(o.mff.pass)}, fail ${P(o.mff.fail)}`);
  }
}
// grade the pre-registered tests on NQ out-of-sample
const q = rep.periods.oos.NQ || {}, G = [];
const enough = q.trades >= 100;
G.push(['1 at least 100 NQ out-of-sample trades', enough ? 'PASS' : `NOT ENOUGH DATA (${q.trades || 0} of 100)`]);
const judge = ok => !enough ? 'NOT ENOUGH DATA (shown for information)' : ok ? 'PASS' : 'FAIL';
if (q.trades) {
  G.push(['2 mean R > 0, one-sided p < 0.05', `${judge(q.meanR > 0 && q.boot.pLE0 < 0.05)} · mean ${f2(q.meanR)}R, p ${q.boot.pLE0.toFixed(3)}`]);
  G.push(['3a beats random baseline (95% interval above 0)', `${judge(q.random.diff.lo > 0)} · diff ${f2(q.meanR - q.random.meanR)}R (95% ${f2(q.random.diff.lo)} to ${f2(q.random.diff.hi)})`]);
  G.push(['3b beats opposite direction (95% interval above 0)', `${judge(q.opposite.diff.lo > 0)} · diff ${f2(q.opposite.diff.est)}R (95% ${f2(q.opposite.diff.lo)} to ${f2(q.opposite.diff.hi)})`]);
  G.push(['4 MFF pass ≥ 50%, fail ≤ 15% (3 MNQ, 60 sessions)', `${judge(q.mff.pass >= 0.5 && q.mff.fail <= 0.15)} · pass ${P(q.mff.pass)}, fail ${P(q.mff.fail)}`]);
  G.push(['5 both halves positive', `${judge(q.halves.every(x => x > 0))} · ${q.halves.map(f2).join(' / ')}R`]);
}
// design-period multiple-testing note: how many readings were tried, rank of v1 by R among them
const N_TRIED = 356, alphaSidak = 1 - Math.pow(0.95, 1 / N_TRIED);
const d = rep.periods.design.NQ; if (d && d.trades) G.push(['design period (not evidence)', `NQ mean ${f2(d.meanR)}R, p ${d.boot.pLE0.toFixed(3)}; with ~${N_TRIED} versions tried, a design-period result would need p < ${alphaSidak.toFixed(5)} to mean anything`]);
rep.grades = G;
console.log('\n=== PRE-REGISTERED TESTS (NQ, out of sample) ==='); for (const [k, v] of G) console.log(`  ${k}: ${v}`);
if (OUT) writeFileSync(OUT, JSON.stringify({ ...rep, trades }, null, 1));
if (CSV) writeFileSync(CSV, 'date,contract,signal_et,direction,fill_et,fill,stop,risk_pts,exit,exit_et,r_net,usd_3_micros,sweep\n' + trades.filter(t => t.td >= SEEN[0])
  .sort((a, b) => a.td.localeCompare(b.td) || a.sym.localeCompare(b.sym)).map(t => [t.td, t.sym, t.signalHm, t.dir, t.entryHm, t.entry, t.stop, t.risk.toFixed(2), t.why, t.exitHm, t.r.toFixed(3), t.usd.toFixed(2), `"${t.sweep}"`].join(',')).join('\n') + '\n');
