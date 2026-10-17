// TJR 1-minute model, FROZEN v1 (pre-registered in docs/PREREG-tjr1m-v1.md). Do not edit: any change is a new version
// with a new pre-registration and must be judged only on days after its own freeze date.
// Study only: nothing on the site uses this file.
//
// Rules (one reading of TJR's own checklist, chosen Oct 11 2026 on Sep 15–Oct 9 data because it reproduced his logged trades):
//  Levels   Asian (18:00–03:00) and London (03:00–08:30) high/low, prior trading day high/low, plus "morning" 5m swing
//           highs/lows from 07:00 (2 candles left, 1 right), the morning ones counting as liquidity from 09:30.
//  Sweep    price trades through a level, then a 5m candle closes back inside: within 2 candles (morning levels) or
//           12 candles (session levels). Session-level sweeps count from 08:30. Sell-side sweep arms a long, buy-side a short.
//  Break    5m close beyond the most recent 5m swing (2 candles each side) in the trade direction. Long and short setups
//           are tracked separately; the side whose break came last is the one in play.
//  Pullback impulse extreme measured from the sweep; then the pullback against it (its extreme updates while it deepens).
//  Entry    09:50–11:00: a 1m close beyond the 1m candles since the pullback extreme → market order, filled at the NEXT
//           1m open + 1 tick slippage. Stop = pullback extreme ± 1 pt (ES) / 4 pts (NQ). Stop size (from the signal close)
//           must be 2–25 pts ES, 8–100 pts NQ, else skipped. One trade per contract per day.
//  Exits    funded plan with 3 micros: 2 of 3 off at 1R and stop to break-even, last 1 off at 2R; take-profits fill only
//           when a 1m candle trades 1 tick through; a candle touching the stop and a target counts the stop first;
//           stops fill 1 tick worse; anything open is closed at the 12:00 open. R uses the actual fill.
//  Costs    MFF round trip $1.90 per micro (help.myfundedfutures.com, Oct 2026). Point value: MES $5, MNQ $2.
export const VERSION = 'tjr1m-v1';
export const INSTR = { ES: { tick: 0.25, pv: 50, buf: 1.0, minRisk: 2, maxRisk: 25 }, NQ: { tick: 0.25, pv: 20, buf: 4.0, minRisk: 8, maxRisk: 100 } };
const V = { watch0: 510, htfBack: 12, entry0: 590, entryEnd: 660, end: 665 };
export const MICROS = 3, MICRO_RT = 1.90;

const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function toBars(rows) {
  const out = [];
  for (const [t, o, h, l, c] of [...rows].sort((a, b) => a[0] - b[0])) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t * 1000)).map(x => [x.type, x.value]));
    const date = `${p.year}-${p.month}-${p.day}`, m = +p.hour * 60 + +p.minute;
    const td = m >= 1080 ? new Date(Date.parse(date + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10) : date;
    out.push({ t, o, h, l, c, date, m, td, hm: `${p.hour}:${p.minute}` });
  }
  return out;
}
export const byDay = bars => { const d = new Map(); for (const b of bars) { if (!d.has(b.td)) d.set(b.td, []); d.get(b.td).push(b); } return d; };
function to5m(b1) {
  const out = []; let cur = null;
  b1.forEach((b, i) => {
    const k = Math.floor(b.m / 5) * 5;
    if (!cur || cur.k !== k || cur.date !== b.date) { cur = { k, date: b.date, m: k, t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, i0: i, i1: i }; out.push(cur); }
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.i1 = i; }
  });
  return out;
}
const hmOf = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
// the 1m bars a trade is managed on: 07:00–16:00 of the trading day
export const sessionBars = dayBars => dayBars.filter(b => b.m >= 420 && b.m < 960);

