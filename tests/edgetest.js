// Edge tab: live VIX card + market read. Usage: node tests/serve.js . 8090, then node tests/edgetest.js
const { chromium } = require('playwright');
(async () => { const b = await chromium.launch({ channel: 'msedge' });
  for (const [n, vp] of [['desktop', { width: 1280, height: 1000 }], ['phone', { width: 390, height: 1400 }]]) {
    const p = await b.newPage({ viewport: vp, colorScheme: 'dark' }); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto('http://localhost:8090/'); await p.waitForTimeout(5000); await p.click('.tab-btn:has-text("Edge")'); await p.waitForTimeout(5000);
    const g = s => p.evaluate(s => (document.querySelector(s)?.innerText || '').replace(/\s+/g, ' '), s);
    if (n === 'desktop') { console.log('VIX:', (await g('#edge-vix')).slice(0, 260)); console.log('READ:', (await g('#edge-read')).slice(0, 1200)); }
    await p.screenshot({ path: require('path').join(__dirname, `edge-${n}.png`) });
    console.log(n, 'hscroll:', await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), 'JS errors:', errs.length, errs.join(' | '));
  } await b.close(); })();
