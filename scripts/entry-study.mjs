// Entry study (Oct 10): where is the Lab model losing, and would a different entry time / entry price / stop / filter help?
// Same engine (tjr-engine.mjs), same robustness bar as the Lab: profitable overall + both halves (split at the middle
// session) + stress test (limit fills only after trading 2 ticks through, 3 ticks slippage on stops/market).
//
//   A. Diagnosis: site defaults on today's 60 days, by week, since Oct 1, by fill-time bucket (all 25 settings pooled, in R)
//   B. Entry windows: entries from 8:30 / 9:00 / 9:30 / 9:40 / 9:50 × last entry 10:10 / 10:30 / 11:00 / 11:30
//   C. Entry price: FVG midpoint (now) · near edge · far edge · market at FVG close · market at BOS close · IFVG midpoint
//   D. Stops: fixed points · sweep wick · sweep + buffer · ATR × k · beyond the FVG
//   E. Filters on the trades the model already takes (4H/1H trend, 1H gap, SMT, discount/premium, sweep depth,
//      minutes from sweep to order, VIX, opening gap, direction vs the 8:30→order move)
//   F. Walk-forward: pick the best window / entry / stop on the first half, score it on the second (and the reverse)
// Every variant is counted (out.variantsTried) so results can be discounted for multiple testing.
//
// Usage: node scripts/entry-study.mjs            → entry.json next to index.html (fetches Yahoo; nothing paid)
//        JC_CACHE=<dir> node scripts/entry-study.mjs   caches the Yahoo downloads in <dir> so reruns use the same candles
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { BASE, INSTR, configs, run, stats, toBars } from './tjr-engine.mjs';

const here = p => new URL('../' + p, import.meta.url);
const MODEL = { bosMode: 'bars5', watchStart: 510, watchEnd: 660, entryStart: 590, entryEnd: 660, restEnd: 690, maxTrades: 1 };
const html = readFileSync(here('index.html'), 'utf8');
const ca = html.indexOf('// ===== CONFLUENCE-CORE START'), cb = html.indexOf('// ===== CONFLUENCE-CORE END');
const core = new Function('JC_API', 'esc', 'getCurrentETTime', html.slice(ca, cb) + '\nreturn { scanFVGs, to4h };')('', s => s, () => new Date());
const CACHE = process.env.JC_CACHE;

