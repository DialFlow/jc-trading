// Quantitative check of the Live tab's forecast and of setups outside TJR hours, on real 5m ES1!/NQ1! candles.
//
// A. Forecast study. At every 5-minute candle from 7:30 to 11:30 ET of every session, the Live tab's forecast is made
//    out of sample: the analog sessions are other days only (leave-one-session-out), and again using only EARLIER days
//    (walk-forward, what you'd have known at the time). Each forecast is scored against what really happened next:
//    direction over 30 / 60 min, calibration of the "up in X%" number, Brier skill vs the base rate, whether the outcome
//    landed inside the 25–75% band (should be ~50%), and the "which liquidity first" call. Baselines: base rate at that
//    time of day, momentum since 7:30, and "the nearer level gets hit first".
// B. Off-hours setups. The same sweep → BOS → FVG rules run around the clock (engine anyTime), grouped by session,
//    with and without multi-timeframe confluence at the moment the order was placed.
//
// Usage: node scripts/research.mjs   → research.json next to index.html
import { readFileSync, writeFileSync } from 'node:fs';
import { BASE, run, stats, toBars } from './tjr-engine.mjs';
// the Lab's structure model (same as MODEL in scripts/backtest.mjs; importing that file would re-run the backtest)
const MODEL = { bosMode: 'bars5', watchStart: 510, watchEnd: 660, entryStart: 590, entryEnd: 660, restEnd: 690, maxTrades: 1 };

const here = p => new URL('../' + p, import.meta.url);
const html = readFileSync(here('index.html'), 'utf8');
const a = html.indexOf('// ===== CONFLUENCE-CORE START'), b = html.indexOf('// ===== CONFLUENCE-CORE END');
const core = new Function('JC_API', 'esc', 'getCurrentETTime', html.slice(a, b) + '\nreturn { scanFVGs, confChecks, smtCheck, to4h, CONF_ROWS, RECENT };')('', s => s, () => new Date());
const BT = JSON.parse(readFileSync(here('backtest.json'), 'utf8'));

// the site's defaults: robust setting whose weaker half is strongest, then its best robust exit
const isRobust = r => r.stats.net > 0 && r.halves[0].net > 0 && r.halves[1].net > 0 && r.stress.stats.net > 0;
const via = (r, ex) => ex === 'rules' || !r.exits?.[ex] ? r : { ...r, ...r.exits[ex] };
const weak = r => Math.min(r.halves[0].net, r.halves[1].net);
function siteDefault(sym) {
  const runs = BT.runs.filter(r => r.sym === sym), rob = runs.filter(isRobust).sort((x, y) => weak(y) - weak(x));
  const r = rob[0] || runs.find(x => x.id === 'v4');
  const ex = ['rules', 'liq', 'scale'].map(e => ({ e, v: via(r, e) })).filter(o => isRobust(o.v)).sort((x, y) => weak(y.v) - weak(x.v))[0];
  return { r, exit: ex ? ex.e : 'rules' };
}

