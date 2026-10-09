// Live tab: scoreboard, timeframes, play-by-play, confluences and forecast, on desktop and phone.
// Run 1 uses today's candles; run 2 time-travels to Oct 8 10:12 ET (candles cut there, clock faked) so the forecast can run.
// Usage: DATA_DIR=<dir with bars.json etc. from scripts/fetch-prices.mjs> node tests/livetest.js
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path'), D = process.env.DATA_DIR;
const CUT = Date.parse(process.env.CUT || '2026-10-08T14:12:00Z') / 1000;
function cutBars() {
  const raw = JSON.parse(fs.readFileSync(path.join(D, 'bars.json'), 'utf8'));
  const sec = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '1d': 86400 };
  for (const s of Object.values(raw.bars)) for (const [tf, rows] of Object.entries(s)) s[tf] = rows.filter(r => r[0] + (tf === '1d' ? 0 : sec[tf] || 300) <= CUT + 60);
  raw.updated = CUT; return JSON.stringify(raw);
}
(async () => {
  const b = await chromium.launch({ channel: 'msedge' });
  for (const travel of [false, true]) for (const [name, vp] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const p = await b.newPage({ viewport: vp, colorScheme: 'dark' }); const errs = [], bad = [];
    p.on('pageerror', e => errs.push(e.message)); p.on('response', r => { if (r.status() >= 400) bad.push(r.status() + ' ' + r.url().slice(0, 80)); });
    await p.route('**/data/*.json*', r => { const f = r.request().url().match(/data\/(\w+)\.json/)[1]; r.fulfill({ path: path.join(D, f + '.json'), headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' } }); });
    if (travel) {
      const body = cutBars();
      await p.route(/\/bars(\?|$)|data\/bars\.json/, r => r.fulfill({ body, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' } }));
      await p.clock.setFixedTime(new Date(CUT * 1000));
    }
    await p.goto('http://localhost:8090/'); await p.waitForTimeout(5000);
    await p.click('.tab-btn:has-text("Live")'); await p.waitForTimeout(2500);
    const g = sel => p.evaluate(s => (document.querySelector(s)?.innerText || '').replace(/\s+/g, ' ').trim(), sel);
    const tag = `${travel ? 'TRAVEL' : 'NOW'} ${name}`;
    const tabIdx = await p.evaluate(() => [...document.querySelectorAll('.tab-btn')].findIndex(b => b.classList.contains('active')));
    if (name === 'desktop') {
      console.log(`${tag} active tab #${tabIdx + 1}`);
      console.log(`${tag} BOARD:`, (await g('#lv-board')).slice(0, 600));
      console.log(`${tag} TICKER:`, await g('#lv-ticker'));
      console.log(`${tag} BANNER:`, await g('#lv-banner'));
      console.log(`${tag} PBP notes:`, await p.evaluate(() => document.querySelectorAll('#lv-pbp .rpn').length), '| first:', (await g('#lv-pbp .rpn')).slice(0, 300));
      console.log(`${tag} CONF:`, (await g('#lv-conf')).slice(0, 300));
    }
    const tfs = [];
    for (const tf of ['15m', '1h', '4h', '1d', '5m']) {
      await p.evaluate(t => lvSetTf(t), tf); await p.waitForTimeout(250);
      tfs.push(`${tf}: svg ${await p.evaluate(() => !!document.querySelector('#lv-chart svg'))} notes ${await p.evaluate(() => document.querySelectorAll('#lv-pbp .rpn').length)}`);
    }
    if (name === 'desktop') console.log(`${tag} TFS:`, tfs.join(' · '));
    await p.click('#lv-fc-btn'); await p.waitForTimeout(3000);
    if (name === 'desktop') console.log(`${tag} FORECAST:`, (await g('#lv-fc')).slice(0, 900), '| band on chart:', await p.evaluate(() => !!document.querySelector('#lv-chart polygon')));
    await p.evaluate(() => lvSetSym('ES=F')); await p.waitForTimeout(400);
    if (name === 'desktop') console.log(`${tag} ES banner:`, await g('#lv-banner'));
    await p.evaluate(() => lvSetSym('NQ=F')); await p.waitForTimeout(400);
    await p.screenshot({ path: path.join(__dirname, `live-${travel ? 'travel' : 'now'}-${name}.png`), fullPage: true });
    const hs = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    console.log(`${tag} hscroll: ${hs} http errors: ${bad.length} ${bad.join(',')} JS errors: ${errs.length} ${errs.join(' | ')}`);
    await p.close();
  }
  await b.close();
})();