// Signal for one trading day: { trade: {dir, i, signalClose, stop, ...} | null, ev: [...] }
export function signal(sym, dayBars, prevDayBars) {
  const I = INSTR[sym], ev = [], note = (b, type, text) => ev.push({ hm: b.hm, type, text });
  const b1 = sessionBars(dayBars), b5 = to5m(b1);
  const L = [], rng = (bs, n) => { if (!bs.length) return; L.push({ n: n + ' high', p: Math.max(...bs.map(b => b.h)), side: 'BSL', htf: true }); L.push({ n: n + ' low', p: Math.min(...bs.map(b => b.l)), side: 'SSL', htf: true }); };
  rng(dayBars.filter(b => b.m >= 1080 || b.m < 180), 'Asian');
  rng(dayBars.filter(b => b.m >= 180 && b.m < 510), 'London');
  if (prevDayBars && prevDayBars.length) rng(prevDayBars, 'Prior-day');
  const taken = new Set(), cands = [], S = { long: null, short: null };
  let active = null, trade = null;
  const swing5 = (j, side) => { for (let k = j - 3; k >= 2; k--) { const x = b5[k];
    if (side === 'long' && x.h > b5[k - 1].h && x.h > b5[k - 2].h && x.h >= b5[k + 1].h && x.h >= b5[k + 2].h) return x.h;
    if (side === 'short' && x.l < b5[k - 1].l && x.l < b5[k - 2].l && x.l <= b5[k + 1].l && x.l <= b5[k + 2].l) return x.l; } return null; };
  for (let j = 0; j < b5.length && !trade; j++) {
    const c5 = b5[j]; if (c5.m >= V.end) break;
    if (j >= 3) { const k = j - 1, x = b5[k];
      if (x.h > b5[k - 1].h && x.h > b5[k - 2].h && x.h >= c5.h) L.push({ n: `${hmOf(x.m)} high`, p: x.h, side: 'BSL' });
      if (x.l < b5[k - 1].l && x.l < b5[k - 2].l && x.l <= c5.l) L.push({ n: `${hmOf(x.m)} low`, p: x.l, side: 'SSL' }); }
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
      if (back) {
        const ext = side === 'long' ? Math.min(...b5.slice(cd.j, j + 1).map(x => x.l)) : Math.max(...b5.slice(cd.j, j + 1).map(x => x.h));
        S[side] = { lv: cd.lv, m: c5.m, x: ext, bos: null };
        note(b1[cd.idx], 'sweep', `${cd.lv.n} ${cd.lv.p} swept: ${side} setup armed`);
      } else if (j - cd.j < (cd.lv.htf ? V.htfBack : 2)) keep.push(cd);
    }
    cands.push(...keep);
    for (const side of ['long', 'short']) {
      const st = S[side]; if (!st || st.bos) continue;
      const ref = swing5(j, side);
      if (ref != null && (side === 'long' ? c5.c > ref : c5.c < ref)) { st.bos = { at: b1[c5.i1].t }; note(b1[c5.i1], 'bos', `5m break ${side === 'long' ? 'up' : 'down'}: close ${c5.c} beyond ${ref}`); }
      if (st.bos && (!active || !S[active] || !S[active].bos || st.bos.at >= S[active].bos.at)) active = side;
    }
    if (!active || !S[active] || !S[active].bos) continue;
    const dir = active, st = S[dir];
    for (let i = c5.i0; i <= c5.i1 && !trade; i++) {
      const b = b1[i]; if (b.m >= V.entryEnd) break; if (b.t <= st.bos.at) continue;
      const P = st.pb || (st.pb = (() => { const since = b1.filter(x => x.m >= st.m && x.t <= st.bos.at);
        return { imp: dir === 'long' ? Math.max(...since.map(x => x.h)) : Math.min(...since.map(x => x.l)), ext: null, extI: null }; })());
      if (dir === 'long' ? b.h > P.imp : b.l < P.imp) { P.imp = dir === 'long' ? b.h : b.l; P.ext = null; continue; }
      if (P.ext == null || (dir === 'long' ? b.l < P.ext : b.h > P.ext)) { P.ext = dir === 'long' ? b.l : b.h; P.extI = i; continue; }
      if (b.m < V.entry0) continue;
      const prev = b1.slice(P.extI + 1, i); if (!prev.length) continue;
      const ref = dir === 'long' ? Math.max(...prev.map(x => x.h)) : Math.min(...prev.map(x => x.l));
      if (dir === 'long' ? b.c > ref : b.c < ref) {
        const stop = dir === 'long' ? P.ext - I.buf : P.ext + I.buf, risk = Math.abs(b.c - stop);
        if (risk >= I.minRisk && risk <= I.maxRisk && i + 1 < b1.length && b1[i + 1].m < 720) {
          trade = { dir, i, signalHm: b.hm, signalClose: b.c, stop, sweep: st.lv.n };
          note(b, 'signal', `1m break after the pullback: ${dir}, stop ${stop}`); break;
        }
        note(b, 'skip', `risk ${risk.toFixed(2)} pts outside ${I.minRisk}–${I.maxRisk}`);
      }
    }
  }
  return { trade, ev };
}

