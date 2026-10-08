// Historical edge of the TJR confluence checklist (Dashboard), per timeframe.
// Runs the checklist code from index.html itself (between the CONFLUENCE-CORE markers) over history:
// at each candle it scores the 6 checks; when ≥5 of 6 (≥75%) agree on a direction, it records whether price
// then moved +1 ATR(14) in that direction before −1 ATR, within a fixed number of candles.
//
// Usage: node scripts/confluence-stats.mjs        → confstats.json next to index.html
import { readFileSync, writeFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const a = html.indexOf('// ===== CONFLUENCE-CORE START'), b = html.indexOf('// ===== CONFLUENCE-CORE END');
if (a < 0 || b < 0) throw new Error('CONFLUENCE-CORE markers not found in index.html');
const core = new Function('JC_API', 'esc', 'getCurrentETTime', html.slice(a, b) +
  '\nreturn { scanFVGs, confChecks, smtCheck, to4h, CONF_ROWS, RECENT };')('', s => s, () => new Date());

const UA = { headers: { 'User-Agent': 'Mozilla/5.0' } };
async function load(sym, interval, range) {
  const r = (await (await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}&includePrePost=true`, UA)).json()).chart.result[0];
  const q = r.indicators.quote[0];
  return r.timestamp.map((t, i) => ({ t, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] })).filter(x => [x.o, x.h, x.l, x.c].every(v => v != null));
}
const etM = t => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t * 1000)).map(x => [x.type, x.value])); return +p.hour * 60 + +p.minute; };

// timeframe → data source, look-ahead window, evaluation step
const TFS = [
  { tf: '1m', interval: '1m', range: '7d', ahead: 30, step: 3 },
  { tf: '5m', interval: '5m', range: '60d', ahead: 24, step: 2 },
  { tf: '15m', interval: '15m', range: '60d', ahead: 16, step: 1 },
  { tf: '30m', interval: '30m', range: '60d', ahead: 12, step: 1 },
  { tf: '1h', interval: '60m', range: '730d', ahead: 12, step: 1 },
  { tf: '4h', interval: '60m', range: '730d', ahead: 6, step: 1, agg4h: true },
];
const WIN = 300; // candles per window, same as the live scan

function atrAt(bars, i) { let s = 0, n = 0; for (let k = Math.max(1, i - 13); k <= i; k++) { s += Math.max(bars[k].h, bars[k - 1].c) - Math.min(bars[k].l, bars[k - 1].c); n++; } return s / n; }
// +1 ATR before −1 ATR in the signal's direction? (a candle touching both counts as a loss)
function outcome(bars, i, dir, ahead) {
  const a = atrAt(bars, i), e = bars[i].c, up = e + a, dn = e - a;
  for (let k = i + 1; k <= Math.min(bars.length - 1, i + ahead); k++) {
    const hitUp = bars[k].h >= up, hitDn = bars[k].l <= dn;
    if (hitUp && hitDn) return { win: false, move: 0 };
    if (hitUp) return { win: dir === 'bull', move: dir === 'bull' ? 1 : -1 };
    if (hitDn) return { win: dir === 'bear', move: dir === 'bear' ? 1 : -1 };
  }
  const end = bars[Math.min(bars.length - 1, i + ahead)].c;
  return { win: false, move: (dir === 'bull' ? end - e : e - end) / a, open: true };
}
const wilson = (k, n, z = 1.645) => { if (!n) return [0, 0]; const p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d; return [Math.max(0, c - h), Math.min(1, c + h)]; };

const out = { generated: new Date().toISOString(), method: 'Checklist scored at each candle on the last 300 candles. Signal = ≥5 of 6 checks in one direction (≥75%). Only the first candle of each run of signals counts. Win = price moves +1 ATR(14) in the signal direction before −1 ATR, within the look-ahead window.', tfs: {} };
for (const T of TFS) {
  const [esRaw, nqRaw] = await Promise.all([load('ES=F', T.interval, T.range), load('NQ=F', T.interval, T.range)]);
  let es = esRaw, nq = nqRaw;
  if (T.agg4h) { es = core.to4h(es); nq = core.to4h(nq); }
  // align ES and NQ by timestamp (SMT needs both)
  const nqByT = new Map(nq.map(x => [x.t, x])), pairs = es.filter(x => nqByT.has(x.t)).map(x => [x, nqByT.get(x.t)]);
  const E = pairs.map(p => p[0]), N = pairs.map(p => p[1]);
  const res = {};
  for (const [sym, bars] of [['ES=F', E], ['NQ=F', N]]) {
    const acc = { all: { n: 0, w: 0, move: 0 }, ny: { n: 0, w: 0, move: 0 }, base: { n: 0, w: 0 }, four: { n: 0, w: 0 } };
    let prevSig = null, prevFour = null, evals = 0;
    for (let i = WIN; i < bars.length - T.ahead; i += T.step) {
      const win = bars.slice(i - WIN + 1, i + 1), dE = { bars: E.slice(i - WIN + 1, i + 1) }, dN = { bars: N.slice(i - WIN + 1, i + 1) };
      const d = { bars: win, gaps: core.scanFVGs(win) };
      const c = core.confChecks(d); c.smt = core.smtCheck(dE, dN);
      const has = (v, dir) => v === dir || v === 'both';
      const bull = core.CONF_ROWS.filter(r => has(c[r.key].v, 'bull')).length, bear = core.CONF_ROWS.filter(r => has(c[r.key].v, 'bear')).length;
      const sig = bull >= 5 && bull > bear ? 'bull' : bear >= 5 && bear > bull ? 'bear' : null;
      const four = bull >= 4 && bull > bear ? 'bull' : bear >= 4 && bear > bull ? 'bear' : null;
      // baseline: a long and a short from every evaluated candle
      for (const dir of ['bull', 'bear']) { const o = outcome(bars, i, dir, T.ahead); acc.base.n++; acc.base.w += o.win; }
      if (sig && sig !== prevSig) {
        const o = outcome(bars, i, sig, T.ahead); acc.all.n++; acc.all.w += o.win; acc.all.move += o.move;
        const m = etM(bars[i].t); if (m >= 570 && m < 720) { acc.ny.n++; acc.ny.w += o.win; acc.ny.move += o.move; }
      }
      if (four && four !== prevFour) { const o = outcome(bars, i, four, T.ahead); acc.four.n++; acc.four.w += o.win; }
      prevSig = sig; prevFour = four; evals++;
    }
    const pack = x => ({ n: x.n, winRate: x.n ? x.w / x.n : 0, ci: wilson(x.w, x.n), avgMoveATR: x.n ? +(x.move / x.n).toFixed(2) : 0 });
    res[sym] = { evals, from: new Date(bars[WIN].t * 1000).toISOString().slice(0, 10), to: new Date(bars[bars.length - 1].t * 1000).toISOString().slice(0, 10),
      ahead: T.ahead, signal5: pack(acc.all), signal5NY: pack(acc.ny), signal4: pack(acc.four), baseline: acc.base.n ? acc.base.w / acc.base.n : 0 };
    const s5 = res[sym].signal5;
    console.log(`${T.tf.padEnd(3)} ${sym} evals ${evals} · ≥5/6 signals ${s5.n}, win ${(s5.winRate * 100).toFixed(0)}% [${(s5.ci[0] * 100).toFixed(0)}–${(s5.ci[1] * 100).toFixed(0)}] vs baseline ${(res[sym].baseline * 100).toFixed(0)}% · NY ${res[sym].signal5NY.n} @ ${(res[sym].signal5NY.winRate * 100).toFixed(0)}% · ≥4/6 ${res[sym].signal4.n} @ ${(res[sym].signal4.winRate * 100).toFixed(0)}%`);
  }
  out.tfs[T.tf] = res;
}
writeFileSync(new URL('../confstats.json', import.meta.url), JSON.stringify(out));
console.log('wrote confstats.json');
