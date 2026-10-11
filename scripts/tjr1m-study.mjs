// TJR 1-minute model — STUDY ONLY (not used by the site, no stats shown anywhere).
// TJR's own words (Sep 17 recap): "high time frame liquidity sweep, five minute breaker structure, five minute fair value gap
// that gets filled, enter off of a one minute breaker structure", stop just past the 1m swing, target liquidity.
// This script turns that into explicit rules with a few switches where his words leave room, runs every variant on the
// 1-minute archive, and first checks whether each variant finds the trades he actually took (TJR Trade Log/trades.csv).
// Usage: node scripts/tjr1m-study.mjs <dir with ES-1m.json + NQ-1m.json | archive dir with 1m/ES, 1m/NQ> [outFile.json]
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = process.argv[2], OUT = process.argv[3];
const INSTR = { ES: { tick: 0.25, pv: 50, buf: 1.0, minRisk: 2, maxRisk: 25 }, NQ: { tick: 0.25, pv: 20, buf: 4.0, minRisk: 8, maxRisk: 100 } };
const FIRST_DAY = '2026-09-15'; // the Sep→Dec roll was the weekend of Sep 12–13; Sep 14 is only used for prior-day levels
const COST_RT = { ES: 4.68, NQ: 4.68 }; // MFF round trip per full contract

// ---------- data ----------
function load(sym) {
  if (existsSync(join(SRC, `${sym}-1m.json`))) return JSON.parse(readFileSync(join(SRC, `${sym}-1m.json`), 'utf8'));
  const dir = join(SRC, '1m', sym), rows = [];
  for (const f of readdirSync(dir).sort()) rows.push(...JSON.parse(readFileSync(join(dir, f), 'utf8')));
  return rows;
}
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function toBars(rows) {
  const out = [];
  for (const [t, o, h, l, c] of rows.sort((a, b) => a[0] - b[0])) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t * 1000)).map(x => [x.type, x.value]));
    const date = `${p.year}-${p.month}-${p.day}`, m = +p.hour * 60 + +p.minute;
    // trading day: the futures session that opens at 18:00 belongs to the next calendar day
    const td = m >= 1080 ? new Date(Date.parse(date + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10) : date;
    out.push({ t, o, h, l, c, date, m, td, hm: `${p.hour}:${p.minute}` });
  }
  return out;
}
const days = bars => { const d = new Map(); for (const b of bars) { if (!d.has(b.td)) d.set(b.td, []); d.get(b.td).push(b); } return d; };
// 5m candles from 1m (aligned to :00/:05…), each knows the index of its last 1m bar
function to5m(b1) {
  const out = []; let cur = null;
  b1.forEach((b, i) => {
    const k = Math.floor(b.m / 5) * 5;
    if (!cur || cur.k !== k || cur.date !== b.date) { cur = { k, date: b.date, td: b.td, m: k, t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, i0: i, i1: i }; out.push(cur); }
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.i1 = i; }
  });
  return out;
}
const hmOf = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// ---------- liquidity levels for one trading day ----------
function levelsFor(dayBars, prevDayBars, V) {
  const L = [], rng = (bs, n) => { if (!bs.length) return; L.push({ n: n + ' high', p: Math.max(...bs.map(b => b.h)), side: 'BSL' }); L.push({ n: n + ' low', p: Math.min(...bs.map(b => b.l)), side: 'SSL' }); };
  rng(dayBars.filter(b => b.m >= 1080 || b.m < 180), 'Asian');
  rng(dayBars.filter(b => b.m >= 180 && b.m < 510), 'London');
  if (prevDayBars && prevDayBars.length) rng(prevDayBars, 'Prior-day');
  return L;
}

