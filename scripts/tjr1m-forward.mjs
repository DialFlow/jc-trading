// Forward paper-trading log for the frozen TJR 1m model v1.1 (official out-of-sample rows from Oct 19, docs/PREREG-tjr1m-v1.1.md): runs it on every archived day from Oct 12, 2026 (the first
// day after the rules were chosen) and rewrites <out.csv>. Runs in the daily archive workflow, so each day's row is
// timestamped by that day's commit on the `archive` branch. The rules file is frozen, so re-running only adds new days.
// Usage: node scripts/tjr1m-forward.mjs <archive dir with 1m/ES, 1m/NQ> <out.csv>
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { VERSION, toBars, byDay, runDay } from './tjr1m-model-v1.1.mjs';

const [SRC, OUT] = process.argv.slice(2), FIRST = '2026-10-12';
const rows = [];
for (const s of ['ES', 'NQ']) {
  const dir = join(SRC, '1m', s); if (!existsSync(dir)) continue;
  const all = []; for (const f of readdirSync(dir)) all.push(...JSON.parse(readFileSync(join(dir, f), 'utf8')));
  const d = byDay(toBars(all)), tds = [...d.keys()].sort();
  tds.forEach((td, k) => {
    if (td < FIRST || !k) return;
    const bars = d.get(td); if (bars.filter(b => b.m >= 420 && b.m < 720).length < 280) return; // day not complete yet
    const { trade } = runDay(s, bars, d.get(tds[k - 1]));
    rows.push(trade ? [td, s, trade.signalHm, trade.dir, trade.entryHm, trade.entry, trade.stop, trade.risk.toFixed(2), trade.why, trade.exitHm, trade.r.toFixed(3), trade.usd.toFixed(2), `"${trade.sweep}"`]
      : [td, s, '', 'no trade', '', '', '', '', '', '', '0', '0', '""']);
  });
}
rows.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `# ${VERSION} forward paper log (frozen rules, docs/PREREG-tjr1m-v1.1.md). One row per contract per day; r_net = R after slippage and MFF costs. Official out-of-sample rows start 2026-10-19.\n`
  + 'date,contract,signal_et,direction,fill_et,fill,stop,risk_pts,exit,exit_et,r_net,usd_3_micros,sweep\n' + rows.map(r => r.join(',')).join('\n') + '\n');
const t = rows.filter(r => r[3] !== 'no trade'), sum = s => t.filter(r => r[1] === s).reduce((a, r) => a + +r[10], 0);
console.log(`${VERSION} forward: ${rows.length / 2} days, ${t.length} trades · NQ ${sum('NQ').toFixed(2)}R · ES ${sum('ES').toFixed(2)}R`);
