// TJR strategy engine: a bar-by-bar port of jc_tjr_backtest_v5.pine, including how TradingView's
// broker emulator fills limit and stop orders inside a bar. One source of truth for:
//   - scripts/backtest.mjs (Node: historical runs → backtest.json)
//   - index.html Lab tab (browser: live setup tracker, replay)
// Validated: v4 settings reproduce the TradingView v4 trade list for Aug 16–Oct 7 2026 exactly.

export const INSTR = {
  'ES=F': { name: 'ES1!', pointValue: 50, tick: 0.25, stopScale: 1, micro: 'MES' },
  'NQ=F': { name: 'NQ1!', pointValue: 20, tick: 0.25, stopScale: 4, micro: 'MNQ' }, // NQ moves ~4× ES in points
};
export const COMMISSION = 2.5; // per contract per side
export const SLIP_TICKS = 1;   // market and stop orders only (Pine doesn't slip limit orders)
// rollGap: a session-open jump this large is treated as a contract roll (no PDH/PDL that day).
// restEnd: ET minute when an unfilled order is cancelled (rules: 11:00). Scenarios use 12:00 for "what if it had stayed open".
// exitMode: 'rules' = Pine target (default, TradingView parity) · 'liq' = all out at the first liquidity ≥ 1R ·
//           'scale' = half out at that liquidity, stop to break-even, rest to the rules target ·
//           'funded' = funded-account plan (MFF pass study): half out at 1R, stop to break-even, rest out at 2R ·
//           'r1' = 1:1, everything out at 1R. funded/r1 take-profits fill only after price trades 1 tick through (tpThrough);
//           funded takes 2 of 3 contracts off at 1R (tp1Frac 2/3: 3 MNQ can't be halved)
export const BASE = { rr: 2, dispLen: 20, dispMult: 1.5, rollGap: 0.02, fillThrough: 0, slipTicks: SLIP_TICKS, restEnd: 660, exitMode: 'rules',
  bosMode: 'bars5', watchStart: 570, watchEnd: 610, entryStart: 590, entryEnd: 610, maxTrades: 1, freshLevels: false };
// freshLevels: a level only counts as liquidity (for sweeps and targets) until price first trades through it.
//   Off reproduces the Pine script; on means e.g. an Asian high London already took is no longer "swept" at 8:30.
// Structure options (defaults = the Pine v4/v5 rules):
//   bosMode 'bars5' = close beyond the last 5 candles' high/low · 'swing' = close through the last confirmed swing high/low (2-candle pivot)
//   watchStart/watchEnd = ET minutes when sweeps/BOS/FVGs count (570–610) · entryStart/entryEnd = when orders may be placed (590–610)
//   maxTrades = setups per session (1); after a trade closes or an order expires, a fresh sweep is required
export const STRUCT = { bosMode: 'bars5', watchStart: 570, watchEnd: 610, entryStart: 590, entryEnd: 610, maxTrades: 1 };
export const EXITS = { rules: 'Rules target', liq: 'First liquidity ≥ 1R', scale: 'Half at liquidity, rest runs', funded: 'Funded: 2 of 3 off at 1R, last at 2R', r1: '1:1: all out at 1R' };

// v4 + the 24 v5 combinations from CLAUDE.md's "Next backtest ideas"
export function configs(sym) {
  const k = INSTR[sym].stopScale;
  const out = [{ id: 'v4', stopMode: 'Sweep wick', fixedStop: 20 * k, maxRisk: 15 * k, sweepLvl: 'Any', useDisp: false }];
  for (const stopMode of ['Sweep wick', 'Fixed points', 'Second sweep'])
    for (const sweepLvl of ['Any', 'London H/L', 'Asian H/L', 'PDH/PDL'])
      for (const useDisp of [false, true])
        out.push({ id: `${stopMode}|${sweepLvl}|${useDisp ? 'disp' : 'nodisp'}`, stopMode, fixedStop: 20 * k, maxRisk: 25 * k, sweepLvl, useDisp });
  return out;
}

const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function et(t) {
  const p = {}; for (const x of etFmt.formatToParts(new Date(t * 1000))) p[x.type] = x.value;
  const m = +p.hour * 60 + +p.minute;
  // CME trading day starts at 18:00 ET: bars from 18:00 belong to the next calendar day's session
  const d = new Date(Date.UTC(+p.year, +p.month - 1, +p.day + (m >= 1080 ? 1 : 0)));
  return { date: `${p.year}-${p.month}-${p.day}`, m, td: d.toISOString().slice(0, 10), hm: `${p.hour}:${p.minute}` };
}
// [[t,o,h,l,c], …] → bar objects with ET fields
export const toBars = rows => rows.map(([t, o, h, l, c]) => ({ t, o, h, l, c, ...et(t) }));

