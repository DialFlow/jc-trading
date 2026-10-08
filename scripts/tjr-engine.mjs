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
//           'scale' = half out at that liquidity, stop to break-even, rest to the rules target
export const BASE = { rr: 2, dispLen: 20, dispMult: 1.5, rollGap: 0.02, fillThrough: 0, slipTicks: SLIP_TICKS, restEnd: 660, exitMode: 'rules' };
export const EXITS = { rules: 'Rules target', liq: 'First liquidity ≥ 1R', scale: 'Half at liquidity, rest runs' };

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
    bosUp: false, bosDn: false, fvgMidL: NaN, fvgMidS: NaN, sslName: '', bslName: '', rejected: '', mOpen: NaN, nyH: NaN, nyL: NaN };
  const fun = { days: 0, sweep: 0, bos: 0, fvg: 0, orders: 0 };
  let c = { sweep: false, bos: false, fvg: false, risk: false };
  let pending = null, pos = null, flatNext = false;
  const trades = [], skipped = new Set(), events = [], snaps = [];
  const bodies = bars.map(b => Math.abs(b.c - b.o));
  const ev = (b, type, text, data) => events.push({ td: b.td, t: b.t, hm: b.hm, type, text, ...(data ? { data } : {}) });

  const levels = isHigh => {
    const a = [];
    if (cfg.sweepLvl === 'Any' || cfg.sweepLvl === 'Asian H/L') a.push({ p: isHigh ? st.aH : st.aL, n: isHigh ? 'Asian high' : 'Asian low' });
    if (cfg.sweepLvl === 'Any' || cfg.sweepLvl === 'London H/L') a.push({ p: isHigh ? st.lH : st.lL, n: isHigh ? 'London high' : 'London low' });
    if (cfg.sweepLvl === 'Any' || cfg.sweepLvl === 'PDH/PDL') a.push({ p: isHigh ? st.pdH : st.pdL, n: isHigh ? 'Prior-day high' : 'Prior-day low' });
    return a.filter(x => !Number.isNaN(x.p));
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
    if (cfg.stopMode === 'Second sweep' && (isLong ? st.sslCount >= 2 : st.bslCount >= 2))
      return isLong ? st.ssl2Low - tick : st.bsl2High + tick;
    return isLong ? st.sweepLow - tick : st.sweepHigh + tick;
  };
  // excursion tracking: how far the trade went for (MFE) and against (MAE) you while open
  const track = p => { pos.best = pos.dir === 'long' ? Math.max(pos.best, p) : Math.min(pos.best, p); pos.worst = pos.dir === 'long' ? Math.min(pos.worst, p) : Math.max(pos.worst, p); };
  const close = (b, price, why) => {
    track(price);
    const rest = pos.dir === 'long' ? price - pos.entry : pos.entry - price, risk = Math.abs(pos.entry - pos.stop0);
    const pts = pos.scaled ? (pos.half + rest) / 2 : rest;
    const mfe = Math.abs(pos.best - pos.entry), mae = Math.abs(pos.worst - pos.entry);
    trades.push({ dir: pos.dir, entryTime: pos.entryT, entry: pos.entry, exitTime: `${b.date} ${b.hm}`, exit: price,
      stop: pos.stop0, target: pos.target, tp1: pos.tp1, scaled: !!pos.scaled, risk: +risk.toFixed(2), r: risk ? +(pts / risk).toFixed(2) : 0,
      mfe: +mfe.toFixed(2), mae: +mae.toFixed(2), mfeR: risk ? +(mfe / risk).toFixed(2) : 0, maeR: risk ? +(mae / risk).toFixed(2) : 0, mins: Math.round((b.t - pos.fillT) / 60),
      pts: +pts.toFixed(2), pnl: +(pts * I.pointValue - 2 * COMMISSION).toFixed(2), why, td: pos.td });
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
      if (!pos && pending) {
        const p = pending, L = p.limit, ft = cfg.fillThrough * tick; // fillThrough: price must trade this many ticks past the limit
        const T = p.dir === 'long' ? L - ft : L + ft;
        const hit = p.dir === 'long' ? (first && a <= T) || (down && z <= T && a >= T) : (first && a >= T) || (!down && z >= T && a <= T);
        if (hit) {
          const px = first && (p.dir === 'long' ? a <= L : a >= L) ? (p.dir === 'long' ? Math.min(a, L) : Math.max(a, L)) : L;
          pos = { dir: p.dir, entry: px, stop: p.stop, target: p.target, entryT: `${b.date} ${b.hm}`, td: b.td, fillT: b.t, best: px, worst: px, targetName: p.targetName, stop0: p.stop, tp1: p.tp1, tp1Name: p.tp1Name };
          pending = null;
          ev(b, 'fill', `Filled ${p.dir} at ${px.toFixed(2)}`, { px, dir: p.dir });
          a = ft ? T : px; // the rest of this leg can still reach the stop/target
        }
      }
      if (pos) {
        const lng = pos.dir === 'long';
        const stopHit = lng ? (first && a <= pos.stop) || (down && z <= pos.stop && a >= pos.stop)
                            : (first && a >= pos.stop) || (!down && z >= pos.stop && a <= pos.stop);
        const tgtHit = lng ? (first && a >= pos.target) || (!down && z >= pos.target && a <= pos.target)
                           : (first && a <= pos.target) || (down && z <= pos.target && a >= pos.target);
        if (stopHit) { const gap = lng ? a < pos.stop : a > pos.stop; const raw = gap && first ? a : pos.stop; close(b, lng ? raw - cfg.slipTicks * tick : raw + cfg.slipTicks * tick, pos.scaled ? 'break-even' : 'stop'); return; }
        if (pos.tp1 != null && !pos.scaled) {
          const t1 = lng ? (first && a >= pos.tp1) || (!down && z >= pos.tp1 && a <= pos.tp1) : (first && a <= pos.tp1) || (down && z <= pos.tp1 && a >= pos.tp1);
          if (t1) { pos.scaled = true; pos.half = Math.abs(pos.tp1 - pos.entry); pos.stop = pos.entry; ev(b, 'scale', `Half out at ${pos.tp1.toFixed(2)} (${pos.tp1Name}); stop to break-even ${pos.entry.toFixed(2)}`, { px: pos.tp1, name: pos.tp1Name }); }
        }
        if (tgtHit) { const gap = lng ? a > pos.target : a < pos.target; close(b, gap && first ? a : pos.target, 'target'); return; }
      }
      first = false;
    }
  }

  let prevTd = null, prevC = null, rollDay = null, i0 = 0;
  if (opts.seed) { Object.assign(st, opts.seed); i0 = opts.seedFrom || 0; prevTd = bars[i0] && bars[i0].td; prevC = bars[i0] && bars[i0].o; }
  for (let i = i0; i < bars.length; i++) {
    const b = bars[i], m = b.m;
    // 1. orders resting from the previous bar's close fill on this bar
    if (flatNext && pos) { const lng = pos.dir === 'long'; close(b, lng ? b.o - cfg.slipTicks * tick : b.o + cfg.slipTicks * tick, '12:00 flat'); }
    flatNext = false;
    if (pending || pos) emulate(b);
    if (pos) { if (pos.fillT === b.t) track(b.c); else { track(b.h); track(b.l); } }

    // 2. script logic on this bar's close
    if (b.td !== prevTd) {
      if (prevC != null && Math.abs(b.o - prevC) / prevC > cfg.rollGap) { rollDay = b.td; skipped.add(b.td); }
      st.pdH = rollDay === b.td ? NaN : st.dH; st.pdL = rollDay === b.td ? NaN : st.dL; st.dH = b.h; st.dL = b.l;
    } else { st.dH = Math.max(st.dH, b.h); st.dL = Math.min(st.dL, b.l); }
    prevTd = b.td; prevC = b.c;
    const asian = inWin(m, ...SESS.asian), london = inWin(m, ...SESS.london), watch = inWin(m, ...SESS.watch), macro = inWin(m, ...SESS.macro);
    const pb = bars[i - 1], pm = pb ? pb.m : -1;
    if (asian && !(pb && inWin(pm, ...SESS.asian))) { st.aH = b.h; st.aL = b.l; } else if (asian) { st.aH = Math.max(st.aH, b.h); st.aL = Math.min(st.aL, b.l); }
    if (london && !(pb && inWin(pm, ...SESS.london))) { st.lH = b.h; st.lL = b.l; } else if (london) { st.lH = Math.max(st.lH, b.h); st.lL = Math.min(st.lL, b.l); }
    if (m === 0) st.mOpen = b.o;
    if (b.td !== (pb && pb.td)) st.mOpen = NaN;
    if (m >= 570 && m < 720) { st.nyH = (pb && pb.td === b.td && pm >= 570) ? Math.max(st.nyH, b.h) : b.h; st.nyL = (pb && pb.td === b.td && pm >= 570) ? Math.min(st.nyL, b.l) : b.l; }
    const startWatch = watch && !(pb && inWin(pm, ...SESS.watch) && pb.td === b.td);
    if (startWatch) {
      Object.assign(st, { sslSwept: false, bslSwept: false, traded: false, sweepLow: b.l, sweepHigh: b.h, sslCount: 0, bslCount: 0,
        wasBelow: false, wasAbove: false, ssl2Low: NaN, bsl2High: NaN, bosUp: false, bosDn: false, fvgMidL: NaN, fvgMidS: NaN, sslName: '', bslName: '', rejected: '' });
      c = { sweep: false, bos: false, fvg: false, risk: false };
      if (!skipped.has(b.td)) fun.days++;
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
    let avgBody = 0; for (let k = Math.max(0, i - cfg.dispLen + 1); k <= i; k++) avgBody += bodies[k]; avgBody /= Math.min(cfg.dispLen, i + 1);
    const dispUp = b.c > b.o && bodies[i] > cfg.dispMult * avgBody, dispDn = b.c < b.o && bodies[i] > cfg.dispMult * avgBody;
    const b2 = bars[i - 2];
    const bullFVG = b2 && b.l > b2.h, bearFVG = b2 && b.h < b2.l;
    let hh = -Infinity, ll = Infinity; for (let k = Math.max(0, i - 5); k < i; k++) { hh = Math.max(hh, bars[k].h); ll = Math.min(ll, bars[k].l); }
    const bullBOS = b.c > hh && (!cfg.useDisp || dispUp), bearBOS = b.c < ll && (!cfg.useDisp || dispDn);
    if (watch) {
      if (st.sslSwept && bullBOS && !st.bosUp) { st.bosUp = true; ev(b, 'bos', `Bullish break of structure: close ${b.c.toFixed(2)} above ${hh.toFixed(2)}`); }
      if (st.bslSwept && bearBOS && !st.bosDn) { st.bosDn = true; ev(b, 'bos', `Bearish break of structure: close ${b.c.toFixed(2)} below ${ll.toFixed(2)}`); }
      if (st.bosUp && bullFVG) { st.fvgMidL = (b.l + b2.h) / 2; ev(b, 'fvg', `Bullish FVG ${b2.h.toFixed(2)}–${b.l.toFixed(2)}, midpoint ${st.fvgMidL.toFixed(2)}`); }
      if (st.bosDn && bearFVG) { st.fvgMidS = (b.h + b2.l) / 2; ev(b, 'fvg', `Bearish FVG ${b.h.toFixed(2)}–${b2.l.toFixed(2)}, midpoint ${st.fvgMidS.toFixed(2)}`); }
      if (!skipped.has(b.td)) {
        if ((st.sslSwept || st.bslSwept) && !c.sweep) { c.sweep = true; fun.sweep++; }
        if ((st.bosUp || st.bosDn) && !c.bos) { c.bos = true; fun.bos++; }
        if ((!Number.isNaN(st.fvgMidL) || !Number.isNaN(st.fvgMidS)) && !c.fvg) { c.fvg = true; fun.fvg++; }
      }
    }
    const canTrade = macro && !st.traded && !pos && !skipped.has(b.td);
    const place = (dir, entry) => {
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
      }
      pending = { dir, limit: lim, stop, target: tgtP, targetName, tp1, tp1Name, risk: lng ? lim - stop : stop - lim, placedAt: b.hm, td: b.td };
      st.traded = true; st.rejected = '';
      ev(b, 'order', `${lng ? 'Buy' : 'Sell'} limit ${lim.toFixed(2)} · stop ${stop.toFixed(2)} · target ${pending.target.toFixed(2)} (${pending.targetName})`, { dir, limit: lim, stop, target: pending.target, targetName: pending.targetName, tp1, tp1Name });
      if (!c.risk) { c.risk = true; fun.orders++; }
    };
    if (canTrade && !Number.isNaN(st.fvgMidL)) place('long', st.fvgMidL);
    if (canTrade && !st.traded && !Number.isNaN(st.fvgMidS)) place('short', st.fvgMidS);
    if (!inWin(m, SESS.rest[0], cfg.restEnd || SESS.rest[1]) && !pos && pending) { ev(b, 'cancel', `Unfilled order cancelled (${Math.floor((cfg.restEnd || 660) / 60)}:${String((cfg.restEnd || 660) % 60).padStart(2, '0')})`); pending = null; }
    if (inWin(m, ...SESS.flat) && pos) flatNext = true;
    if (opts.snapshots) snaps.push(snapshot(b));
  }
  function snapshot(b) {
    return { t: b.t, td: b.td, hm: b.hm, m: b.m, close: b.c,
      levels: { asianH: st.aH, asianL: st.aL, londonH: st.lH, londonL: st.lL, pdH: st.pdH, pdL: st.pdL, dH: st.dH, dL: st.dL, mOpen: st.mOpen, nyH: st.nyH, nyL: st.nyL },
      sslSwept: st.sslSwept, bslSwept: st.bslSwept, sslName: st.sslName, bslName: st.bslName, sweepLow: st.sweepLow, sweepHigh: st.sweepHigh,
      sslCount: st.sslCount, bslCount: st.bslCount, bosUp: st.bosUp, bosDn: st.bosDn, fvgMidL: st.fvgMidL, fvgMidS: st.fvgMidS,
      traded: st.traded, rejected: st.rejected, pending: pending && { ...pending }, pos: pos && { ...pos }, skipped: skipped.has(b.td) };
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