// ---------- one day ----------
function runDay(sym, dayBars, prevDayBars, V) {
  const I = INSTR[sym], ev = [], note = (b, type, text) => ev.push({ hm: b.hm, type, text });
  const b1 = dayBars.filter(b => b.m >= 420 && b.m < 960), b5 = to5m(b1);
  const L = levelsFor(dayBars, prevDayBars, V).map(x => ({ ...x, htf: true })), taken = new Set(), cands = [];
  // one setup per side; the side whose break of structure came last is the one in play
  const S = { long: null, short: null }; let active = null, trade = null;
  const swing5 = (j, side) => { for (let k = j - 3; k >= 2; k--) { const x = b5[k];
    if (side === 'long' && x.h > b5[k - 1].h && x.h > b5[k - 2].h && x.h >= b5[k + 1].h && x.h >= b5[k + 2].h) return x.h;
    if (side === 'short' && x.l < b5[k - 1].l && x.l < b5[k - 2].l && x.l <= b5[k + 1].l && x.l <= b5[k + 2].l) return x.l; } return null; };
  for (let j = 0; j < b5.length && !trade; j++) {
    const c5 = b5[j]; if (c5.m >= V.end) break;
    // morning liquidity: 5m swing highs/lows from 07:00 (2 candles left, 1 right), counted as liquidity from 09:30
    if (V.levels === 'morning' && j >= 3) { const k = j - 1, x = b5[k];
      if (x.h > b5[k - 1].h && x.h > b5[k - 2].h && x.h >= c5.h) L.push({ n: `${hmOf(x.m)} high`, p: x.h, side: 'BSL' });
      if (x.l < b5[k - 1].l && x.l < b5[k - 2].l && x.l <= c5.l) L.push({ n: `${hmOf(x.m)} low`, p: x.l, side: 'SSL' }); }
    // 1. sweeps. 'close': a 5m close back inside within 2 candles (session levels: within V.htfBack candles)
    for (const lv of L) {
      if (taken.has(lv.n)) continue;
      if (!(lv.side === 'SSL' ? c5.l < lv.p : c5.h > lv.p)) continue;
      taken.add(lv.n); if (c5.m < (lv.htf ? V.watch0 : 570)) continue;
      let idx = c5.i0; while (idx < c5.i1 && !(lv.side === 'SSL' ? b1[idx].l < lv.p : b1[idx].h > lv.p)) idx++;
      cands.push({ lv, j, idx });
    }
    const keep = [];
    for (const cd of cands.splice(0)) {
      const back = cd.lv.side === 'SSL' ? c5.c > cd.lv.p : c5.c < cd.lv.p, side = cd.lv.side === 'SSL' ? 'long' : 'short';
      if (V.sweep === 'wick' || back) {
        const ext = side === 'long' ? Math.min(...b5.slice(cd.j, j + 1).map(x => x.l)) : Math.max(...b5.slice(cd.j, j + 1).map(x => x.h));
        S[side] = { lv: cd.lv, m: c5.m, x: ext, bos: null, fvg: null, filled: null };
        note(b1[cd.idx], 'sweep', `${cd.lv.n} ${cd.lv.p} swept (${side === 'long' ? 'sell' : 'buy'}-side): ${side} setup armed`);
      } else if (j - cd.j < (cd.lv.htf ? V.htfBack : 2)) keep.push(cd);
    }
    cands.push(...keep);
    // 2. break of structure for each armed side
    for (const side of ['long', 'short']) {
      const st = S[side]; if (!st) continue;
      st.x = side === 'long' ? Math.min(st.x, c5.l) : Math.max(st.x, c5.h);
      if (st.bos) continue;
      if (V.bos === '1m') {
        for (let i = Math.max(c5.i0, 5); i <= c5.i1 && !st.bos; i++) { const b = b1[i]; if (b.m < st.m) continue;
          const prev = b1.slice(i - 5, i), ref = side === 'long' ? Math.max(...prev.map(x => x.h)) : Math.min(...prev.map(x => x.l));
          if (side === 'long' ? b.c > ref : b.c < ref) { st.bos = { m: c5.m, at: b.t }; note(b, 'bos', `1m break of structure ${side === 'long' ? 'up' : 'down'}: close ${b.c} beyond ${ref}`); } }
      } else {
        const prev5 = b5.slice(Math.max(0, j - 5), j);
        const ref = V.bos === '5m-swing' ? swing5(j, side) : (side === 'long' ? Math.max(...prev5.map(x => x.h)) : Math.min(...prev5.map(x => x.l)));
        if (ref != null && prev5.length && (side === 'long' ? c5.c > ref : c5.c < ref)) { st.bos = { m: c5.m, at: b1[c5.i1].t }; note(b1[c5.i1], 'bos', `5m break of structure ${side === 'long' ? 'up' : 'down'}: close ${c5.c} beyond ${ref}`); }
      }
      if (st.bos && (!active || !S[active] || !S[active].bos || st.bos.at >= S[active].bos.at)) active = side;
    }
    if (!active || !S[active] || !S[active].bos) continue;
    const dir = active, st = S[dir];
    // 3b. 'pullback' mode: no gap needed. After the break, track the impulse's furthest point, then the pullback against it;
    //     enter when a 1m close breaks the pullback leg (beyond the 1m candles since the pullback extreme); stop past the pullback extreme
    if (V.fvg === 'pullback') {
      for (let i = c5.i0; i <= c5.i1 && !trade; i++) {
        const b = b1[i]; if (b.m >= V.entryEnd) break; if (b.t <= st.bos.at) continue;
        // the impulse is measured from the sweep, not from the break (the break is often mid-impulse)
        const P = st.pb || (st.pb = (() => { const since = b1.filter(x => x.m >= st.m && x.t <= st.bos.at);
          return { imp: dir === 'long' ? Math.max(...since.map(x => x.h)) : Math.min(...since.map(x => x.l)), ext: null, extI: null }; })());
        if (dir === 'long' ? b.h > P.imp : b.l < P.imp) { P.imp = dir === 'long' ? b.h : b.l; P.ext = null; continue; } // impulse still extending
        if (P.ext == null || (dir === 'long' ? b.l < P.ext : b.h > P.ext)) { P.ext = dir === 'long' ? b.l : b.h; P.extI = i; continue; } // pullback deepening
        if (b.m < V.entry0) continue;
        const prev = b1.slice(P.extI + 1, i); if (!prev.length) continue;
        const ref = dir === 'long' ? Math.max(...prev.map(x => x.h)) : Math.min(...prev.map(x => x.l));
        if (dir === 'long' ? b.c > ref : b.c < ref) {
          const entry = b.c, raw = V.stop === 'sweep' ? st.x : P.ext, stop = dir === 'long' ? raw - I.buf : raw + I.buf, risk = Math.abs(entry - stop);
          if (risk >= I.minRisk && risk <= I.maxRisk) { trade = { dir, entry, stop, risk, i, hm: b.hm, sweep: st.lv.n }; note(b, 'entry', `1m break after the pullback: ${dir} ${entry}, stop ${stop} (${risk.toFixed(2)} pts)`); break; }
          note(b, 'skip', `1m break at ${entry} but risk ${risk.toFixed(2)} pts is outside ${I.minRisk}–${I.maxRisk}`);
        }
      }
      continue;
    }
    // 3. 5m fair value gap in the trade direction; the newest gap counts until one is filled
    if (j >= 2 && !st.filled) {
      const a = b5[j - 2]; let g = null;
      if (dir === 'long' && c5.l > a.h && b5[j - 1].m >= st.bos.m - 10) g = { lo: a.h, hi: c5.l };
      if (dir === 'short' && c5.h < a.l && b5[j - 1].m >= st.bos.m - 10) g = { lo: c5.h, hi: a.l };
      if (g) { st.fvg = g; note(b1[c5.i1], 'fvg5', `5m FVG ${g.lo}–${g.hi}`); continue; } // a gap exists once its candle has closed
      if (!st.fvg && V.fvg === 'optional') st.fvg = { none: true };
      if (!st.fvg) continue;
    }
    // 4. 1m: the gap gets filled, then a 1m break of structure → entry
    for (let i = c5.i0; i <= c5.i1 && !trade; i++) {
      const b = b1[i]; if (b.m >= V.entryEnd) break;
      if (b.t <= st.bos.at) continue; // only 1m candles after the break of structure
      if (!st.fvg.none && !st.filled && (dir === 'long' ? b.c < st.fvg.lo : b.c > st.fvg.hi)) { note(b, 'void', '1m close through the gap: setup void'); S[dir] = null; active = null; break; }
      if (!st.filled) {
        if (st.fvg.none || (dir === 'long' ? b.l <= st.fvg.hi : b.h >= st.fvg.lo)) { st.filled = { i, ext: dir === 'long' ? b.l : b.h, extI: i }; if (!st.fvg.none) note(b, 'fill', `gap filled (1m ${dir === 'long' ? 'low ' + b.l : 'high ' + b.h})`); }
        continue;
      }
      const F = st.filled;
      if (b.m >= V.entry0) {
        // 'leg': close beyond the pullback leg that followed the fill extreme (e.g. short: below the lows made since the highest high)
        const prev = V.trigger === 'leg' ? b1.slice(F.extI + 1, i) : b1.slice(Math.max(F.i, i - 5), i);
        if (prev.length) {
          const ref = dir === 'long' ? Math.max(...prev.map(x => x.h)) : Math.min(...prev.map(x => x.l));
          if (dir === 'long' ? b.c > ref : b.c < ref) {
            const entry = b.c, raw = V.stop === 'sweep' ? st.x : F.ext, stop = dir === 'long' ? raw - I.buf : raw + I.buf, risk = Math.abs(entry - stop);
            if (risk >= I.minRisk && risk <= I.maxRisk) { trade = { dir, entry, stop, risk, i, hm: b.hm, sweep: st.lv.n }; note(b, 'entry', `1m break of structure: ${dir} ${entry}, stop ${stop} (${risk.toFixed(2)} pts)`); break; }
            note(b, 'skip', `1m break at ${entry} but risk ${risk.toFixed(2)} pts is outside ${I.minRisk}–${I.maxRisk}`);
          }
        }
      }
      if (dir === 'long' ? b.l < F.ext : b.h > F.ext) { F.ext = dir === 'long' ? b.l : b.h; F.extI = i; }
    }
  }
  if (!trade) return { ev, trade: null };
  // exits: funded plan (2 of 3 at 1R + stop to break-even, last at 2R), take-profits need 1 tick through; stop first when a bar hits both; flat 12:00
  const lng = trade.dir === 'long', R = trade.risk, at = k => lng ? trade.entry + k * R : trade.entry - k * R, th = I.tick;
  let stop = trade.stop, f1 = false, pts = 0, why = '12:00 flat', exitHm = null, mfe = 0;
  for (let i = trade.i + 1; i < b1.length; i++) {
    const b = b1[i];
    if (b.m >= 720) { pts += (f1 ? 1 / 3 : 1) * (lng ? b.o - trade.entry : trade.entry - b.o); exitHm = b.hm; break; }
    mfe = Math.max(mfe, lng ? b.h - trade.entry : trade.entry - b.l);
    if (lng ? b.l <= stop : b.h >= stop) { pts += (f1 ? 1 / 3 : 1) * (lng ? stop - trade.entry : trade.entry - stop); why = f1 ? 'break-even' : 'stop'; exitHm = b.hm; break; }
    if (!f1 && (lng ? b.h >= at(1) + th : b.l <= at(1) - th)) { f1 = true; pts += (2 / 3) * R; stop = trade.entry; }
    if (f1 && (lng ? b.h >= at(2) + th : b.l <= at(2) - th)) { pts += (1 / 3) * 2 * R; why = '2R'; exitHm = b.hm; break; }
  }
  trade.r = +(pts / R).toFixed(2); trade.why = why; trade.exit = exitHm; trade.mfeR = +(mfe / R).toFixed(2);
  trade.pnl3micro = +(3 * (pts * INSTR[sym].pv * 0.1) - 3 * 1.90).toFixed(2);
  return { ev, trade };
}