async function load(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=5m&range=60d&includePrePost=true`;
  const r = (await (await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })).json()).chart.result[0], q = r.indicators.quote[0];
  const rows = []; r.timestamp.forEach((t, i) => { if ([q.open[i], q.high[i], q.low[i], q.close[i]].every(v => v != null)) rows.push([t, q.open[i], q.high[i], q.low[i], q.close[i]]); });
  return toBars(rows);
}
const wilson = (k, n, z = 1.645) => { if (!n) return [0, 0]; const p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d; return [+Math.max(0, c - h).toFixed(3), +Math.min(1, c + h).toFixed(3)]; };
const q = (arr, p) => { if (!arr.length) return NaN; const s = arr.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; };
const r3 = v => +v.toFixed(3);

// same stage definition as lvStageOf() in index.html
function stageOf(s, m) {
  if (!s || m < MODEL.watchStart || m >= 1080) return { k: 0, dir: '' };
  const o = s.pos || s.pending;
  const dir = o ? o.dir : s.bosUp ? 'long' : s.bosDn ? 'short' : s.sslSwept && !s.bslSwept ? 'long' : s.bslSwept && !s.sslSwept ? 'short' : '';
  const k = s.pos ? 4 : s.pending ? 3 : s.traded ? 5 : (!Number.isNaN(s.fvgMidL) || !Number.isNaN(s.fvgMidS)) ? 3 : (s.bosUp || s.bosDn) ? 2 : (s.sslSwept || s.bslSwept) ? 1 : 0;
  return { k, dir };
}
const sessionOf = m => m >= 1080 || m < 180 ? 'Asian (6 pm–3 am)' : m < 510 ? 'London (3–8:30 am)' : m < 590 ? 'NY open (8:30–9:50)' : m < 660 ? 'TJR window (9:50–11:00)' : 'NY late (11 am–5 pm)';
const SESSION_ORDER = ['Asian (6 pm–3 am)', 'London (3–8:30 am)', 'NY open (8:30–9:50)', 'TJR window (9:50–11:00)', 'NY late (11 am–5 pm)'];

const out = { generated: new Date().toISOString(), syms: {} };
const data = {};
for (const sym of ['ES=F', 'NQ=F']) data[sym] = await load(sym);

for (const sym of ['ES=F', 'NQ=F']) {
  const bars = data[sym], { r, exit } = siteDefault(sym), cfg = { ...BASE, ...r, ...MODEL, exitMode: exit };
  const full = run(bars, sym, cfg, { snapshots: true });
  // sessions = trading days with 7:30–12:30 candles
  const byTd = new Map();
  bars.forEach((x, i) => { if (x.m >= 450 && x.m <= 750) { if (!byTd.has(x.td)) byTd.set(x.td, []); byTd.get(x.td).push(i); } });
  const S = [...byTd.entries()].filter(([, idx]) => idx.length >= 50).map(([td, idx]) => {
    const snaps = full.snapshots, levels = snaps[idx[0]].levels;
    return { td, idx, o730: bars[idx[0]].o, trade: full.trades.find(t => t.td === td) || null };
  });
  // per session and minute: features and outcomes
  const rec = new Map();
  for (const s of S) for (let n = 0; n < s.idx.length; n++) {
    const i = s.idx[n], x = bars[i]; if (x.m > 690) break;
    const st = stageOf(full.snapshots[i], x.m), L = full.snapshots[i].levels;
    const fwd = h => n + h < s.idx.length ? bars[s.idx[n + h]].c / x.c - 1 : null;
    const pools = [L.asianH, L.asianL, L.londonH, L.londonL, L.pdH, L.pdL, L.mOpen, L.nyH, L.nyL].filter(p => p != null && !Number.isNaN(p));
    const above = Math.min(...pools.filter(p => p > x.c)), below = Math.max(...pools.filter(p => p < x.c));
    const path = []; for (let h = 1; h <= 12; h++) path.push(fwd(h));
    // which side's distance gets hit first (as % of price, so it transfers between sessions)
    const race = (dU, dD) => { for (let k = n + 1; k < s.idx.length && bars[s.idx[k]].m <= 720; k++) { const y = bars[s.idx[k]], hu = y.h >= x.c * (1 + dU), hd = y.l <= x.c * (1 - dD); if (hu && hd) return 'both'; if (hu) return 'up'; if (hd) return 'down'; } return 'none'; };
    rec.set(s.td + '|' + x.m, { td: s.td, m: x.m, c: x.c, st, mv: Math.sign(x.c - s.o730), path, dU: isFinite(above) ? above / x.c - 1 : null, dD: isFinite(below) ? 1 - below / x.c : null, race });
  }
  const recs = [...rec.values()], tds = S.map(s => s.td);
  const byM = new Map(); for (const x of recs) { if (!byM.has(x.m)) byM.set(x.m, []); byM.get(x.m).push(x); }
  // the Live tab's analog rule: same step + side → same move since 7:30 → all, first tier with ≥8 sessions
  function analogs(x, pool) {
    const tiers = [p => p.st.k === x.st.k && p.st.dir === x.st.dir, p => p.mv === x.mv, () => true];
    for (let t = 0; t < tiers.length; t++) { const set = pool.filter(tiers[t]); if (set.length >= 8 || t === 2) return { set, tier: t }; }
  }
  function evaluate(mode) {
    const acc = { n: 0, tiers: [0, 0, 0], h: {}, cal: {}, band: { n: 0, in: 0 }, race: { n: 0, ok: 0, base: 0, decided: 0 }, conf: { n: 0, ok: 0 }, lean: {}, perSession: {} };
    for (const H of [6, 12]) acc.h[H] = { n: 0, hit: 0, base: 0, mom: 0, up: 0, brier: 0, brierBase: 0 };
    for (const x of recs) {
      const pool = (byM.get(x.m) || []).filter(p => p.td !== x.td && (mode === 'loo' || p.td < x.td));
      if (pool.length < (mode === 'loo' ? 8 : 10)) continue;
      const { set, tier } = analogs(x, pool); acc.n++; acc.tiers[tier]++;
      for (const H of [6, 12]) {
        const act = x.path[H - 1]; if (act == null || act === 0) continue;
        const rs = set.map(p => p.path[H - 1]).filter(v => v != null), all = pool.map(p => p.path[H - 1]).filter(v => v != null);
        if (rs.length < 3 || !all.length) continue;
        const pUp = rs.filter(v => v > 0).length / rs.length, pBase = all.filter(v => v > 0).length / all.length, med = q(rs, 0.5), up = act > 0 ? 1 : 0, A = acc.h[H];
        if (H === 12) { const ps = (acc.perSession[x.td] ||= { n: 0, ok: 0 }); ps.n++; ps.ok += (med > 0) === (act > 0);
          // the rules' own lean: after a sweep / break / gap, does price go the rules' way over the next hour?
          if (x.st.dir && x.st.k >= 1 && x.st.k <= 3) { const L = (acc.lean[x.st.k] ||= { n: 0, ok: 0, days: new Set() }); L.n++; L.ok += (x.st.dir === 'long') === (act > 0); L.days.add(x.td); } }
        A.n++; A.hit += (med > 0) === (act > 0); A.base += (pBase >= 0.5) === (act > 0); A.mom += (x.mv >= 0) === (act > 0); A.up += up;
        A.brier += (pUp - up) ** 2; A.brierBase += (pBase - up) ** 2;
        if (H === 12) {
          const b = pUp < 0.3 ? '<30%' : pUp < 0.45 ? '30–45%' : pUp <= 0.55 ? '45–55%' : pUp <= 0.7 ? '55–70%' : '>70%';
          (acc.cal[b] ||= { n: 0, up: 0 }).n++; acc.cal[b].up += up;
          if (Math.abs(pUp - 0.5) >= 0.2) { acc.conf.n++; acc.conf.ok += (pUp > 0.5) === (act > 0); }
          const lo = q(rs, 0.25), hi = q(rs, 0.75); acc.band.n++; acc.band.in += act >= lo && act <= hi;
        }
      }
      if (x.dU != null && x.dD != null) {
        const truth = x.race(x.dU, x.dD); if (truth === 'up' || truth === 'down') {
          let u = 0, d = 0; for (const p of set) { const rr = p.race(x.dU, x.dD); if (rr === 'up') u++; if (rr === 'down') d++; }
          acc.race.n++; acc.race.ok += (u >= d ? 'up' : 'down') === truth; acc.race.base += (x.dU <= x.dD ? 'up' : 'down') === truth;
        }
      }
    }
    const H = k => { const A = acc.h[k]; return { n: A.n, hitRate: r3(A.hit / A.n), ci: wilson(A.hit, A.n), baseRate: r3(A.base / A.n), momentum: r3(A.mom / A.n), upShare: r3(A.up / A.n),
      brier: r3(A.brier / A.n), brierBase: r3(A.brierBase / A.n), skill: r3(1 - A.brier / A.brierBase) }; };
    return { forecasts: acc.n, sessions: new Set(recs.map(x => x.td)).size, tiers: acc.tiers, next30: H(6), next60: H(12),
      calibration: Object.fromEntries(['<30%', '30–45%', '45–55%', '55–70%', '>70%'].filter(k => acc.cal[k]).map(k => [k, { n: acc.cal[k].n, actualUp: r3(acc.cal[k].up / acc.cal[k].n) }])),
      confident: { n: acc.conf.n, hitRate: acc.conf.n ? r3(acc.conf.ok / acc.conf.n) : 0, ci: wilson(acc.conf.ok, acc.conf.n) },
      bandCoverage: { n: acc.band.n, inside: r3(acc.band.in / acc.band.n) },
      sessionsBeatingCoin: { of: Object.keys(acc.perSession).length, beat: Object.values(acc.perSession).filter(s => s.ok / s.n > 0.5).length },
      rulesLean: Object.fromEntries(Object.entries(acc.lean).map(([k, L]) => [k, { stage: ['', 'sweep done', 'break of structure done', 'gap formed / order working'][k], n: L.n, sessions: L.days.size, hitRate: r3(L.ok / L.n), ci: wilson(L.ok, L.n) }])),
      liquidityRace: { n: acc.race.n, hitRate: r3(acc.race.ok / acc.race.n), ci: wilson(acc.race.ok, acc.race.n), nearerFirst: r3(acc.race.base / acc.race.n) } };
  }
  const fc = { loo: evaluate('loo'), walk: evaluate('walk') };

  // B. off-hours setups: the same rules around the clock
  const anyCfg = { ...cfg, anyTime: true, maxTrades: 50, restBars: 12, holdBars: 24 }, anyRun = run(bars, sym, anyCfg);
  const other = data[sym === 'ES=F' ? 'NQ=F' : 'ES=F'];
  const SEC = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14400 };
  const roll = (bs, sec) => { const o = []; for (const x of bs) { const k = Math.floor(x.t / sec) * sec, l = o[o.length - 1]; if (l && l.t === k) { l.h = Math.max(l.h, x.h); l.l = Math.min(l.l, x.l); l.c = x.c; } else o.push({ t: k, o: x.o, h: x.h, l: x.l, c: x.c }); } return o; };
  const tfBars = (bs) => ({ '5m': bs, '15m': roll(bs, 900), '1h': roll(bs, 3600), '4h': core.to4h(roll(bs, 3600)) });
  const MY = tfBars(bars), OT = tfBars(other);
  const confAt = (t, dir) => { let aligned = 0; const want = dir === 'long' ? 'bull' : 'bear', opp = dir === 'long' ? 'bear' : 'bull';
    for (const tf of ['5m', '15m', '1h', '4h']) {
      const upto = MY[tf].filter(x => x.t + SEC[tf] <= t + 300).slice(-300), ou = OT[tf].filter(x => x.t + SEC[tf] <= t + 300).slice(-300);
      if (upto.length < core.RECENT + 5) continue;
      const c = core.confChecks({ bars: upto, gaps: core.scanFVGs(upto) }); c.smt = ou.length >= core.RECENT ? core.smtCheck(sym === 'ES=F' ? { bars: upto } : { bars: ou }, sym === 'ES=F' ? { bars: ou } : { bars: upto }) : { v: '' };
      const has = (v, d) => v === d || v === 'both', nw = core.CONF_ROWS.filter(rw => has(c[rw.key].v, want)).length, no = core.CONF_ROWS.filter(rw => has(c[rw.key].v, opp)).length;
      if (nw >= 4 && nw > no) aligned++;
    } return aligned; };
  const orders = anyRun.events.filter(e => e.type === 'order');
  const fills = anyRun.events.filter(e => e.type === 'fill'); // one position at a time, so the k-th fill is the k-th trade
  const trades = anyRun.trades.map((t, k) => { const fillT = fills[k] ? fills[k].t : 0;
    const od = orders.filter(e => e.t <= fillT).pop(); return { ...t, orderM: od ? bars.find(x => x.t === od.t).m : null, conf: od ? confAt(od.t, t.dir) : 0 }; });
  const grp = (ts) => { const s = stats(ts); return { n: s.trades, winRate: r3(s.winRate), ci: wilson(s.wins, s.trades), net: s.net, pf: s.pf, avgR: s.avgR }; };
  const off = {};
  for (const name of SESSION_ORDER) { const ts = trades.filter(t => t.orderM != null && sessionOf(t.orderM) === name);
    off[name] = { all: grp(ts), withConf: grp(ts.filter(t => t.conf >= 2)), noConf: grp(ts.filter(t => t.conf < 2)) }; }
  const outside = trades.filter(t => t.orderM != null && sessionOf(t.orderM) !== 'TJR window (9:50–11:00)');
  out.syms[sym] = { setting: r.id, exit, from: bars[0].date, to: bars[bars.length - 1].date, forecast: fc,
    offHours: { bySession: off, outside: { all: grp(outside), withConf: grp(outside.filter(t => t.conf >= 2)), noConf: grp(outside.filter(t => t.conf < 2)) },
      rules: 'Same sweep → BOS → FVG rules and stops; watch and entries around the clock; an unfilled order cancels after 1 hour; a trade closes at market after 2 hours if neither stop nor target is hit. Confluence = 2+ of 5m/15m/1H/4H aligned (4+ of 6 checks) in the trade direction when the order was placed.' } };
  const L = fc.loo, W = fc.walk;
  console.log(`${sym} forecast (leave-one-out): ${L.forecasts} forecasts / ${L.sessions} sessions · 60m direction ${(L.next60.hitRate * 100).toFixed(1)}% [${L.next60.ci.map(v => Math.round(v * 100)).join('–')}] vs base ${(L.next60.baseRate * 100).toFixed(1)}% / momentum ${(L.next60.momentum * 100).toFixed(1)}% · Brier skill ${L.next60.skill} · band coverage ${(L.bandCoverage.inside * 100).toFixed(0)}% · race ${(L.liquidityRace.hitRate * 100).toFixed(1)}% vs nearer ${(L.liquidityRace.nearerFirst * 100).toFixed(1)}% (n ${L.liquidityRace.n})`);
  console.log(`${sym} forecast (walk-forward): ${W.forecasts} forecasts · 60m ${(W.next60.hitRate * 100).toFixed(1)}% vs base ${(W.next60.baseRate * 100).toFixed(1)}% · skill ${W.next60.skill} · race ${(W.liquidityRace.hitRate * 100).toFixed(1)}% vs nearer ${(W.liquidityRace.nearerFirst * 100).toFixed(1)}%`);
  for (const [k, v] of Object.entries(off)) console.log(`   ${k.padEnd(26)} ${String(v.all.n).padStart(4)} trades  win ${(v.all.winRate * 100).toFixed(0)}%  net ${v.all.net}  | with confluence ${v.withConf.n} @ ${(v.withConf.winRate * 100).toFixed(0)}% net ${v.withConf.net}`);
}
writeFileSync(here('research.json'), JSON.stringify(out));
console.log('wrote research.json');
