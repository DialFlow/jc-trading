// Morning Journal: real prices at the chosen times + Asian / London symbols, autosave, desktop + phone.
// /journal is answered by the real cloudflare/worker.js in-process (it fetches Yahoo); the rest goes to the network.
// Usage: node tests/serve.js . 8090   then   node tests/journaltest.js
const { chromium } = require('playwright');
const { pathToFileURL } = require('url'), path = require('path');
(async () => {
  const W = (await import(pathToFileURL(path.join(__dirname, '../cloudflare/worker.js')))).default;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
  const b = await chromium.launch({ channel: 'msedge' });
  for (const [name, vp] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    console.log('--- ' + name);
    const ctx = await b.newContext({ viewport: vp }), errs = [];
    await ctx.route(/workers\.dev\/journal/, async route => { const res = await W.fetch(new Request(route.request().url()), {}, { waitUntil() {} });
      route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() }); });
    const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
    await p.goto('http://localhost:8090/'); await p.waitForTimeout(3000);
    await p.click('.tab-btn:has-text("Journal")'); await p.waitForTimeout(300);
    await p.fill('#journal-date', '2026-10-08'); await p.dispatchEvent('#journal-date', 'change'); await p.waitForTimeout(300);
    const times = await p.evaluate(() => [document.getElementById('journal-t1').selectedOptions[0].text, document.getElementById('journal-t2').selectedOptions[0].text]);
    ok(times[0] === '8:25 AM' && times[1] === '9:45 AM', 'new day defaults to 8:25 and 9:45: ' + times);
    await p.click('button:has-text("Fill from market data")'); await p.waitForTimeout(25000);
    const status = await p.evaluate(() => document.getElementById('jfetch-status').textContent);
    ok(/Filled \d+ symbols/.test(status), 'fill status: ' + status);
    const es = await p.evaluate(() => { const tr = document.querySelector('#journal-tbody tr[data-sym="ES1!"]'), v = f => tr.querySelector(`[data-field="${f}"]`).value;
      return { close: v('close'), p1: v('am7'), p2: v('am915'), d1: document.getElementById('d1-ES1_').textContent, asia: v('asia'), ldn: v('ldn'), asiaIcon: tr.querySelector('.sess-btn[data-field="asia"]').textContent, hl: tr.querySelector('.sess-hl')?.textContent }; });
    console.log('   ES1! row:', JSON.stringify(es));
    ok(es.close === '7851.25' && es.p1 === '7821.25' && es.p2 === '7825.25', 'ES prior close / 8:25 / 9:45 are the real prices, not the current one');
    ok(/-30\.00/.test(es.d1), 'ES change close → 8:25 = −30.00');
    ok(es.asia === 'down' && es.asiaIcon === '▼', 'ES Asia: London took the Asian low (▼)');
    const spy = await p.evaluate(() => { const tr = document.querySelector('#journal-tbody tr[data-sym="SPY"]'); return { asia: tr.querySelector('[data-field="asia"]').value, ldn: tr.querySelector('[data-field="ldn"]').value }; });
    ok(spy.asia === '' && spy.ldn !== '', 'SPY: no Asian session, pre-market range filled');
    // tap to change a symbol, autosave, survives reload
    await p.click('#journal-tbody tr[data-sym="NQ1!"] .sess-btn[data-field="ldn"]'); await p.waitForTimeout(1200);
    const nqL = await p.evaluate(() => document.querySelector('#journal-tbody tr[data-sym="NQ1!"] [data-field="ldn"]').value);
    await p.reload(); await p.waitForTimeout(2500); await p.click('.tab-btn:has-text("Journal")');
    await p.fill('#journal-date', '2026-10-08'); await p.dispatchEvent('#journal-date', 'change'); await p.waitForTimeout(300);
    const after = await p.evaluate(() => ({ close: document.querySelector('#journal-tbody tr[data-sym="ES1!"] [data-field="close"]').value, nqL: document.querySelector('#journal-tbody tr[data-sym="NQ1!"] [data-field="ldn"]').value, t1: document.getElementById('journal-t1').value }));
    ok(after.close === '7851.25' && after.nqL === nqL && after.t1 === '505', 'everything kept after a reload (autosave), incl. the tapped symbol and times');
    await p.screenshot({ path: path.join(__dirname, `journal-${name}.png`) });
    ok(!(await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), 'no sideways page scroll');
    ok(errs.length === 0, 'JS errors: ' + errs.length + ' ' + errs.join(' | '));
    await ctx.close();
  }
  await b.close();
})();
