// Home past-day picker + recap (market, rules' trade, you, bias, play-by-play) and the bias snapshot. Usage: node tests/serve.js . 8090, then node tests/daytest.js
const { chromium } = require('playwright');
(async () => { const b = await chromium.launch({ channel: 'msedge' }); let fail = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail++; };
  for (const [n, vp] of [['desktop', { width: 1280, height: 1000 }], ['phone', { width: 390, height: 900 }]]) {
    const p = await b.newPage({ viewport: vp, colorScheme: 'dark' }); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto('http://localhost:8090/'); await p.waitForTimeout(12000);
    const opts = await p.evaluate(() => [...document.querySelectorAll('#hm-day option')].map(o => o.value + ' | ' + o.textContent));
    ok(opts.length > 30, `${n}: picker has ${opts.length} entries · e.g. ${opts.slice(1, 4).join(' ; ')}`);
    for (const td of ['2026-10-08', '2026-09-14']) {
      await p.selectOption('#hm-day', td); await p.waitForTimeout(1200);
      const txt = await p.evaluate(() => document.getElementById('hm-day-card').innerText.replace(/\s+/g, ' '));
      ok(/DAY RECAP/.test(txt) && /MARKET/.test(txt) && /TRADE PLAN AND RESULT/.test(txt) && /YOU/.test(txt), `${td} recap: ` + txt.slice(0, 520));
      await p.click('#hm-day-card .mtf-seg:has-text("NQ1! chart")'); await p.waitForTimeout(400); ok(await p.evaluate(() => !!document.querySelector('#hm-day-chart svg') && document.querySelectorAll('#hm-day-pbp .rpn').length > 20), `${td}: chart + ${await p.evaluate(() => document.querySelectorAll('#hm-day-pbp .rpn').length)} play-by-play notes`);
    }
    // bias snapshot is saved into the day's journal
    await p.evaluate(() => { setBias('bull'); saveBias(); }); ok(await p.evaluate(() => trDay().bias?.state === 'bull'), 'bias saved into today\'s journal');
    await p.click('button:has-text("Back to today")'); await p.waitForTimeout(300); ok(await p.evaluate(() => document.getElementById('hm-day-card').hidden), 'back to today hides the recap');
    await p.screenshot({ path: require('path').join(__dirname, `day-${n}.png`) });
    ok(!(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth)), 'no sideways scroll'); ok(errs.length === 0, 'JS errors ' + errs.length + ' ' + errs.join(' | '));
  } await b.close(); process.exitCode = fail ? 1 : 0; })();