export const inWin = (m, a, b) => a < b ? m >= a && m < b : m >= a || m < b; // [a, b) in ET minutes, wraps midnight
const HM = s => +s.slice(0, 2) * 60 + +s.slice(2);
export const SESS = { asian: [HM('1800'), HM('0300')], london: [HM('0300'), HM('0830')], manip: [HM('0930'), HM('0950')],
  macro: [HM('0950'), HM('1010')], watch: [HM('0930'), HM('1010')], flat: [HM('1200'), HM('1201')], rest: [HM('0950'), HM('1100')] };

/**
 * Run the strategy over bars (oldest first).
 * cfg: { stopMode, fixedStop, maxRisk, sweepLvl, useDisp, rr, dispLen, dispMult, rollGap, fillThrough }
 * opts.snapshots: also return the engine state after every bar (for replay)
 * opts.seed / opts.seedFrom: start at bars[seedFrom] with session levels already known (bars before it
 *   only feed the displacement average and BOS lookback). Used by the session replay.
 * Returns { trades, funnel, skipped, events, state, snapshots? }
 */
export function run(bars, sym, cfg, opts = {}) {
  const I = INSTR[sym], tick = I.tick;
  const st = { aH: NaN, aL: NaN, lH: NaN, lL: NaN, pdH: NaN, pdL: NaN, dH: NaN, dL: NaN,
    sslSwept: false, bslSwept: false, sweepLow: NaN, sweepHigh: NaN, traded: false,
    sslCount: 0, bslCount: 0, wasBelow: false, wasAbove: false, ssl2Low: NaN, bsl2High: NaN,
    bosUp: false, bosDn: false, fvgMidL: NaN, fvgMidS: NaN, ifvgMidL: NaN, ifvgMidS: NaN, sslName: '', bslName: '', rejected: '', mOpen: NaN, nyH: NaN, nyL: NaN,
    swH: NaN, swL: NaN, refH: NaN, refL: NaN, nTrades: 0, rearm: false,
    taken: { aH: false, aL: false, lH: false, lL: false, pdH: false, pdL: false },
    atr: NaN, fvgLoL: NaN, fvgHiL: NaN, fvgLoS: NaN, fvgHiS: NaN, fvgBarL: -1, fvgBarS: -1, bosBarL: -1, bosBarS: -1, ifvgMidL: NaN, ifvgMidS: NaN, gapUp: null, gapDn: null };
  const fresh = !!cfg.freshLevels;
  // anyTime: watch and enter around the clock (one session = 18:00 → 17:00), unfilled orders cancel after restBars candles,
  // trades close at market after holdBars candles. Used to show off-hours setups; the TJR model and Pine parity don't use it.
  const any = !!cfg.anyTime, restBars = cfg.restBars || 12, holdBars = cfg.holdBars || 24;
  const W0 = any ? 1080 : cfg.watchStart ?? 570, W1 = any ? 1080 : cfg.watchEnd ?? 610, E0 = any ? 1080 : cfg.entryStart ?? 590, E1 = any ? 1080 : cfg.entryEnd ?? 610, maxT = cfg.maxTrades || 1;
  const fun = { days: 0, sweep: 0, bos: 0, fvg: 0, orders: 0 };
  let c = { sweep: false, bos: false, fvg: false, risk: false };
  let pending = null, pos = null, flatNext = false;
  const trades = [], skipped = new Set(), events = [], snaps = [];
  const bodies = bars.map(b => Math.abs(b.c - b.o));
  const ev = (b, type, text, data) => events.push({ td: b.td, t: b.t, hm: b.hm, type, text, ...(data ? { data } : {}) });

  const levels = isHigh => {
    const a = [];
    if (cfg.sweepLvl === 'Any' || cfg.sweepLvl === 'Asian H/L') a.push({ p: isHigh ? st.aH : st.aL, n: isHigh ? 'Asian high' : 'Asian low', k: isHigh ? 'aH' : 'aL' });
    if (cfg.sweepLvl === 'Any' || cfg.sweepLvl === 'London H/L') a.push({ p: isHigh ? st.lH : st.lL, n: isHigh ? 'London high' : 'London low', k: isHigh ? 'lH' : 'lL' });
    if (cfg.sweepLvl === 'Any' || cfg.sweepLvl === 'PDH/PDL') a.push({ p: isHigh ? st.pdH : st.pdL, n: isHigh ? 'Prior-day high' : 'Prior-day low', k: isHigh ? 'pdH' : 'pdL' });
    return a.filter(x => x.p != null && !Number.isNaN(x.p) && !(fresh && st.taken[x.k]));
  };
  const nearest = (a, isHigh) => a.length ? a.reduce((m, x) => (isHigh ? x.p < m.p : x.p > m.p) ? x : m) : null;
  const target = (a, isHigh, edge) => { const f = a.filter(x => isHigh ? x.p >= edge : x.p <= edge); return f.length ? nearest(f, isHigh) : null; };
  // nearest liquidity pool at or beyond `edge` in the trade's direction (all session levels, midnight open, NY high/low)
  const liquidity = (isLong, edge) => {
    const pools = [['Asian high', st.aH], ['Asian low', st.aL], ['London high', st.lH], ['London low', st.lL], ['Prior-day high', st.pdH], ['Prior-day low', st.pdL],
      ['Midnight open', st.mOpen], ['NY high', st.nyH], ['NY low', st.nyL]].filter(([, p]) => !Number.isNaN(p) && (isLong ? p >= edge : p <= edge));
    return pools.length ? pools.map(([n, p]) => ({ n, p })).reduce((m, x) => (isLong ? x.p < m.p : x.p > m.p) ? x : m) : null;
  };
  const stopFor = (isLong, entry) => {
    if (cfg.stopMode === 'Fixed points') return isLong ? entry - cfg.fixedStop : entry + cfg.fixedStop;
    // study-only stop modes (scripts/entry-study.mjs); the Pine script has none of these
    if (cfg.stopMode === 'ATR') { const d = Math.max(tick, Math.round(cfg.atrMult * st.atr / tick) * tick); return isLong ? entry - d : entry + d; }
    if (cfg.stopMode === 'Sweep+buffer') { const d = (cfg.stopBuf || 0); return isLong ? st.sweepLow - tick - d : st.sweepHigh + tick + d; }
    if (cfg.stopMode === 'FVG far') { const d = (cfg.stopBuf || 0); return isLong ? st.fvgLoL - d : st.fvgHiS + d; }
    if (cfg.stopMode === 'Second sweep' && (isLong ? st.sslCount >= 2 : st.bslCount >= 2))
      return isLong ? st.ssl2Low - tick : st.bsl2High + tick;
    return isLong ? st.sweepLow - tick : st.sweepHigh + tick;
  };
  // excursion tracking: how far the trade went for (MFE) and against (MAE) you while open
  const track = p => { pos.best = pos.dir === 'long' ? Math.max(pos.best, p) : Math.min(pos.best, p); pos.worst = pos.dir === 'long' ? Math.min(pos.worst, p) : Math.max(pos.worst, p); };
  const close = (b, price, why) => {
    track(price);
    const rest = pos.dir === 'long' ? price - pos.entry : pos.entry - price, risk = Math.abs(pos.entry - pos.stop0);
    const fr = pos.frac ?? 0.5, pts = pos.scaled ? fr * pos.half + (1 - fr) * rest : rest;
    const mfe = Math.abs(pos.best - pos.entry), mae = Math.abs(pos.worst - pos.entry);
    trades.push({ dir: pos.dir, entryTime: pos.entryT, entry: pos.entry, exitTime: `${b.date} ${b.hm}`, exit: price,
      stop: pos.stop0, target: pos.target, tp1: pos.tp1, scaled: !!pos.scaled, risk: +risk.toFixed(2), r: risk ? +(pts / risk).toFixed(2) : 0,
      mfe: +mfe.toFixed(2), mae: +mae.toFixed(2), mfeR: risk ? +(mfe / risk).toFixed(2) : 0, maeR: risk ? +(mae / risk).toFixed(2) : 0, mins: Math.round((b.t - pos.fillT) / 60),
      pts: +pts.toFixed(2), pnl: +(pts * I.pointValue - 2 * COMMISSION).toFixed(2), why, td: pos.td });
    if (maxT > 1) st.rearm = true;
    ev(b, 'exit', `${why === 'target' ? 'Target' : why === 'stop' ? 'Stopped out' : 'Closed'} at ${price.toFixed(2)} (${pts >= 0 ? '+' : ''}${pts.toFixed(2)} pts)`, { px: price, why, pts, dir: pos.dir, targetName: pos.targetName });
    pos = null;
  };

  // Broker emulation for one bar: Pine walks open→high→low→close if the high is nearer the open, else open→low→high→close
  function emulate(b) {
    const legs = Math.abs(b.h - b.o) < Math.abs(b.o - b.l) ? [[b.o, b.h], [b.h, b.l], [b.l, b.c]] : [[b.o, b.l], [b.l, b.h], [b.h, b.c]];
    let first = true;
    for (const leg of legs) {
      let [a, z] = leg;
      const down = z < a;
      if (!pos && pending && pending.market && first) {
        // study-only market entry (entryAt 'market' / 'bos'): fills at this bar's open with slippage
        const p = pending, px = p.dir === 'long' ? a + cfg.slipTicks * tick : a - cfg.slipTicks * tick;
        pos = { dir: p.dir, entry: px, stop: p.stop, target: p.target, entryT: `${b.date} ${b.hm}`, td: b.td, fillT: b.t, best: px, worst: px, targetName: p.targetName, stop0: p.stop, tp1: p.tp1, tp1Name: p.tp1Name, frac: p.frac, thr: p.thr || 0 };
        pending = null;
        ev(b, 'fill', `Filled ${p.dir} at ${px.toFixed(2)} (market)`, { px, dir: p.dir });
      }
      if (!pos && pending) {
        const p = pending, L = p.limit, ft = cfg.fillThrough * tick; // fillThrough: price must trade this many ticks past the limit
        const T = p.dir === 'long' ? L - ft : L + ft;
        const hit = p.dir === 'long' ? (first && a <= T) || (down && z <= T && a >= T) : (first && a >= T) || (!down && z >= T && a <= T);
        if (hit) {
          const px = first && (p.dir === 'long' ? a <= L : a >= L) ? (p.dir === 'long' ? Math.min(a, L) : Math.max(a, L)) : L;
          pos = { dir: p.dir, entry: px, stop: p.stop, target: p.target, entryT: `${b.date} ${b.hm}`, td: b.td, fillT: b.t, best: px, worst: px, targetName: p.targetName, stop0: p.stop, tp1: p.tp1, tp1Name: p.tp1Name, frac: p.frac, thr: p.thr || 0 };
          pending = null;
          ev(b, 'fill', `Filled ${p.dir} at ${px.toFixed(2)}`, { px, dir: p.dir });
          a = ft ? T : px; // the rest of this leg can still reach the stop/target
        }
      }
      if (pos) {
        const lng = pos.dir === 'long';
        const stopHit = lng ? (first && a <= pos.stop) || (down && z <= pos.stop && a >= pos.stop)
                            : (first && a >= pos.stop) || (!down && z >= pos.stop && a <= pos.stop);
        // take-profits fill at their price, but only once price trades thr ticks past it (tpThrough; 0 = touch, as in Pine)
        const th = (pos.thr || 0) * tick, TG = lng ? pos.target + th : pos.target - th;
        const tgtHit = lng ? (first && a >= TG) || (!down && z >= TG && a <= TG)
                           : (first && a <= TG) || (down && z <= TG && a >= TG);
        if (stopHit) { const gap = lng ? a < pos.stop : a > pos.stop; const raw = gap && first ? a : pos.stop; close(b, lng ? raw - cfg.slipTicks * tick : raw + cfg.slipTicks * tick, pos.scaled ? 'break-even' : 'stop'); return; }
        if (pos.tp1 != null && !pos.scaled) {
          const T1 = lng ? pos.tp1 + th : pos.tp1 - th;
          const t1 = lng ? (first && a >= T1) || (!down && z >= T1 && a <= T1) : (first && a <= T1) || (down && z <= T1 && a >= T1);
          const fr = pos.frac ?? 0.5, frTxt = fr === 0.5 ? 'Half' : Math.abs(fr - 2 / 3) < 1e-9 ? '2 of 3' : `${Math.round(fr * 100)}%`;
          if (t1) { pos.scaled = true; pos.half = Math.abs(pos.tp1 - pos.entry); pos.stop = pos.entry; ev(b, 'scale', `${frTxt} out at ${pos.tp1.toFixed(2)} (${pos.tp1Name}); stop to break-even ${pos.entry.toFixed(2)}`, { px: pos.tp1, name: pos.tp1Name }); }
        }
        if (tgtHit) { const gap = lng ? a > pos.target : a < pos.target; close(b, gap && first ? a : pos.target, 'target'); return; }
      }
      first = false;
    }
  }

  let prevTd = null, prevC = null, rollDay = null, i0 = 0;
  if (opts.seed) { for (const [k, v] of Object.entries(opts.seed)) { if (k === 'taken') st.taken = { ...st.taken, ...v }; else st[k] = v == null ? NaN : v; } i0 = opts.seedFrom || 0; prevTd = bars[i0] && bars[i0].td; prevC = bars[i0] && bars[i0].o; }
  for (let i = i0; i < bars.length; i++) {
    const b = bars[i], m = b.m;
    // 1. orders resting from the previous bar's close fill on this bar
    if (flatNext && pos) { const lng = pos.dir === 'long'; close(b, lng ? b.o - cfg.slipTicks * tick : b.o + cfg.slipTicks * tick, any ? 'time stop' : '12:00 flat'); }
    flatNext = false;
    if (pending || pos) emulate(b);
    if (pos) { if (pos.fillT === b.t) track(b.c); else { track(b.h); track(b.l); } }

    // 2. script logic on this bar's close
    if (b.td !== prevTd) {
      if (prevC != null && Math.abs(b.o - prevC) / prevC > cfg.rollGap) { rollDay = b.td; skipped.add(b.td); }
      st.pdH = rollDay === b.td ? NaN : st.dH; st.pdL = rollDay === b.td ? NaN : st.dL; st.dH = b.h; st.dL = b.l; st.taken.pdH = st.taken.pdL = false;
    } else { st.dH = Math.max(st.dH, b.h); st.dL = Math.min(st.dL, b.l); }
    prevTd = b.td; prevC = b.c;
    const asian = inWin(m, ...SESS.asian), london = inWin(m, ...SESS.london), watch = inWin(m, W0, W1), macro = inWin(m, E0, E1);
    const pb = bars[i - 1], pm = pb ? pb.m : -1;
    if (asian && !(pb && inWin(pm, ...SESS.asian))) { st.aH = b.h; st.aL = b.l; st.taken.aH = st.taken.aL = false; } else if (asian) { st.aH = Math.max(st.aH, b.h); st.aL = Math.min(st.aL, b.l); }
    if (london && !(pb && inWin(pm, ...SESS.london))) { st.lH = b.h; st.lL = b.l; st.taken.lH = st.taken.lL = false; } else if (london) { st.lH = Math.max(st.lH, b.h); st.lL = Math.min(st.lL, b.l); }
    if (m === 0) st.mOpen = b.o;
    if (b.td !== (pb && pb.td)) st.mOpen = NaN;
    if (m >= 570 && m < 720) { st.nyH = (pb && pb.td === b.td && pm >= 570) ? Math.max(st.nyH, b.h) : b.h; st.nyL = (pb && pb.td === b.td && pm >= 570) ? Math.min(st.nyL, b.l) : b.l; }
    const startWatch = watch && !(pb && inWin(pm, W0, W1) && pb.td === b.td);
    if (startWatch) {
      Object.assign(st, { sslSwept: false, bslSwept: false, traded: false, sweepLow: b.l, sweepHigh: b.h, sslCount: 0, bslCount: 0,
        wasBelow: false, wasAbove: false, ssl2Low: NaN, bsl2High: NaN, bosUp: false, bosDn: false, fvgMidL: NaN, fvgMidS: NaN, ifvgMidL: NaN, ifvgMidS: NaN, sslName: '', bslName: '', rejected: '', nTrades: 0, rearm: false });
      c = { sweep: false, bos: false, fvg: false, risk: false };
      if (!skipped.has(b.td)) fun.days++;
    } else if (st.rearm && watch && !pos && !pending) {
      // a new setup needs a new sweep, break and gap
      Object.assign(st, { sslSwept: false, bslSwept: false, sweepLow: b.l, sweepHigh: b.h, sslCount: 0, bslCount: 0, wasBelow: false, wasAbove: false,
        ssl2Low: NaN, bsl2High: NaN, bosUp: false, bosDn: false, fvgMidL: NaN, fvgMidS: NaN, ifvgMidL: NaN, ifvgMidS: NaN, sslName: '', bslName: '', rearm: false });
    }
    const lowArr = levels(false), highArr = levels(true), lowLiq = nearest(lowArr, false), highLiq = nearest(highArr, true);
    if (watch) {
      const below = !!lowLiq && b.l < lowLiq.p, above = !!highLiq && b.h > highLiq.p;
      if (below) {
        if (!st.sslSwept) { st.sslName = lowLiq.n; ev(b, 'sweep', `Sell-side swept: ${lowLiq.n} ${lowLiq.p.toFixed(2)} (low ${b.l.toFixed(2)})`); }
        st.sslSwept = true; st.sweepLow = Math.min(st.sweepLow, b.l); if (!st.wasBelow) st.sslCount++;
        if (st.sslCount >= 2) st.ssl2Low = Number.isNaN(st.ssl2Low) ? b.l : Math.min(st.ssl2Low, b.l);
      }
      if (above) {
        if (!st.bslSwept) { st.bslName = highLiq.n; ev(b, 'sweep', `Buy-side swept: ${highLiq.n} ${highLiq.p.toFixed(2)} (high ${b.h.toFixed(2)})`); }
        st.bslSwept = true; st.sweepHigh = Math.max(st.sweepHigh, b.h); if (!st.wasAbove) st.bslCount++;
        if (st.bslCount >= 2) st.bsl2High = Number.isNaN(st.bsl2High) ? b.h : Math.max(st.bsl2High, b.h);
      }
      st.wasBelow = below; st.wasAbove = above;
    }
    if (!asian) { if (b.h > st.aH) st.taken.aH = true; if (b.l < st.aL) st.taken.aL = true; }
    if (!london && !asian) { if (b.h > st.lH) st.taken.lH = true; if (b.l < st.lL) st.taken.lL = true; }
    if (b.h > st.pdH) st.taken.pdH = true; if (b.l < st.pdL) st.taken.pdL = true;
    let avgBody = 0; for (let k = Math.max(0, i - cfg.dispLen + 1); k <= i; k++) avgBody += bodies[k]; avgBody /= Math.min(cfg.dispLen, i + 1);
    const dispUp = b.c > b.o && bodies[i] > cfg.dispMult * avgBody, dispDn = b.c < b.o && bodies[i] > cfg.dispMult * avgBody;
    const b2 = bars[i - 2];
    const bullFVG = b2 && b.l > b2.h, bearFVG = b2 && b.h < b2.l;
    // study-only: ATR(14) on 5m and inversion FVGs (IFVG) for stopMode 'ATR' / entryAt 'ifvg'
    { const tr = Math.max(b.h - b.l, pb ? Math.abs(b.h - pb.c) : 0, pb ? Math.abs(b.l - pb.c) : 0); st.atr = Number.isNaN(st.atr) ? tr : st.atr + (tr - st.atr) / 14; }
    if (cfg.entryAt === 'ifvg') {
      if (watch && st.sslSwept && st.gapDn && b.c > st.gapDn.hi && Number.isNaN(st.ifvgMidL) && (!cfg.useDisp || dispUp)) { st.ifvgMidL = (st.gapDn.lo + st.gapDn.hi) / 2; st.fvgLoL = st.gapDn.lo; st.fvgHiL = st.gapDn.hi; ev(b, 'fvg', `Bullish IFVG ${st.gapDn.lo.toFixed(2)}–${st.gapDn.hi.toFixed(2)}`, { dir: 'bull', lo: st.gapDn.lo, hi: st.gapDn.hi, mid: st.ifvgMidL }); }
      if (watch && st.bslSwept && st.gapUp && b.c < st.gapUp.lo && Number.isNaN(st.ifvgMidS) && (!cfg.useDisp || dispDn)) { st.ifvgMidS = (st.gapUp.lo + st.gapUp.hi) / 2; st.fvgLoS = st.gapUp.lo; st.fvgHiS = st.gapUp.hi; ev(b, 'fvg', `Bearish IFVG ${st.gapUp.lo.toFixed(2)}–${st.gapUp.hi.toFixed(2)}`, { dir: 'bear', lo: st.gapUp.lo, hi: st.gapUp.hi, mid: st.ifvgMidS }); }
      if (bearFVG) st.gapDn = { lo: b.h, hi: b2.l, i }; if (bullFVG) st.gapUp = { lo: b2.h, hi: b.l, i };
      if (st.gapDn && i - st.gapDn.i > 12) st.gapDn = null; if (st.gapUp && i - st.gapUp.i > 12) st.gapUp = null;
    }
    let hh = -Infinity, ll = Infinity; for (let k = Math.max(0, i - 5); k < i; k++) { hh = Math.max(hh, bars[k].h); ll = Math.min(ll, bars[k].l); }
    if (i >= 4) { const j = i - 2, p = bars[j];
      if (p.h > bars[j - 1].h && p.h > bars[j - 2].h && p.h >= bars[j + 1].h && p.h >= bars[j + 2].h) st.swH = p.h;
      if (p.l < bars[j - 1].l && p.l < bars[j - 2].l && p.l <= bars[j + 1].l && p.l <= bars[j + 2].l) st.swL = p.l; }
    const swing = cfg.bosMode === 'swing', pc = i > 0 ? bars[i - 1].c : b.c;
    st.refH = swing ? st.swH : hh; st.refL = swing ? st.swL : ll;
    const bullBOS = swing ? (!Number.isNaN(st.swH) && b.c > st.swH && pc <= st.swH && (!cfg.useDisp || dispUp)) : b.c > hh && (!cfg.useDisp || dispUp);
    const bearBOS = swing ? (!Number.isNaN(st.swL) && b.c < st.swL && pc >= st.swL && (!cfg.useDisp || dispDn)) : b.c < ll && (!cfg.useDisp || dispDn);
    if (watch) {
      if (st.sslSwept && bullBOS && !st.bosUp) { st.bosUp = true; st.bosBarL = i; ev(b, 'bos', `Bullish break of structure: close ${b.c.toFixed(2)} above ${st.refH.toFixed(2)} (${swing ? 'last swing high' : '5-candle high'})`, { dir: 'bull', level: st.refH, close: b.c }); }
      if (st.bslSwept && bearBOS && !st.bosDn) { st.bosDn = true; st.bosBarS = i; ev(b, 'bos', `Bearish break of structure: close ${b.c.toFixed(2)} below ${st.refL.toFixed(2)} (${swing ? 'last swing low' : '5-candle low'})`, { dir: 'bear', level: st.refL, close: b.c }); }
      if (st.bosUp && bullFVG) { st.fvgMidL = (b.l + b2.h) / 2; st.fvgLoL = b2.h; st.fvgHiL = b.l; st.fvgBarL = i; ev(b, 'fvg', `Bullish FVG ${b2.h.toFixed(2)}–${b.l.toFixed(2)}, midpoint ${st.fvgMidL.toFixed(2)}`, { dir: 'bull', lo: b2.h, hi: b.l, mid: st.fvgMidL }); }
      if (st.bosDn && bearFVG) { st.fvgMidS = (b.h + b2.l) / 2; st.fvgLoS = b.h; st.fvgHiS = b2.l; st.fvgBarS = i; ev(b, 'fvg', `Bearish FVG ${b.h.toFixed(2)}–${b2.l.toFixed(2)}, midpoint ${st.fvgMidS.toFixed(2)}`, { dir: 'bear', lo: b.h, hi: b2.l, mid: st.fvgMidS }); }
      if (!skipped.has(b.td)) {
        if ((st.sslSwept || st.bslSwept) && !c.sweep) { c.sweep = true; fun.sweep++; }
        if ((st.bosUp || st.bosDn) && !c.bos) { c.bos = true; fun.bos++; }
        if ((!Number.isNaN(st.fvgMidL) || !Number.isNaN(st.fvgMidS)) && !c.fvg) { c.fvg = true; fun.fvg++; }
      }
    }
    // pause (study option): [start, end) ET minutes with no new orders; a resting order still unfilled at the pause is pulled
    //   and may be placed again after it (it doesn't use up the day's setup)
    const paused = cfg.pause && inWin(m, cfg.pause[0], cfg.pause[1]);
    if (paused && pending && !pos) { ev(b, 'cancel', 'Unfilled order pulled for the pause'); pending = null; st.nTrades--; }
    const canTrade = () => macro && !paused && st.nTrades < maxT && !pos && !pending && !skipped.has(b.td);
    const place = (dir, entry, mkt) => {
      const lng = dir === 'long', stop = stopFor(lng, entry), risk = lng ? entry - stop : stop - entry;
      if (!(risk > 0 && risk <= cfg.maxRisk)) {
        st.rejected = `${dir} at ${entry.toFixed(2)} skipped: stop ${risk.toFixed(2)} pts ${risk > 0 ? '> max ' + cfg.maxRisk : 'invalid'}`;
        return;
      }
      const lt = target(lng ? highArr : lowArr, lng, lng ? entry + risk : entry - risk);
      const tgt = lt ? lt.p : (lng ? entry + risk * cfg.rr : entry - risk * cfg.rr);
      // TradingView rounds limit prices to the tick: longs down, shorts up (matches its v4 trade list)
      const lim = lng ? Math.floor(entry / tick) * tick : Math.ceil(entry / tick) * tick;
      let tgtP = Math.round(tgt / tick) * tick, targetName = lt ? lt.n : `${cfg.rr}R`, tp1 = null, tp1Name = null;
      if (cfg.exitMode === 'liq' || cfg.exitMode === 'scale') {
        const L = liquidity(lng, lim + (lng ? risk : -risk));
        const p1 = L ? L.p : lim + (lng ? risk : -risk), n1 = L ? L.n : '1R';
        if (cfg.exitMode === 'liq') { tgtP = Math.round(p1 / tick) * tick; targetName = n1; }
        else if (lng ? p1 < tgtP : p1 > tgtP) { tp1 = Math.round(p1 / tick) * tick; tp1Name = n1; }
      } else if (cfg.exitMode === 'funded') {
        const rk = lng ? lim - stop : stop - lim;
        tp1 = Math.round((lng ? lim + rk : lim - rk) / tick) * tick; tp1Name = '1R';
        tgtP = Math.round((lng ? lim + 2 * rk : lim - 2 * rk) / tick) * tick; targetName = '2R';
      } else if (cfg.exitMode === 'r1') {
        const rk = lng ? lim - stop : stop - lim;
        tgtP = Math.round((lng ? lim + rk : lim - rk) / tick) * tick; targetName = '1R';
      }
      // funded / 1:1 exits: take-profits need price to trade 1 tick through (cfg.tpThrough); funded takes 2 of 3 contracts off at 1R (cfg.tp1Frac)
      const realTP = cfg.exitMode === 'funded' || cfg.exitMode === 'r1';
      const frac = cfg.exitMode === 'funded' ? (cfg.tp1Frac ?? 2 / 3) : 0.5, thr = cfg.tpThrough ?? (realTP ? 1 : 0);
      pending = { ...(mkt ? { market: true } : {}), dir, limit: lim, stop, target: tgtP, targetName, tp1, tp1Name, frac, thr, risk: lng ? lim - stop : stop - lim, placedAt: b.hm, placedT: b.t, td: b.td };
      st.traded = true; st.nTrades++; st.rejected = '';
      ev(b, 'order', `${lng ? 'Buy' : 'Sell'} limit ${lim.toFixed(2)} · stop ${stop.toFixed(2)} · target ${pending.target.toFixed(2)} (${pending.targetName})`, { dir, limit: lim, stop, target: pending.target, targetName: pending.targetName, tp1, tp1Name });
      if (!c.risk) { c.risk = true; fun.orders++; }
    };
    // entryAt (study option, default 'mid' = Pine): 'edge' = near edge of the FVG (first touch) · 'far' = far edge ·
    //   'market' = market order at the FVG candle's close (fills next open) · 'bos' = market at the BOS candle's close (no FVG needed) ·
    //   'ifvg' = after the sweep, a close through an opposite-way FVG (inversion) → limit at that IFVG's midpoint (no BOS/FVG needed)
    const EA = cfg.entryAt || 'mid';
    if (EA === 'mid') {
      if (canTrade() && !Number.isNaN(st.fvgMidL)) place('long', st.fvgMidL);
      if (canTrade() && !Number.isNaN(st.fvgMidS)) place('short', st.fvgMidS);
    } else if (EA === 'edge' || EA === 'far') {
      if (canTrade() && !Number.isNaN(st.fvgMidL)) place('long', EA === 'edge' ? st.fvgHiL : st.fvgLoL);
      if (canTrade() && !Number.isNaN(st.fvgMidS)) place('short', EA === 'edge' ? st.fvgLoS : st.fvgHiS);
    } else if (EA === 'market') {
      if (canTrade() && !Number.isNaN(st.fvgMidL) && st.fvgBarL === i) place('long', b.c, true);
      if (canTrade() && !Number.isNaN(st.fvgMidS) && st.fvgBarS === i) place('short', b.c, true);
    } else if (EA === 'bos') {
      if (canTrade() && st.bosUp && st.bosBarL === i) place('long', b.c, true);
      if (canTrade() && st.bosDn && st.bosBarS === i) place('short', b.c, true);
    } else if (EA === 'ifvg') {
      if (canTrade() && !Number.isNaN(st.ifvgMidL)) place('long', st.ifvgMidL);
      if (canTrade() && !Number.isNaN(st.ifvgMidS)) place('short', st.ifvgMidS);
    }
    if (any && !pos && pending && b.t - pending.placedT >= restBars * 300) { ev(b, 'cancel', `Unfilled order cancelled (${restBars} candles)`); pending = null; st.rearm = true; }
    if (!any && !inWin(m, cfg.restStart ?? SESS.rest[0], cfg.restEnd || SESS.rest[1]) && !pos && pending) { ev(b, 'cancel', `Unfilled order cancelled (${Math.floor((cfg.restEnd || 660) / 60)}:${String((cfg.restEnd || 660) % 60).padStart(2, '0')})`); pending = null; if (maxT > 1) st.rearm = true; }
    if (pos && (any ? b.t - pos.fillT >= holdBars * 300 : inWin(m, ...SESS.flat))) flatNext = true;
    if (opts.snapshots) snaps.push(snapshot(b));
  }
  function snapshot(b) {
    return { t: b.t, td: b.td, hm: b.hm, m: b.m, close: b.c,
      levels: { asianH: st.aH, asianL: st.aL, londonH: st.lH, londonL: st.lL, pdH: st.pdH, pdL: st.pdL, dH: st.dH, dL: st.dL, mOpen: st.mOpen, nyH: st.nyH, nyL: st.nyL },
      sslSwept: st.sslSwept, bslSwept: st.bslSwept, sslName: st.sslName, bslName: st.bslName, sweepLow: st.sweepLow, sweepHigh: st.sweepHigh,
      sslCount: st.sslCount, bslCount: st.bslCount, bosUp: st.bosUp, bosDn: st.bosDn, fvgMidL: st.fvgMidL, fvgMidS: st.fvgMidS,
      taken: { ...st.taken }, traded: st.traded, nTrades: st.nTrades, rejected: st.rejected, swH: st.swH, swL: st.swL, refH: st.refH, refL: st.refL, bosMode: cfg.bosMode || 'bars5', pending: pending && { ...pending }, pos: pos && { ...pos }, skipped: skipped.has(b.td) };
  }
  const last = bars[bars.length - 1];
  const state = last ? snapshot(last) : null;
  if (pos && !opts.keepOpen) close(last, last.c, 'end of data');
  return { trades, funnel: fun, skipped: [...skipped], events, state, snapshots: opts.snapshots ? snaps : undefined };
}

