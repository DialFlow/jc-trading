// Backtest of jc_tjr_backtest_v5.pine on real ES1!/NQ1! 5-minute candles (Yahoo ES=F / NQ=F,
// the CME front-month E-mini). A bar-by-bar port of the Pine logic, including how TradingView's
// broker emulator fills limit and stop orders inside a bar.
//
// Usage: node scripts/backtest.mjs [out.json]      (default: backtest.json next to index.html)
//        node scripts/backtest.mjs --validate      (prints the v4 ES trade list to compare with TradingView)
import { writeFileSync } from 'node:fs';

const OUT = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : new URL('../backtest.json', import.meta.url);
const VALIDATE = process.argv.includes('--validate');

const INSTR = {
  'ES=F': { name: 'ES1!', pointValue: 50, tick: 0.25, stopScale: 1 },
  'NQ=F': { name: 'NQ1!', pointValue: 20, tick: 0.25, stopScale: 4 }, // NQ moves ~4× ES in points
};
const COMMISSION = 2.5; // per contract per side
const SLIP_TICKS = 1;   // market and stop orders only (Pine doesn't slip limit orders)

// ---------- data ----------
const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
function et(t) {
  const p = {}; for (const x of etFmt.formatToParts(new Date(t * 1000))) p[x.type] = x.value;
  const m = +p.hour * 60 + +p.minute;
  // CME trading day starts at 18:00 ET: bars from 18:00 belong to the next calendar day's session
  const d = new Date(Date.UTC(+p.year, +p.month - 1, +p.day + (m >= 1080 ? 1 : 0)));
  return { date: `${p.year}-${p.month}-${p.day}`, m, td: d.toISOString().slice(0, 10), hm: `${p.hour}:${p.minute}` };
}
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

// ---------- strategy ----------
const inWin = (m, a, b) => a < b ? m >= a && m < b : m >= a || m < b; // [a, b) in ET minutes, wraps midnight
const HM = s => +s.slice(0, 2) * 60 + +s.slice(2);
const S = { asian: [HM('1800'), HM('0300')], london: [HM('0300'), HM('0830')], manip: [HM('0930'), HM('0950')],
  macro: [HM('0950'), HM('1010')], watch: [HM('0930'), HM('1010')], flat: [HM('1200'), HM('1201')], rest: [HM('0950'), HM('1100')] };

