// Trade tab step notifications: time-travel Oct 8 from 9:42 to 10:02 ET and check each new rules event is announced once.
// Usage: node tests/serve.js . 8090   then   DATA_DIR=<dir with bars.json> node tests/notifytest.js
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path'), D = process.env.DATA_DIR;
const cutBars = cut => { const raw = JSON.parse(fs.readFileSync(path.join(D, 'bars.json'), 'utf8')), sec = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '1d': 0 };
  for (const s of Object.values(raw.bars)) for (const [tf, rows] of Object.entries(s)) s[tf] = rows.filter(r => r[0] + (sec[tf] ?? 300) <= cut + 60); raw.updated = cut; return JSON.stringify(raw); };
(async () => {
  const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
  const b = await chromium.launch({ channel: 'msedge' });
  for (const [name, vp] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const ctx = await b.newContext({ viewport: vp }); await ctx.grantPermissions(['notifications'], { origin: 'http://localhost:8090' });
    const p = await ctx.newPage(), errs = []; p.on('pageerror', e => errs.push(e.message));
    let cut = Date.parse('2026-10-08T13:42:00Z') / 1000;
    await p.route(/\/bars(\?|$)|data\/bars\.json/, r => r.fulfill({ body: cutBars(cut), headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' } }));
    await p.addInitScript(() => { localStorage.setItem('jct_alerts', '1'); window.__notes = []; const N = window.Notification; window.Notification = function (t, o) { window.__notes.push(t + ' | ' + (o && o.body)); return {}; }; window.Notification.permission = 'granted'; window.Notification.requestPermission = async () => 'granted'; });
    await p.clock.setFixedTime(new Date(cut * 1000));
    await p.goto('http://localhost:8090/'); await p.waitForTimeout(6000);
    await p.evaluate(() => { lvSymAuto = false; });
    ok(/Step alerts on/.test(await p.evaluate(() => document.getElementById('hm-bell').innerText)), 'bell shows step alerts on');
    ok((await p.evaluate(() => window.__notes.length)) === 0, 'nothing announced for steps already on screen when the page opened');
    cut = Date.parse('2026-10-08T14:02:00Z') / 1000; await p.clock.setFixedTime(new Date(cut * 1000));
    await p.evaluate(() => lvRefresh(true)); await p.waitForTimeout(4000);
    const notes = await p.evaluate(() => window.__notes);
    console.log('   ' + notes.join('\n   '));
    ok(notes.some(n => /ORDER PLACED/.test(n)) && notes.some(n => /▶ IN: filled/.test(n)), 'order placed and filled announced (ES and/or NQ)');
    await p.evaluate(() => lvRefresh(true)); await p.waitForTimeout(3000);
    ok((await p.evaluate(() => window.__notes.length)) === notes.length, 'no repeats on the next refresh');
    await p.click('#hm-bell button'); await p.waitForTimeout(300);
    ok(/Step alerts off/.test(await p.evaluate(() => document.getElementById('hm-bell').innerText)), 'bell turns step alerts off');
    ok(!(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth)), 'no sideways scroll');
    ok(errs.length === 0, `${name} JS errors: ${errs.length} ${errs.join(' | ')}`);
    await ctx.close();
  }
  await b.close();
})();