// Summary statistics for a list of trades
export function stats(trades) {
  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0), gl = -losses.reduce((a, t) => a + t.pnl, 0);
  let eq = 0, peak = 0, dd = 0;
  const equity = trades.map(t => { eq += t.pnl; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); return +eq.toFixed(2); });
  const n = trades.length, wr = n ? wins.length / n : 0;
  // Wilson 90% interval on the win rate: how wide the uncertainty is with this few trades
  const z = 1.645, den = 1 + z * z / n, ctr = (wr + z * z / (2 * n)) / den, half = n ? z * Math.sqrt(wr * (1 - wr) / n + z * z / (4 * n * n)) / den : 0;
  return { trades: n, wins: wins.length, net: +eq.toFixed(2), winRate: wr, winRateLo: n ? Math.max(0, ctr - half) : 0, winRateHi: n ? Math.min(1, ctr + half) : 0,
    pf: gl ? +(gw / gl).toFixed(2) : (gw ? null : 0), expectancy: n ? +(eq / n).toFixed(2) : 0,
    reach: [0.5, 1, 1.5, 2, 3].map(k => ({ r: k, pct: n ? trades.filter(t => (t.mfeR ?? 0) >= k).length / n : 0 })),
    medMins: n ? trades.map(t => t.mins ?? 0).sort((a, b) => a - b)[n >> 1] : 0,
    avgR: n ? +(trades.reduce((a, t) => a + t.r, 0) / n).toFixed(2) : 0,
    avgWin: wins.length ? +(gw / wins.length).toFixed(2) : 0, avgLoss: losses.length ? +(-gl / losses.length).toFixed(2) : 0, maxDD: +dd.toFixed(2), equity };
}