function run(data, sym, cfg) {
  const I = INSTR[sym], bars = data.bars, tick = I.tick;
  const st = { aH: NaN, aL: NaN, lH: NaN, lL: NaN, pdH: NaN, pdL: NaN, dH: NaN, dL: NaN,
    sslSwept: false, bslSwept: false, sweepLow: NaN, sweepHigh: NaN, traded: false,
    sslCount: 0, bslCount: 0, wasBelow: false, wasAbove: false, ssl2Low: NaN, bsl2High: NaN,
    bosUp: false, bosDn: false, fvgMidL: NaN, fvgMidS: NaN };
  const fun = { days: 0, sweep: 0, bos: 0, fvg: 0, orders: 0 };
  let c = { sweep: false, bos: false, fvg: false, risk: false };
  let pending = null;  // { dir, limit, stop, target, placedAt }
  let pos = null;      // { dir, entry, stop, target, entryT }
  let flatNext = false;
  const trades = [], skipped = new Set();
  const bodies = bars.map(b => Math.abs(b.c - b.o));

  const levels = isHigh => {
    const a = [];
    if (cfg.sweepLvl === 'Any' || cfg.sweepLvl === 'Asian H/L') a.push(isHigh ? st.aH : st.aL);
    if (cfg.sweepLvl === 'Any' || cfg.sweepLvl === 'London H/L') a.push(isHigh ? st.lH : st.lL);
    if (cfg.sweepLvl === 'Any' || cfg.sweepLvl === 'PDH/PDL') a.push(isHigh ? st.pdH : st.pdL);
    return a.filter(x => !Number.isNaN(x));
  };
  const nearest = (a, isHigh) => a.length ? (isHigh ? Math.min(...a) : Math.max(...a)) : NaN;
  const target = (a, isHigh, edge) => { const f = a.filter(x => isHigh ? x >= edge : x <= edge); return f.length ? (isHigh ? Math.min(...f) : Math.max(...f)) : NaN; };
  const stopFor = (isLong, entry) => {
    if (cfg.stopMode === 'Fixed points') return isLong ? entry - cfg.fixedStop : entry + cfg.fixedStop;
    if (cfg.stopMode === 'Second sweep' && (isLong ? st.sslCount >= 2 : st.bslCount >= 2))
      return isLong ? st.ssl2Low - tick : st.bsl2High + tick;
    return isLong ? st.sweepLow - tick : st.sweepHigh + tick;
  };
  const close = (b, price, why) => {
    const pts = pos.dir === 'long' ? price - pos.entry : pos.entry - price;
    trades.push({ dir: pos.dir, entryTime: pos.entryT, entry: pos.entry, exitTime: `${b.date} ${b.hm}`, exit: price,
      stop: pos.stop, target: pos.target, pts: +pts.toFixed(2), pnl: +(pts * I.pointValue - 2 * COMMISSION).toFixed(2), why, td: pos.td });
    pos = null;
  };

  // Broker emulation for one bar: Pine walks open→high→low→close if the high is nearer the open, else open→low→high→close
  function emulate(b) {
    const legs = Math.abs(b.h - b.o) < Math.abs(b.o - b.l) ? [[b.o, b.h], [b.h, b.l], [b.l, b.c]] : [[b.o, b.l], [b.l, b.h], [b.h, b.c]];
    let first = true;
    for (const leg of legs) {
      let [a, z] = leg;
      const down = z < a;
      // entry
      if (!pos && pending) {
        const p = pending, L = p.limit;
        const hit = p.dir === 'long' ? (first && a <= L) || (down && z <= L && a >= L) : (first && a >= L) || (!down && z >= L && a <= L);
        if (hit) {
          const px = first && (p.dir === 'long' ? a <= L : a >= L) ? a : L; // a gap through the limit fills at the open
          pos = { dir: p.dir, entry: px, stop: p.stop, target: p.target, entryT: `${b.date} ${b.hm}`, td: b.td };
          pending = null;
          a = px; // the rest of this leg can still reach the stop/target
        }
      }
      // exits
      if (pos) {
        const lng = pos.dir === 'long';
        const stopHit = lng ? (first && a <= pos.stop) || (down && z <= pos.stop && a >= pos.stop)
                            : (first && a >= pos.stop) || (!down && z >= pos.stop && a <= pos.stop);
        const tgtHit = lng ? (first && a >= pos.target) || (!down && z >= pos.target && a <= pos.target)
                           : (first && a <= pos.target) || (down && z <= pos.target && a >= pos.target);
        if (stopHit) { const gap = lng ? a < pos.stop : a > pos.stop; const raw = gap && first ? a : pos.stop; close(b, lng ? raw - SLIP_TICKS * tick : raw + SLIP_TICKS * tick, 'stop'); return; }
        if (tgtHit) { const gap = lng ? a > pos.target : a < pos.target; close(b, gap && first ? a : pos.target, 'target'); return; }
      }
      first = false;
    }
  }

  let prevTd = null, prevC = null, rollDay = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], m = b.m;
    // 1. orders resting from the previous bar's close fill on this bar
    if (flatNext && pos) { const lng = pos.dir === 'long'; close(b, lng ? b.o - SLIP_TICKS * tick : b.o + SLIP_TICKS * tick, '12:00 flat'); }
    flatNext = false;
    if (pending || pos) emulate(b);

    // 2. script logic on this bar's close
    const newDay = b.td !== prevTd;
    if (newDay) {
      // Yahoo's continuous contract rolls without back-adjustment; a big session-open jump marks the roll day
      if (prevC != null && Math.abs(b.o - prevC) / prevC > cfg.rollGap) { rollDay = b.td; skipped.add(b.td); }
      st.pdH = rollDay === b.td ? NaN : st.dH; st.pdL = rollDay === b.td ? NaN : st.dL; st.dH = b.h; st.dL = b.l;
    } else { st.dH = Math.max(st.dH, b.h); st.dL = Math.min(st.dL, b.l); }
    prevTd = b.td; prevC = b.c;
    const asian = inWin(m, ...S.asian), london = inWin(m, ...S.london), watch = inWin(m, ...S.watch), macro = inWin(m, ...S.macro);
    const pb = bars[i - 1], pm = pb ? pb.m : -1;
    if (asian && !(pb && inWin(pm, ...S.asian))) { st.aH = b.h; st.aL = b.l; } else if (asian) { st.aH = Math.max(st.aH, b.h); st.aL = Math.min(st.aL, b.l); }
    if (london && !(pb && inWin(pm, ...S.london))) { st.lH = b.h; st.lL = b.l; } else if (london) { st.lH = Math.max(st.lH, b.h); st.lL = Math.min(st.lL, b.l); }
    const startWatch = watch && !(pb && inWin(pm, ...S.watch) && pb.td === b.td);
    if (startWatch) {
      Object.assign(st, { sslSwept: false, bslSwept: false, traded: false, sweepLow: b.l, sweepHigh: b.h, sslCount: 0, bslCount: 0,
        wasBelow: false, wasAbove: false, ssl2Low: NaN, bsl2High: NaN, bosUp: false, bosDn: false, fvgMidL: NaN, fvgMidS: NaN });
      c = { sweep: false, bos: false, fvg: false, risk: false };
      if (!skipped.has(b.td)) fun.days++;
    }
    const lowArr = levels(false), highArr = levels(true), lowLiq = nearest(lowArr, false), highLiq = nearest(highArr, true);
    if (watch) {
      const below = !Number.isNaN(lowLiq) && b.l < lowLiq, above = !Number.isNaN(highLiq) && b.h > highLiq;
      if (below) { st.sslSwept = true; st.sweepLow = Math.min(st.sweepLow, b.l); if (!st.wasBelow) st.sslCount++; if (st.sslCount >= 2) st.ssl2Low = Number.isNaN(st.ssl2Low) ? b.l : Math.min(st.ssl2Low, b.l); }
      if (above) { st.bslSwept = true; st.sweepHigh = Math.max(st.sweepHigh, b.h); if (!st.wasAbove) st.bslCount++; if (st.bslCount >= 2) st.bsl2High = Number.isNaN(st.bsl2High) ? b.h : Math.max(st.bsl2High, b.h); }
      st.wasBelow = below; st.wasAbove = above;
    }
    let avgBody = 0; for (let k = Math.max(0, i - cfg.dispLen + 1); k <= i; k++) avgBody += bodies[k]; avgBody /= Math.min(cfg.dispLen, i + 1);
    const dispUp = b.c > b.o && bodies[i] > cfg.dispMult * avgBody, dispDn = b.c < b.o && bodies[i] > cfg.dispMult * avgBody;
    const b2 = bars[i - 2];
    const bullFVG = b2 && b.l > b2.h, bearFVG = b2 && b.h < b2.l;
    let hh = -Infinity, ll = Infinity; for (let k = Math.max(0, i - 5); k < i; k++) { hh = Math.max(hh, bars[k].h); ll = Math.min(ll, bars[k].l); }
    const bullBOS = b.c > hh && (!cfg.useDisp || dispUp), bearBOS = b.c < ll && (!cfg.useDisp || dispDn);
    if (watch) {
      if (st.sslSwept && bullBOS) st.bosUp = true;
      if (st.bslSwept && bearBOS) st.bosDn = true;
      if (st.bosUp && bullFVG) st.fvgMidL = (b.l + b2.h) / 2;
      if (st.bosDn && bearFVG) st.fvgMidS = (b.h + b2.l) / 2;
      if (!skipped.has(b.td)) {
        if ((st.sslSwept || st.bslSwept) && !c.sweep) { c.sweep = true; fun.sweep++; }
        if ((st.bosUp || st.bosDn) && !c.bos) { c.bos = true; fun.bos++; }
        if ((!Number.isNaN(st.fvgMidL) || !Number.isNaN(st.fvgMidS)) && !c.fvg) { c.fvg = true; fun.fvg++; }
      }
    }
    const canTrade = macro && !st.traded && !pos && !skipped.has(b.td);
    const place = (dir, entry) => {
      const lng = dir === 'long', stop = stopFor(lng, entry), risk = lng ? entry - stop : stop - entry;
      if (!(risk > 0 && risk <= cfg.maxRisk)) return;
      const lt = target(lng ? highArr : lowArr, lng, lng ? entry + risk : entry - risk);
      const tgt = Number.isNaN(lt) ? (lng ? entry + risk * cfg.rr : entry - risk * cfg.rr) : lt;
      // TradingView rounds limit prices to the tick: longs down, shorts up (matches its v4 trade list)
      const lim = lng ? Math.floor(entry / tick) * tick : Math.ceil(entry / tick) * tick;
      pending = { dir, limit: lim, stop, target: Math.round(tgt / tick) * tick };
      st.traded = true;
      if (!c.risk) { c.risk = true; fun.orders++; }
    };
    if (canTrade && !Number.isNaN(st.fvgMidL)) place('long', st.fvgMidL);
    if (canTrade && !st.traded && !Number.isNaN(st.fvgMidS)) place('short', st.fvgMidS);
    if (!inWin(m, ...S.rest) && !pos) pending = null;
    if (inWin(m, ...S.flat) && pos) flatNext = true;
  }
  if (pos) close(bars[bars.length - 1], bars[bars.length - 1].c, 'end of data');

  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0), gl = -losses.reduce((a, t) => a + t.pnl, 0);
  let eq = 0, peak = 0, dd = 0; const equity = trades.map(t => { eq += t.pnl; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); return +eq.toFixed(2); });
  return { trades, funnel: fun, skipped: [...skipped], stats: { trades: trades.length, wins: wins.length, net: +eq.toFixed(2),
    winRate: trades.length ? wins.length / trades.length : 0, pf: gl ? +(gw / gl).toFixed(2) : (gw ? null : 0),
    avgWin: wins.length ? +(gw / wins.length).toFixed(2) : 0, avgLoss: losses.length ? +(-gl / losses.length).toFixed(2) : 0, maxDD: +dd.toFixed(2) }, equity };
}