async function yahoo(sym, interval, range) {
  const f = CACHE && `${CACHE}/${sym.replace(/\W/g, '')}_${interval}_${range}.json`;
  if (f && existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}&includePrePost=true`;
  const r = (await (await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })).json()).chart.result[0], q = r.indicators.quote[0];
  const rows = []; r.timestamp.forEach((t, i) => { if ([q.open[i], q.high[i], q.low[i], q.close[i]].every(v => v != null)) rows.push([t, q.open[i], q.high[i], q.low[i], q.close[i]]); });
  if (f) { mkdirSync(CACHE, { recursive: true }); writeFileSync(f, JSON.stringify(rows)); }
  return rows;
}

let VARIANTS = 0; // distinct rule variants tried (each × 25 settings × 2 contracts)
const slim = s => ({ n: s.trades, win: +(s.winRate * 100).toFixed(0), net: Math.round(s.net), pf: s.pf, dd: Math.round(s.maxDD), avgR: s.avgR });
const D = {}; // per symbol: bars, sessions, mid
const sitePick = sym => sym === 'NQ=F' ? { cfg: configs(sym).find(c => c.id === 'Fixed points|PDH/PDL|disp'), exit: 'scale' } : { cfg: configs(sym)[0], exit: 'rules' };

// one configuration, full robustness check
function evalCfg(sym, c, keep) {
  const { bars, mid } = D[sym];
  const r = run(bars, sym, c), s = stats(r.trades);
  const h = [r.trades.filter(t => t.td < mid), r.trades.filter(t => t.td >= mid)].map(ts => stats(ts));
  const sx = stats(run(bars, sym, { ...c, fillThrough: 2, slipTicks: 3 }).trades);
  return { ...slim(s), h1: Math.round(h[0].net), h2: Math.round(h[1].net), stress: Math.round(sx.net), stressDD: Math.round(sx.maxDD),
    robust: s.net > 0 && h[0].net > 0 && h[1].net > 0 && sx.net > 0, ...(keep ? { trades: r.trades, events: r.events } : {}) };
}
// a rule variant across all 25 settings of a contract (and an exit); returns summary + the site-default row
function grid(sym, patch, exitMode = 'scale') {
  const rows = configs(sym).map(cfg => ({ id: cfg.id, ...evalCfg(sym, { ...BASE, ...cfg, ...MODEL, ...patch, exitMode }) }));
  const pick = sitePick(sym), def = rows.find(x => x.id === pick.cfg.id);
  const tot = rows.reduce((a, x) => a + x.n, 0);
  return { robust: rows.filter(x => x.robust).length, positive: rows.filter(x => x.net > 0).length, sumNet: Math.round(rows.reduce((a, x) => a + x.net, 0)),
    sumH1: Math.round(rows.reduce((a, x) => a + x.h1, 0)), sumH2: Math.round(rows.reduce((a, x) => a + x.h2, 0)), sumStress: Math.round(rows.reduce((a, x) => a + x.stress, 0)),
    avgTrades: +(tot / rows.length).toFixed(1), medDD: rows.map(x => x.dd).sort((a, b) => a - b)[12], def, rows };
}
const line = (lab, g) => `${lab.padEnd(34)} robust ${String(g.robust).padStart(2)}/25 · +${String(g.positive).padStart(2)} · avg n ${String(g.avgTrades).padStart(4)} · sum ${String(g.sumNet).padStart(8)} (H ${g.sumH1}/${g.sumH2}, stress ${g.sumStress}) · default: n ${g.def.n} win ${g.def.win}% net ${g.def.net} PF ${g.def.pf} DD ${g.def.dd} H ${g.def.h1}/${g.def.h2} S ${g.def.stress}${g.def.robust ? ' ✔' : ''}`;

const out = { generated: new Date().toISOString(), model: MODEL, syms: {} };
for (const sym of ['NQ=F', 'ES=F']) {
  const bars = toBars(await yahoo(sym, '5m', '60d'));
  const sessions = [...new Set(bars.filter(b => b.m >= 570 && b.m < 610).map(b => b.td))];
  D[sym] = { bars, sessions, mid: sessions[sessions.length >> 1] };
}
const vixD = await yahoo('^VIX', '1d', '1y');
const vixAt = td => { let v = NaN; for (const [t, , , , c] of vixD) { if (new Date(t * 1000).toISOString().slice(0, 10) < td) v = c; } return v; }; // prior close

for (const sym of ['NQ=F', 'ES=F']) {
  const { bars, sessions, mid } = D[sym], O = out.syms[sym] = { from: sessions[0], to: sessions.at(-1), sessions: sessions.length, splitAt: mid };
  console.log(`\n================ ${INSTR[sym].name}  ${sessions[0]} → ${sessions.at(-1)}  (${sessions.length} sessions, split ${mid})`);

  // ---------- A. Diagnosis ----------
  const pick = sitePick(sym), defC = { ...BASE, ...pick.cfg, ...MODEL, exitMode: pick.exit };
  const def = evalCfg(sym, defC, true);
  const wk = {}; for (const t of def.trades) { const d = new Date(t.td + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); const k = d.toISOString().slice(0, 10); (wk[k] ||= []).push(t); }
  const recent = def.trades.filter(t => t.td >= '2026-10-01');
  O.diagnosis = { setting: pick.cfg.id, exit: pick.exit, ...(({ trades, events, ...x }) => x)(def),
    byWeek: Object.entries(wk).map(([w, ts]) => ({ week: w, n: ts.length, net: Math.round(ts.reduce((a, t) => a + t.pnl, 0)) })),
    sinceOct1: { ...slim(stats(recent)), trades: recent.map(t => ({ td: t.td, dir: t.dir, entryTime: t.entryTime, r: t.r, pnl: t.pnl, why: t.why })) },
    trades: def.trades.map(t => ({ td: t.td, dir: t.dir, entryTime: t.entryTime, entry: t.entry, exit: t.exit, r: t.r, pnl: t.pnl, why: t.why, mfeR: t.mfeR, maeR: t.maeR })) };
  console.log(`A. site default ${pick.cfg.id} / ${pick.exit}: n ${def.n} win ${def.win}% net ${def.net} PF ${def.pf} DD ${def.dd} halves ${def.h1}/${def.h2} stress ${def.stress} ${def.robust ? 'ROBUST' : 'not robust'}`);
  console.log('   by week: ' + O.diagnosis.byWeek.map(w => `${w.week.slice(5)} ${w.net >= 0 ? '+' : ''}${w.net}(${w.n})`).join(' · '));
  console.log(`   since Oct 1: n ${recent.length} net ${Math.round(recent.reduce((a, t) => a + t.pnl, 0))} ` + recent.map(t => `${t.entryTime.slice(5)} ${t.dir} ${t.r}R`).join(', '));
  // all 25 settings, both exits, on today's data
  const g0s = grid(sym, {}, 'scale'), g0r = grid(sym, {}, 'rules');
  O.current = { scale: (({ rows, ...x }) => x)(g0s), rules: (({ rows, ...x }) => x)(g0r), rowsScale: g0s.rows, rowsRules: g0r.rows };
  console.log(line('A. current model / scale', g0s)); console.log(line('A. current model / rules', g0r));
  // by sweep level (settings grouped)
  O.bySweepLevel = {};
  for (const lv of ['Any', 'London H/L', 'Asian H/L', 'PDH/PDL']) { const rs = g0s.rows.filter(x => x.id.split('|')[1] === lv);
    O.bySweepLevel[lv] = { settings: rs.length, robust: rs.filter(x => x.robust).length, sumNet: Math.round(rs.reduce((a, x) => a + x.net, 0)), avgN: +(rs.reduce((a, x) => a + x.n, 0) / rs.length).toFixed(1) }; }
  console.log('   by sweep level (scale): ' + Object.entries(O.bySweepLevel).map(([k, v]) => `${k} ${v.robust}/${v.settings} robust, sum ${v.sumNet}, n ${v.avgN}`).join(' · '));

  // ---------- B. Entry windows + fill-time buckets ----------
  // wide-open run (entries 8:30–11:30) to see which minutes make or lose money; pooled over 25 settings, in R per trade
  const bucket = hm => { const m = +hm.slice(0, 2) * 60 + +hm.slice(3); return m < 570 ? '8:30–9:29' : m < 590 ? '9:30–9:49' : m < 600 ? '9:50–9:59' : m < 610 ? '10:00–10:09' : m < 630 ? '10:10–10:29' : m < 660 ? '10:30–10:59' : '11:00+'; };
  const BK = ['8:30–9:29', '9:30–9:49', '9:50–9:59', '10:00–10:09', '10:10–10:29', '10:30–10:59', '11:00+'];
  O.fillBuckets = {};
  for (const [lab, patch] of [['current (9:50–11:00)', {}], ['open 8:30–11:30', { entryStart: 510, restStart: 510, entryEnd: 690, restEnd: 720 }]]) {
    const agg = Object.fromEntries(BK.map(k => [k, { n: 0, R: 0, pnl: 0, wins: 0, h1R: 0, h1n: 0, h2R: 0, h2n: 0 }])), def1 = {};
    for (const cfg of configs(sym)) {
      const r = run(bars, sym, { ...BASE, ...cfg, ...MODEL, ...patch, exitMode: 'scale' });
      for (const t of r.trades) { const k = bucket(t.entryTime.slice(11)), a = agg[k]; a.n++; a.R += t.r; a.pnl += t.pnl; if (t.pnl > 0) a.wins++; if (t.td < mid) { a.h1R += t.r; a.h1n++; } else { a.h2R += t.r; a.h2n++; }
        if (cfg.id === pick.cfg.id) { (def1[k] ||= { n: 0, pnl: 0 }); def1[k].n++; def1[k].pnl += t.pnl; } }
    }
    O.fillBuckets[lab] = BK.map(k => { const a = agg[k]; return { bucket: k, n: a.n, win: a.n ? Math.round(a.wins / a.n * 100) : 0, avgR: a.n ? +(a.R / a.n).toFixed(2) : 0, h1R: a.h1n ? +(a.h1R / a.h1n).toFixed(2) : null, h2R: a.h2n ? +(a.h2R / a.h2n).toFixed(2) : null, sumPnl: Math.round(a.pnl), def: def1[k] ? { n: def1[k].n, pnl: Math.round(def1[k].pnl) } : null }; });
    console.log(`B. fills by time, ${lab} (all 25 settings pooled, scale exit; avg R per trade [half1/half2]; default setting n/$):`);
    for (const x of O.fillBuckets[lab]) if (x.n) console.log(`   ${x.bucket.padEnd(12)} n ${String(x.n).padStart(4)} win ${String(x.win).padStart(3)}% avgR ${String(x.avgR).padStart(6)} [${x.h1R}/${x.h2R}] sum $${x.sumPnl}${x.def ? ` · default ${x.def.n} tr $${x.def.pnl}` : ''}`);
  }
  O.windows = {};
  for (const es of [510, 540, 570, 580, 590]) for (const ee of [610, 630, 660, 690]) {
    const id = `${Math.floor(es / 60)}:${String(es % 60).padStart(2, '0')}–${Math.floor(ee / 60)}:${String(ee % 60).padStart(2, '0')}`;
    if (sym === 'NQ=F') VARIANTS++;
    const g = grid(sym, { entryStart: es, restStart: Math.min(es, 590), entryEnd: ee, restEnd: Math.max(ee + 30, 690) });
    O.windows[id] = (({ rows, ...x }) => x)(g); O.windows[id].rowsNet = g.rows.map(x => [x.id, x.net, x.h1, x.h2, x.stress, x.n]);
    console.log(line(`B. entries ${id}`, g));
  }

  // ---------- C. Entry price / trigger ----------
  O.entryAt = {};
  for (const ea of ['mid', 'edge', 'far', 'market', 'bos', 'ifvg']) for (const ex of ['scale', 'rules']) {
    if (sym === 'NQ=F' && ex === 'scale') VARIANTS++;
    const g = grid(sym, { entryAt: ea }, ex);
    O.entryAt[`${ea}|${ex}`] = (({ rows, ...x }) => x)(g);
    console.log(line(`C. entry ${ea} / ${ex}`, g));
  }

  // ---------- D. Stops (applied to every setting's sweep level / displacement choice) ----------
  O.stops = {};
  const k = INSTR[sym].stopScale;
  const STOPS = [['fixed 20×k (now)', { stopMode: 'Fixed points', fixedStop: 20 * k, maxRisk: 25 * k }], ['fixed 15×k', { stopMode: 'Fixed points', fixedStop: 15 * k, maxRisk: 25 * k }],
    ['fixed 25×k', { stopMode: 'Fixed points', fixedStop: 25 * k, maxRisk: 30 * k }], ['sweep wick, max 25×k', { stopMode: 'Sweep wick', maxRisk: 25 * k }],
    ['sweep + 5×k buffer, max 30×k', { stopMode: 'Sweep+buffer', stopBuf: 5 * k, maxRisk: 30 * k }], ['ATR×3 (5m)', { stopMode: 'ATR', atrMult: 3, maxRisk: 40 * k }],
    ['ATR×5 (5m)', { stopMode: 'ATR', atrMult: 5, maxRisk: 40 * k }], ['FVG far edge + 2×k', { stopMode: 'FVG far', stopBuf: 2 * k, maxRisk: 25 * k }]];
  for (const [lab, p] of STOPS) {
    if (sym === 'NQ=F') VARIANTS++;
    // keep each setting's level/displacement; only the stop changes. Settings collapse to 8 distinct (level × disp) combos.
    const rows = []; const seen = new Set();
    for (const cfg of configs(sym)) { const key = cfg.sweepLvl + cfg.useDisp; if (seen.has(key) || cfg.id === 'v4') continue; seen.add(key);
      rows.push({ id: `${cfg.sweepLvl}|${cfg.useDisp ? 'disp' : 'nodisp'}`, ...evalCfg(sym, { ...BASE, ...cfg, ...MODEL, ...p, exitMode: 'scale' }) }); }
    const avgRisk = (() => { const r = run(bars, sym, { ...BASE, ...pick.cfg, ...MODEL, ...p, exitMode: 'scale' }).trades; return r.length ? +(r.reduce((a, t) => a + t.risk, 0) / r.length).toFixed(1) : 0; })();
    const d = rows.find(x => x.id === (sym === 'NQ=F' ? 'PDH/PDL|disp' : 'Any|nodisp'));
    O.stops[lab] = { robust: rows.filter(x => x.robust).length, of: rows.length, sumNet: Math.round(rows.reduce((a, x) => a + x.net, 0)), sumStress: Math.round(rows.reduce((a, x) => a + x.stress, 0)), avgRiskPtsDefault: avgRisk, def: d, rows };
    console.log(`D. stop ${lab.padEnd(30)} robust ${O.stops[lab].robust}/8 · sum ${O.stops[lab].sumNet} (stress ${O.stops[lab].sumStress}) · ${sym === 'NQ=F' ? 'PDH/PDL|disp' : 'Any|nodisp'}: n ${d.n} win ${d.win}% net ${d.net} PF ${d.pf} DD ${d.dd} H ${d.h1}/${d.h2} S ${d.stress} avg risk ${avgRisk} pts`);
  }
}

// ---------- E. Filters (tags on the trades each setting already takes) ----------
// Each trade gets context known at ORDER time. A filter = skip trades that fail it. Note: skipping here is slightly
// different from a live filter (a skipped setup could be followed by a later one the same day), so treat as approximate.
const ctx = {};
for (const sym of ['NQ=F', 'ES=F']) {
  const h1 = (await yahoo(sym, '60m', '730d')).map(([t, o, h, l, c]) => ({ t, o, h, l, c })), h4 = core.to4h(h1);
  const sma = (a, n) => a.map((_, i) => i >= n - 1 ? a.slice(i - n + 1, i + 1).reduce((s, x) => s + x.c, 0) / n : NaN);
  const s4 = sma(h4, 20), s1 = sma(h1, 20);
  const lastClosed = (arr, sec, t) => { let lo = 0, hi = arr.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].t + sec <= t) { k = m; lo = m + 1; } else hi = m - 1; } return k; };
  const zones = core.scanFVGs(h1).flatMap(g => { const z = [{ dir: g.dir === 'bull' ? 'long' : 'short', lo: g.lo, hi: g.hi, t0: h1[g.i].t + 3600, tEnd: g.at != null && g.status === 'disrespected' ? h1[g.at].t : null }];
    if (g.status === 'disrespected') z.push({ dir: g.dir === 'bull' ? 'short' : 'long', lo: g.lo, hi: g.hi, t0: h1[g.at].t + 3600, tEnd: g.invEnd != null ? h1[g.invEnd].t : null }); return z; });
  ctx[sym] = { trend4: t => { const k = lastClosed(h4, 14400, t); return k < 0 || Number.isNaN(s4[k]) ? '' : h4[k].c > s4[k] ? 'long' : 'short'; },
    trend1: t => { const k = lastClosed(h1, 3600, t); return k < 0 || Number.isNaN(s1[k]) ? '' : h1[k].c > s1[k] ? 'long' : 'short'; },
    inZone: (t, px, dir) => zones.some(z => z.dir === dir && z.t0 <= t && (z.tEnd == null || z.tEnd > t) && px >= z.lo - (z.hi - z.lo) * 0.25 && px <= z.hi + (z.hi - z.lo) * 0.25),
    against: (t, px, dir) => zones.some(z => z.dir !== dir && z.t0 <= t && (z.tEnd == null || z.tEnd > t) && px >= z.lo && px <= z.hi) };
}
// the other contract's level state at a time (for SMT): run it with 'Any' levels and snapshots
const snapIdx = {};
for (const sym of ['NQ=F', 'ES=F']) { const r = run(D[sym].bars, sym, { ...BASE, ...configs(sym)[1], ...MODEL }, { snapshots: true }); snapIdx[sym] = { t: D[sym].bars.map(b => b.t), s: r.snapshots }; }
const snapAt = (sym, t) => { const T = snapIdx[sym].t; let lo = 0, hi = T.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (T[m] <= t) { k = m; lo = m + 1; } else hi = m - 1; } return k < 0 ? null : snapIdx[sym].s[k]; };
const KEY = { 'Asian high': 'aH', 'Asian low': 'aL', 'London high': 'lH', 'London low': 'lL', 'Prior-day high': 'pdH', 'Prior-day low': 'pdL' };

function tagTrades(sym, c) {
  const { bars } = D[sym], other = sym === 'NQ=F' ? 'ES=F' : 'NQ=F';
  const r = run(bars, sym, c, { snapshots: true }), tIdx = new Map(bars.map((b, i) => [b.t, i]));
  const orders = r.events.filter(e => e.type === 'order'), fills = r.events.filter(e => e.type === 'fill');
  return r.trades.map((t, n) => {
    const f = fills[n], o = orders.filter(e => e.t <= f.t && e.td === f.td).at(-1), i = tIdx.get(o.t), s = r.snapshots[i], lng = t.dir === 'long';
    const sw = r.events.find(e => e.type === 'sweep' && e.td === t.td && e.text.startsWith(lng ? 'Sell' : 'Buy'));
    const lvName = lng ? s.sslName : s.bslName, m = sw && /: (.+?) ([\d.]+) \((?:low|high) /.exec(sw.text), lvPx = m ? +m[2] : NaN;
    const ext = lng ? s.sweepLow : s.sweepHigh, atrRange = (() => { let a = 0, k = 0; for (let j = Math.max(0, i - 13); j <= i; j++, k++) a += bars[j].h - bars[j].l; return a / k; })();
    const oS = snapAt(other, o.t), k = KEY[lvName];
    const day = bars.filter(b => b.td === t.td), o930 = day.find(b => b.m === 570), o830 = day.find(b => b.m === 510);
    const prevDay = bars.filter(b => b.td < t.td && b.m < 960 && b.m >= 570).at(-1); // prior 15:55 close
    const px = o.data.limit;
    return { ...t, tag: {
      trend4: ctx[sym].trend4(o.t) === t.dir, trend1: ctx[sym].trend1(o.t) === t.dir,
      htfZone: ctx[sym].inZone(o.t, px, t.dir), htfAgainst: ctx[sym].against(o.t, px, t.dir),
      smt: !!(k && oS && !oS.taken[k]), // the other contract had NOT taken the same level by order time
      discount: Number.isNaN(s.levels.mOpen) ? null : (lng ? px < s.levels.mOpen : px > s.levels.mOpen),
      depthAtr: Number.isNaN(lvPx) ? null : +((lng ? lvPx - ext : ext - lvPx) / atrRange).toFixed(2),
      minsSinceSweep: sw ? Math.round((o.t - sw.t) / 60) : null,
      vix: vixAt(t.td),
      gapPct: o930 && prevDay ? +((o930.o / prevDay.c - 1) * 100).toFixed(2) : null,
      withDrive: o830 ? (lng ? bars[i].c > o830.o : bars[i].c < o830.o) : null,
      level: lvName } };
  });
}
const FILTERS = {
  'with 4H trend': t => t.tag.trend4, 'against 4H trend': t => !t.tag.trend4,
  'with 1H trend': t => t.tag.trend1,
  'entry at a same-way 1H gap': t => t.tag.htfZone, 'no opposing 1H gap at entry': t => !t.tag.htfAgainst,
  'SMT (other contract held the level)': t => t.tag.smt, 'no SMT': t => !t.tag.smt,
  'discount/premium vs midnight open': t => t.tag.discount === true,
  'sweep depth ≤ 1 ATR': t => t.tag.depthAtr != null && t.tag.depthAtr <= 1, 'sweep depth > 1 ATR': t => t.tag.depthAtr != null && t.tag.depthAtr > 1,
  'order ≤ 60 min after sweep': t => t.tag.minsSinceSweep != null && t.tag.minsSinceSweep <= 60, 'order > 60 min after sweep': t => t.tag.minsSinceSweep != null && t.tag.minsSinceSweep > 60,
  'VIX < 18': t => t.tag.vix < 18, 'VIX ≥ 18': t => t.tag.vix >= 18,
  '|gap| < 0.5%': t => t.tag.gapPct != null && Math.abs(t.tag.gapPct) < 0.5,
  'with the 8:30→order move': t => t.tag.withDrive === true, 'against the 8:30→order move': t => t.tag.withDrive === false,
};
VARIANTS += Object.keys(FILTERS).length;
out.filters = {};
for (const sym of ['NQ=F', 'ES=F']) {
  const { mid } = D[sym], res = {}, tagged = configs(sym).map(cfg => ({ id: cfg.id, ts: tagTrades(sym, { ...BASE, ...cfg, ...MODEL, exitMode: 'scale' }) }));
  const stress = configs(sym).map(cfg => ({ id: cfg.id, ts: tagTrades(sym, { ...BASE, ...cfg, ...MODEL, exitMode: 'scale', fillThrough: 2, slipTicks: 3 }) }));
  const pick = sitePick(sym);
  console.log(`\nE. filters on ${INSTR[sym].name} (scale exit; all 25 settings; default = ${pick.cfg.id})`);
  for (const [name, fn] of [['(none)', () => true], ...Object.entries(FILTERS)]) {
    let robust = 0, improved = 0, sum = 0, keptR = 0, keptN = 0, dropR = 0, dropN = 0, defRow = null;
    tagged.forEach(({ id, ts }, j) => {
      const keep = ts.filter(fn), drop = ts.filter(t => !fn(t)), s = stats(keep), sAll = stats(ts);
      const h = [keep.filter(t => t.td < mid), keep.filter(t => t.td >= mid)].map(x => stats(x).net), sx = stats(stress[j].ts.filter(fn)).net;
      if (s.net > 0 && h[0] > 0 && h[1] > 0 && sx > 0) robust++; if (s.net > sAll.net) improved++; sum += s.net;
      keptR += keep.reduce((a, t) => a + t.r, 0); keptN += keep.length; dropR += drop.reduce((a, t) => a + t.r, 0); dropN += drop.length;
      if (id === pick.cfg.id) defRow = { ...slim(s), h1: Math.round(h[0]), h2: Math.round(h[1]), stress: Math.round(sx), robust: s.net > 0 && h[0] > 0 && h[1] > 0 && sx > 0 };
    });
    res[name] = { robust, improved, sumNet: Math.round(sum), keptN, keptAvgR: keptN ? +(keptR / keptN).toFixed(2) : 0, droppedN: dropN, droppedAvgR: dropN ? +(dropR / dropN).toFixed(2) : 0, def: defRow };
    const x = res[name];
    console.log(`   ${name.padEnd(38)} robust ${String(robust).padStart(2)}/25 · better ${String(improved).padStart(2)}/25 · sum ${String(x.sumNet).padStart(8)} · kept ${x.keptN} @ ${x.keptAvgR}R vs dropped ${x.droppedN} @ ${x.droppedAvgR}R · default n ${defRow.n} net ${defRow.net} PF ${defRow.pf} DD ${defRow.dd} H ${defRow.h1}/${defRow.h2} S ${defRow.stress}${defRow.robust ? ' ✔' : ''}`);
  }
  out.filters[sym] = res;
  // the default setting's trade list with tags, for the report
  out.syms[sym].defaultTagged = tagged.find(x => x.id === pick.cfg.id).ts.map(t => ({ td: t.td, dir: t.dir, entryTime: t.entryTime, r: t.r, pnl: t.pnl, why: t.why, ...t.tag }));
}

// ---------- F. Walk-forward choice (NQ + ES): choose on one half, score on the other ----------
out.walkForward = {};
for (const sym of ['NQ=F', 'ES=F']) {
  const O = out.syms[sym], wf = {};
  for (const [fam, obj] of [['window', O.windows], ['entry', Object.fromEntries(Object.entries(O.entryAt).filter(([k]) => k.endsWith('|scale')))]]) {
    const ids = Object.keys(obj), best = key => ids.reduce((a, b) => obj[b][key] > obj[a][key] ? b : a);
    const b1 = best('sumH1'), b2 = best('sumH2');
    wf[fam] = { pickedOnH1: b1, itsH2: obj[b1].sumH2, currentH2: obj[ids.find(i => i.includes('9:50–11:00') || i === 'mid|scale')].sumH2,
      pickedOnH2: b2, itsH1: obj[b2].sumH1, currentH1: obj[ids.find(i => i.includes('9:50–11:00') || i === 'mid|scale')].sumH1 };
    console.log(`F. ${INSTR[sym].name} ${fam}: best on half 1 = ${b1} → half 2 sum ${wf[fam].itsH2} (current ${wf[fam].currentH2}) · best on half 2 = ${b2} → half 1 sum ${wf[fam].itsH1} (current ${wf[fam].currentH1})`);
  }
  out.walkForward[sym] = wf;
}

// ---------- G. Follow-ups: stop size, a pause around 10:00, pre-9:30 entries with the 9:30–9:50 rule kept ----------
// Paired by day: with one setup per day, a rule change swaps trades on some days. Count days it helped vs hurt.
const weekOf = td => { const d = new Date(td + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
function dayPnl(sym, patch, exitMode = 'scale', cfgs = configs(sym)) {
  const per = {}; // setting id → td → pnl
  for (const cfg of cfgs) { const r = run(D[sym].bars, sym, { ...BASE, ...cfg, ...MODEL, ...patch, exitMode }); const m = per[cfg.id] = {}; for (const t of r.trades) m[t.td] = (m[t.td] || 0) + t.pnl; }
  return per;
}
function paired(sym, A, B) {
  let help = 0, hurt = 0; const byDay = {};
  for (const id of Object.keys(A)) { const days = new Set([...Object.keys(A[id]), ...Object.keys(B[id])]);
    for (const td of days) { const d = (B[id][td] || 0) - (A[id][td] || 0); if (Math.abs(d) < 1) continue; byDay[td] = (byDay[td] || 0) + d; } }
  for (const v of Object.values(byDay)) v > 0 ? help++ : hurt++;
  const sorted = Object.entries(byDay).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const total = Object.values(byDay).reduce((a, v) => a + v, 0), top = sorted[0] ? sorted[0][1] : 0;
  return { daysChanged: help + hurt, daysHelped: help, daysHurt: hurt, totalDiff: Math.round(total), withoutBestDay: Math.round(total - top), biggestDay: sorted[0] ? [sorted[0][0], Math.round(sorted[0][1])] : null };
}
// leave-one-week-out: pick the variant with the best total on the other weeks, score it on the held-out week
function lowo(sym, fam) { // fam: { label: perSettingDayPnl }
  const weeks = [...new Set(D[sym].sessions.map(weekOf))], tot = {};
  for (const [lab, per] of Object.entries(fam)) { tot[lab] = {}; for (const m of Object.values(per)) for (const [td, p] of Object.entries(m)) { const w = weekOf(td); tot[lab][w] = (tot[lab][w] || 0) + p; } }
  let held = 0, base = 0; const picks = [];
  const labs = Object.keys(fam), cur = labs[0];
  for (const w of weeks) { const score = l => Object.entries(tot[l]).reduce((a, [k, v]) => k === w ? a : a + v, 0); const best = labs.reduce((a, b) => score(b) > score(a) ? b : a);
    picks.push(best); held += tot[best][w] || 0; base += tot[cur][w] || 0; }
  const cnt = {}; for (const p of picks) cnt[p] = (cnt[p] || 0) + 1;
  return { weeks: weeks.length, heldOut: Math.round(held), current: Math.round(base), picks: cnt };
}
out.followUps = {};
for (const sym of ['NQ=F', 'ES=F']) {
  const k = INSTR[sym].stopScale, F = out.followUps[sym] = { stops: {}, timing: {} };
  console.log(`
G. ${INSTR[sym].name} follow-ups`);
  // 1. fixed stop size, across the 8 level × displacement combos (fixed stops)
  const fixedCfgs = configs(sym).filter(c => c.stopMode === 'Fixed points'), fam = {};
  for (const mult of [20, 10, 12.5, 15, 17.5, 22.5]) {
    if (sym === 'NQ=F') VARIANTS++;
    const p = { fixedStop: mult * k, maxRisk: Math.max(25, mult) * k }, lab = `fixed ${mult * k} pts`;
    const rows = fixedCfgs.map(cfg => ({ id: cfg.id, ...evalCfg(sym, { ...BASE, ...cfg, ...MODEL, ...p, exitMode: 'scale' }) }));
    const rr = fixedCfgs.map(cfg => ({ id: cfg.id, ...evalCfg(sym, { ...BASE, ...cfg, ...MODEL, ...p, exitMode: 'rules' }) }));
    fam[lab] = dayPnl(sym, p, 'scale', fixedCfgs);
    const d = rows.find(x => x.id === (sym === 'NQ=F' ? 'Fixed points|PDH/PDL|disp' : 'Fixed points|Any|nodisp'));
    F.stops[lab] = { robust: rows.filter(x => x.robust).length, robustRules: rr.filter(x => x.robust).length, sumNet: Math.round(rows.reduce((a, x) => a + x.net, 0)), sumNetRules: Math.round(rr.reduce((a, x) => a + x.net, 0)),
      sumH1: Math.round(rows.reduce((a, x) => a + x.h1, 0)), sumH2: Math.round(rows.reduce((a, x) => a + x.h2, 0)), sumStress: Math.round(rows.reduce((a, x) => a + x.stress, 0)), medDD: rows.map(x => x.dd).sort((a, b) => a - b)[4], def: d, rows };
    const z = F.stops[lab];
    console.log(`   ${lab.padEnd(16)} scale robust ${z.robust}/8 sum ${z.sumNet} (H ${z.sumH1}/${z.sumH2}, stress ${z.sumStress}, median DD ${z.medDD}) · rules robust ${z.robustRules}/8 sum ${z.sumNetRules} · default: n ${d.n} win ${d.win}% net ${d.net} PF ${d.pf} DD ${d.dd} H ${d.h1}/${d.h2} S ${d.stress} (stress DD ${d.stressDD})`);
  }
  const labs = Object.keys(fam);
  F.stopsPaired = Object.fromEntries(labs.slice(1).map(l => [l, paired(sym, fam[labs[0]], fam[l])]));
  F.stopsLOWO = lowo(sym, fam);
  for (const [l, p] of Object.entries(F.stopsPaired)) console.log(`   paired vs ${labs[0]}: ${l.padEnd(16)} days changed ${p.daysChanged}, helped ${p.daysHelped} / hurt ${p.daysHurt}, total ${p.totalDiff}, without the best day ${p.withoutBestDay}`);
  console.log(`   leave-one-week-out stop choice: held-out total ${F.stopsLOWO.heldOut} vs current ${F.stopsLOWO.current} over ${F.stopsLOWO.weeks} weeks; picks ${JSON.stringify(F.stopsLOWO.picks)}`);

  // 2. timing variants (all 25 settings)
  const T = {
    'current 9:50–11:00': {},
    'pause 9:55–10:25 (no fills 10:00–10:29)': { pause: [595, 625] },
    '8:30–9:30 + 9:50–11:00 (keep the 9:30–9:50 rule)': { entryStart: 510, restStart: 510, pause: [565, 590] },
    '8:30–11:00 (no 9:30–9:50 rule)': { entryStart: 510, restStart: 510 },
    '9:30–11:00': { entryStart: 570, restStart: 570 },
  };
  const tfam = {};
  for (const [lab, p] of Object.entries(T)) {
    if (sym === 'NQ=F' && !(lab in out.syms[sym].windows) && lab !== 'current 9:50–11:00' && !lab.startsWith('8:30–11:00') && !lab.startsWith('9:30–11:00')) VARIANTS++;
    const g = grid(sym, p); tfam[lab] = dayPnl(sym, p);
    F.timing[lab] = (({ rows, ...x }) => x)(g);
    console.log(line(`   ${lab}`.slice(0, 34), g));
  }
  const tl = Object.keys(tfam);
  F.timingPaired = Object.fromEntries(tl.slice(1).map(l => [l, paired(sym, tfam[tl[0]], tfam[l])]));
  for (const [l, p] of Object.entries(F.timingPaired)) console.log(`   paired vs current: ${l.padEnd(48)} days changed ${p.daysChanged}, helped ${p.daysHelped} / hurt ${p.daysHurt}, total ${p.totalDiff}, without the best day ${p.withoutBestDay}`);
  F.timingLOWO = lowo(sym, tfam);
  console.log(`   leave-one-week-out timing choice: held-out total ${F.timingLOWO.heldOut} vs current ${F.timingLOWO.current}; picks ${JSON.stringify(F.timingLOWO.picks)}`);
}
out.variantsTried = VARIANTS;
console.log(`\nrule variants tried in this study: ${VARIANTS} (each across 25 settings × 2 exits/contracts)`);
writeFileSync(here('entry.json'), JSON.stringify(out));
console.log('wrote entry.json');