// ---------- variants ----------
const VARIANTS = [];
for (const levels of ['session', 'morning']) for (const sweep of ['wick', 'close']) for (const bos of ['5m-bars5', '5m-swing', '1m']) for (const fvg of ['required', 'optional', 'pullback'])
  for (const trigger of (fvg === 'pullback' ? ['leg'] : ['leg', 'bars5'])) for (const stop of ['swing1m', 'sweep']) for (const watch0 of [510, 570])
    VARIANTS.push({ levels, sweep, bos, fvg, trigger, stop, watch0, htfBack: 12, entry0: 590, entryEnd: 660, end: 665 });
const vid = V => `${V.levels}|${V.sweep}|bos-${V.bos}|fvg-${V.fvg}|trig-${V.trigger}|stop-${V.stop}|watch-${hmOf(V.watch0)}`;

// TJR's logged trades (TJR Trade Log/trades.csv): day, contract, direction, entry time window, entry, stop
const TJR = [
  { td: '2026-09-17', sym: 'ES', dir: 'short', from: 590, to: 600, entry: 7691.5, stop: 7698.25 },
  { td: '2026-09-30', sym: 'NQ', dir: 'long', from: 590, to: 600, entry: 30778.75, stop: 30693 },
  { td: '2026-10-06', sym: 'NQ', dir: 'long', from: 580, to: 600, entry: 31512.25, stop: 31457.75 },
];

