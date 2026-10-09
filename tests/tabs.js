// Usage: node tabs.js <path-to-index.html>
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const file = 'file:///' + path.resolve(process.argv[2]).replace(/\\/g, '/');
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage();
  if (process.env.PRICES_FILE) await page.route('**/prices.json*', r => r.fulfill({ path: process.env.PRICES_FILE, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' } }));
  const jsErrors = [], consoleErrors = [];
  page.on('pageerror', e => jsErrors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  await page.goto(file, { waitUntil: 'load' });
  await page.waitForTimeout(1500);

  const btns = page.locator('.tab-btn');
  const n = await btns.count();
  const results = [];
  for (let i = 0; i < n; i++) {
    const b = btns.nth(i);
    const label = (await b.innerText()).trim().replace(/\s+/g, ' ');
    await b.click();
    await page.waitForTimeout(400);
    const active = await page.evaluate(() => document.querySelector('.tab-page.active')?.id || null);
    results.push(`${i + 1}. ${label} -> ${active}`);
  }
  console.log(`Tabs found: ${n}`);
  results.forEach(r => console.log('  ' + r));

  // Optional extra checks injected by caller
  if (process.env.EXTRA) console.log(await page.evaluate(process.env.EXTRA));

  console.log(`JS errors (pageerror): ${jsErrors.length}`);
  jsErrors.forEach(e => console.log('  ' + e));
  // Network/CSP noise from file:// (blocked embeds, proxy fetches) shows up here, not as JS errors
  console.log(`Console errors (incl. network): ${consoleErrors.length}`);
  consoleErrors.slice(0, 10).forEach(e => console.log('  ' + e.slice(0, 160)));
  await browser.close();
  process.exit(jsErrors.length ? 1 : 0);
})();
