// Every chart timeframe has readable time labels and a hover/tap crosshair with time + OHLC.
// Usage: node tests/serve.js . 8090   then   node tests/charttimetest.js
const { chromium } = require('playwright'), path = require('path');
(async () => {
  const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
  const b = await chromium.launch({ channel: 'msedge' });
  for (const [name, vp] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 900 }]]) {
    const p = await b.newPage({ viewport: vp, colorScheme: 'dark' }), errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto('http://localhost:8090/'); await p.waitForTimeout(7000);
    for (const tf of ['5m', '15m', '1h', '4h', '1d']) {
      await p.evaluate(t => lvSetTf(t), tf); await p.waitForTimeout(400);
      const labels = await p.evaluate(() => [...document.querySelectorAll('#lv-chart svg text')].map(t => t.textContent).filter(s => /^(\d{1,2}:\d{2}|\d{1,2}\/\d{1,2}|[A-Z][a-z]{2}( \d{1,2})?|last .*)$/.test(s)));
      const svg = await p.$('#lv-chart svg'); await svg.scrollIntoViewIfNeeded(); const bb = await svg.boundingBox();
      await p.mouse.move(bb.x + bb.width * 0.4, bb.y + bb.height * 0.5); await p.waitForTimeout(250);
      const tip = await p.evaluate(() => [...document.querySelectorAll('#lv-chart .xh text')].map(t => t.textContent).join(' / '));
      ok(labels.length >= 4 && /O \d/.test(tip), `${name} ${tf}: ${labels.length} time labels (${labels.slice(0, 8).join(', ')}) · hover: ${tip}`);
      if (name === 'desktop' && ['5m', '1h', '1d'].includes(tf)) await (await p.$('#lv-chart')).screenshot({ path: path.join(__dirname, `chart-time-${tf}.png`) });
    }
    // the day recap chart (5m) has them too
    await p.evaluate(() => { hmDay = '2026-10-08'; hmRenderDay(); }); await p.waitForTimeout(800);
    const rl = await p.evaluate(() => [...document.querySelectorAll('#hm-day-chart svg text')].map(t => t.textContent).filter(s => /^\d{1,2}:\d{2}$/.test(s)).length);
    ok(rl >= 6 && await p.evaluate(() => !!document.querySelector('#hm-day-chart .xh')), `${name} recap chart: ${rl} time labels + crosshair`);
    ok(!(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth)), name + ' no sideways scroll');
    ok(errs.length === 0, `${name} JS errors: ${errs.length} ${errs.join(' | ')}`);
    await p.close();
  }
  await b.close();
})();