const data = {}; for (const s of ['ES', 'NQ']) data[s] = days(toBars(load(s)));
const results = [];
for (const V of VARIANTS) {
  const res = { id: vid(V), V, trades: [], tjr: [] };
  for (const s of ['ES', 'NQ']) {
    const tds = [...data[s].keys()].sort();
    tds.forEach((td, k) => {
      if (td < FIRST_DAY) return;
      const { ev, trade } = runDay(s, data[s].get(td), k ? data[s].get(tds[k - 1]) : null, V);
      if (trade) res.trades.push({ sym: s, td, ...trade });
      const want = TJR.find(x => x.td === td && x.sym === s);
      if (want) {
        const tm = trade ? +trade.hm.slice(0, 2) * 60 + +trade.hm.slice(3) : null;
        res.tjr.push({ td, sym: s, want: want.dir, got: trade ? trade.dir : 'none', at: trade ? trade.hm : null,
          sameDir: !!trade && trade.dir === want.dir, nearTime: !!trade && tm >= want.from - 5 && tm <= want.to + 5,
          entry: trade ? trade.entry : null, stop: trade ? trade.stop : null, tjrEntry: want.entry, tjrStop: want.stop, ev });
      }
    });
  }
  const t = res.trades; res.n = t.length; res.wins = t.filter(x => x.r > 0).length; res.sumR = +t.reduce((a, x) => a + x.r, 0).toFixed(2);
  res.matchDir = res.tjr.filter(x => x.sameDir).length; res.matchBoth = res.tjr.filter(x => x.sameDir && x.nearTime).length;
  results.push(res);
}
results.sort((a, b) => b.matchBoth - a.matchBoth || b.matchDir - a.matchDir || b.sumR - a.sumR);
console.log(`TJR 1m model study · ${VARIANTS.length} variants · days from ${FIRST_DAY} · STUDY ONLY\n`);
console.log('match = his 3 trades found (same direction / same direction within ~10 min) · then all trades in the sample (funded exits, R)');
for (const r of results.slice(0, 16)) console.log(`${r.id.padEnd(62)} match ${r.matchDir}/3 dir, ${r.matchBoth}/3 dir+time · ${String(r.n).padStart(2)} trades, ${r.wins} won, ${r.sumR >= 0 ? '+' : ''}${r.sumR}R`);
const best = process.env.SHOW ? results.find(r => r.id === process.env.SHOW) : results[0];
console.log(`\nBest match: ${best.id}`);
for (const x of best.tjr) { console.log(`\n  ${x.td} ${x.sym}: TJR ${x.want} @${x.tjrEntry} stop ${x.tjrStop} · model: ${x.got}${x.at ? ` at ${x.at} @${x.entry} stop ${x.stop}` : ''}`); for (const e of x.ev) console.log(`     ${e.hm} ${e.type.padEnd(6)} ${e.text}`); }
if (OUT) writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString(), firstDay: FIRST_DAY, results: results.map(({ tjr, ...r }) => ({ ...r, tjr: tjr.map(({ ev, ...x }) => x) })) }, null, 1));