// Funded-plan exit from a market entry at the open of 1m bar k (+1 tick slippage). Used for the model AND the baselines.
// Returns { entry, stop, risk, r, usd (3 micros, after costs), maeUsd (worst open loss, 3 micros), why, exitHm } or null.
export function manage(sym, b1, k, dir, stopPrice) {
  const I = INSTR[sym], lng = dir === 'long', tk = I.tick;
  if (k >= b1.length || b1[k].m >= 720) return null;
  const entry = lng ? b1[k].o + tk : b1[k].o - tk, risk = lng ? entry - stopPrice : stopPrice - entry;
  if (!(risk > 0)) return null;
  const at = n => lng ? entry + n * risk : entry - n * risk;
  let stop = stopPrice, f1 = false, pts = 0, why = '12:00 flat', exitHm = null, mae = 0;
  for (let i = k; i < b1.length; i++) {
    const b = b1[i];
    if (b.m >= 720) { pts += (f1 ? 1 / 3 : 1) * (lng ? b.o - entry : entry - b.o); exitHm = b.hm; break; }
    mae = Math.max(mae, (f1 ? 1 / 3 : 1) * (lng ? entry - b.l : b.h - entry));
    if (lng ? b.l <= stop : b.h >= stop) { const px = lng ? stop - tk : stop + tk; pts += (f1 ? 1 / 3 : 1) * (lng ? px - entry : entry - px); why = f1 ? 'break-even' : 'stop'; exitHm = b.hm; break; }
    if (!f1 && (lng ? b.h >= at(1) + tk : b.l <= at(1) - tk)) { f1 = true; pts += (2 / 3) * risk; stop = entry; }
    if (f1 && (lng ? b.h >= at(2) + tk : b.l <= at(2) - tk)) { pts += (1 / 3) * 2 * risk; why = '2R'; exitHm = b.hm; break; }
    if (i === b1.length - 1) { pts += (f1 ? 1 / 3 : 1) * (lng ? b.c - entry : entry - b.c); exitHm = b.hm; }
  }
  const pvMicro = I.pv * 0.1;
  return { entry, stop: stopPrice, risk, r: pts / risk, usd: MICROS * (pts * pvMicro - MICRO_RT), maeUsd: MICROS * Math.max(0, mae) * pvMicro, why, exitHm };
}

// Run the frozen model on one day: signal, then a market entry at the next 1m open.
export function runDay(sym, dayBars, prevDayBars) {
  const { trade, ev } = signal(sym, dayBars, prevDayBars);
  if (!trade) return { ev, trade: null };
  const b1 = sessionBars(dayBars), res = manage(sym, b1, trade.i + 1, trade.dir, trade.stop);
  if (!res) return { ev, trade: null };
  return { ev, trade: { ...trade, ...res, entryHm: b1[trade.i + 1].hm } };
}