// ---------- runs ----------
// rollGap: a session-open jump this large is treated as a contract roll (no PDH/PDL that day).
// Yahoo ES=F matched TradingView ES1! across the Sep 2026 roll, so this only guards against bad data.
const base = { rr: 2, dispLen: 20, dispMult: 1.5, rollGap: 0.02 };
const out = { generated: new Date().toISOString(), costs: { commissionPerSide: COMMISSION, slippageTicks: SLIP_TICKS, contracts: 1 }, instruments: {}, runs: [] };
for (const sym of Object.keys(INSTR)) {
  const I = INSTR[sym], data = await load(sym);
  const sessions = [...new Set(data.bars.filter(b => b.m >= 570 && b.m < 610).map(b => b.td))];
  out.instruments[sym] = { name: I.name, contract: data.contract, from: data.bars[0].date, to: data.bars[data.bars.length - 1].date, nySessions: sessions.length };
  const cfgs = [{ id: 'v4', label: 'v4 as backtested in TradingView', stopMode: 'Sweep wick', fixedStop: 20 * I.stopScale, maxRisk: 15 * I.stopScale, sweepLvl: 'Any', useDisp: false }];
  for (const stopMode of ['Sweep wick', 'Fixed points', 'Second sweep'])
    for (const sweepLvl of ['Any', 'London H/L', 'Asian H/L', 'PDH/PDL'])
      for (const useDisp of [false, true])
        cfgs.push({ id: `${stopMode}|${sweepLvl}|${useDisp ? 'disp' : 'nodisp'}`, stopMode, fixedStop: 20 * I.stopScale, maxRisk: 25 * I.stopScale, sweepLvl, useDisp });
  for (const cfg of cfgs) {
    const r = run(data, sym, { ...base, ...cfg });
    out.runs.push({ sym, name: I.name, ...cfg, ...r });
  }
  if (VALIDATE && sym === 'ES=F') {
    const v4 = out.runs.find(r => r.sym === sym && r.id === 'v4');
    console.log('ES v4 funnel', v4.funnel, 'skipped (roll):', v4.skipped, 'stats', v4.stats);
    for (const t of v4.trades) console.log(t.dir.padEnd(5), t.entryTime, t.entry, '->', t.exitTime, t.exit, t.why.padEnd(10), t.pnl);
  }
}
if (!VALIDATE) { writeFileSync(OUT, JSON.stringify(out)); console.log('wrote', OUT.toString(), out.runs.length, 'runs'); }
