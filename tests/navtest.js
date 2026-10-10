// 5-tab navigation: Trade · Market · Lab · Journal (Prep · Watchlist · Bias · Trades) · Playbook; Edge parts moved into Market + Playbook.
// Usage: node tests/serve.js . 8090   then   node tests/navtest.js
const { chromium } = require('playwright'), path = require('path');
(async () => {
  const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
  const b = await chromium.launch({ channel: 'msedge' });
  for (const [name, vp] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const p = await b.newPage({ viewport: vp }), errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto('http://localhost:8090/'); await p.waitForTimeout(5000);
    const tabs = await p.evaluate(() => [...document.querySelectorAll('.tab-btn')].map(b => b.innerText.trim()));
    ok(tabs.join(' | ') === '🎯 Trade | 📊 Market | 🧪 Lab | 📓 Journal | 📘 Playbook', `${name}: 5 tabs: ${tabs.join(' | ')}`);
    const fits = await p.evaluate(() => { const bar = document.getElementById('tab-bar'); return bar.scrollWidth <= bar.clientWidth + 2; });
    ok(fits, 'all 5 tabs fit without scrolling the tab bar');
    // Journal + its switch
    await p.click('.tab-btn:has-text("Journal")'); await p.waitForTimeout(800);
    const active = () => p.evaluate(() => [document.querySelector('.tab-page.active').id, document.querySelector('.tab-btn.active').innerText.trim()].join(' / '));
    ok((await active()) === 'page-journal / 📓 Journal', 'Journal opens on Prep: ' + await active());
    for (const [label, page] of [['Watchlist', 'page-watch'], ['Bias', 'page-bias'], ['Trades', 'page-tradelog'], ['Prep', 'page-journal']]) {
      await p.click(`.tab-page.active .subnav-b:has-text("${label}")`); await p.waitForTimeout(400);
      ok((await active()) === `${page} / 📓 Journal`, `switch → ${label}: ${await active()}`);
    }
    await p.click('.tab-page.active .subnav-b:has-text("Bias")'); await p.click('.tab-btn:has-text("Trade")'); await p.waitForTimeout(300);
    await p.click('.tab-btn:has-text("Journal")'); await p.waitForTimeout(400);
    ok((await active()).startsWith('page-bias'), 'Journal remembers the last switch (Bias)');
    // Edge moved
    await p.click('.tab-btn:has-text("Market")'); await p.waitForTimeout(2500);
    ok(await p.evaluate(() => document.getElementById('page-dashboard').contains(document.getElementById('edge-vix')) && /\d/.test(document.getElementById('edge-vix').innerText)), 'Market shows the live VIX + market read');
    ok(await p.evaluate(() => /Edge Conditions/i.test(document.getElementById('page-strategy').innerText)), 'Playbook has the edge conditions and notes');
    await p.evaluate(() => showPage('edge')); ok((await active()).startsWith('page-dashboard / 📊 Market'), 'old Edge links open Market');
    await p.screenshot({ path: path.join(__dirname, `nav-${name}.png`) });
    ok(!(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth)), 'no sideways page scroll');
    ok(errs.length === 0, `${name} JS errors: ${errs.length} ${errs.join(' | ')}`);
    await p.close();
  }
  await b.close();
})();
