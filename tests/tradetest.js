// Trade home screen: phases, guardrails, mindset check-in, pre-flight + soft lock, open trade, close, review + streak.
// Usage: node tests/serve.js . 8090   then   DATA_DIR=<dir> node tests/tradetest.js
const { chromium } = require('playwright');
const path = require('path'), D = process.env.DATA_DIR;
(async () => {
  const b = await chromium.launch({ channel: 'msedge' });
  const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
  for (const [name, vp] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    console.log('--- ' + name);
    const p = await b.newPage({ viewport: vp }), errs = []; p.on('pageerror', e => errs.push(e.message));
    if (D) await p.route('**/data/*.json*', r => { const f = r.request().url().match(/data\/(\w+)\.json/)[1]; r.fulfill({ path: path.join(D, f + '.json'), headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' } }); });
    await p.goto('http://localhost:8090/'); await p.waitForTimeout(6000);
    const g = s => p.evaluate(s => (document.querySelector(s)?.innerText || '').replace(/\s+/g, ' ').trim(), s);
    const tabs = await p.evaluate(() => [...document.querySelectorAll('.tab-btn')].map(b => b.innerText.trim()));
    ok(tabs[0].includes('Trade') && tabs[1].includes('Market') && !tabs.some(t => t.includes('Charts')), 'tabs: ' + tabs.join(' | '));
    ok(await p.evaluate(() => document.getElementById('page-live').classList.contains('active')), 'opens on the Trade screen');
    ok(/Trades today 0 \/ 1/.test(await g('#tr-guard')), 'guardrails: ' + (await g('#tr-guard')).slice(0, 140));
    const meter = await g('#hm-meter'); ok(/\d+[mhd]\b/.test(meter) && /(Sweep|BOS)/.test(meter), 'home starts with the trade meter: ' + meter.slice(0, 120));
    const order = await p.evaluate(() => ['hm-meter', 'lv-chart', 'lv-plan', 'lv-ticker', 'lv-board', 'hm-bias', 'tr-guard'].map(id => document.getElementById(id).getBoundingClientRect().top));
    ok(order.every((v, i) => !i || v > order[i - 1]), 'order: meter → chart → trade card → last play → ES/NQ status → bias → your day');
    ok(/YOUR BIAS/.test(await g('#hm-bias')) && /(leans|mixed)/.test(await g('#hm-bias')), "today's bias card: " + (await g('#hm-bias')).slice(0, 120));
    // 1 · Prepare: mindset check-in
    await p.evaluate(() => showPage('journal')); await p.waitForTimeout(2500);
    ok(/GAME PLAN/.test(await g('#jr-prep')) && /MINDSET/.test(await g('#jr-prep')), 'Morning Journal shows the game plan and the check-in');
    await p.selectOption('#tr-sleep', '4'); await p.selectOption('#tr-focus', '5'); await p.selectOption('#tr-mood', 'calm'); await p.check('#tr-accept');
    await p.click('button:has-text("Save check-in")'); await p.waitForTimeout(400); await p.evaluate(() => showPage('live')); await p.waitForTimeout(800);
    ok(/Mindset 5\/5/.test(await g('#tr-guard')) && (await p.evaluate(() => trDay().mind.mood)) === 'calm', 'check-in saved to today\'s journal → mindset 5/5');
    // 2 · Trade: take a plan (a fixed test plan so this runs at any hour)
    await p.evaluate(() => { trLastA = { kind: 'order', grade: 'B', head: 'Rules say BUY LIMIT 100.00', checks: [], size: { n: 2, per: 50 }, plan: { dir: 'long', entry: 100, stop: 90, risk: 10, tp1: null, target: 120, est: false } }; trTake(); });
    await p.waitForTimeout(300);
    ok(!(await p.evaluate(() => document.getElementById('tr-modal').hidden)), 'pre-flight opens');
    await p.click('#tr-modal button:has-text("Log the trade")'); await p.waitForTimeout(200);
    ok(/Tick all three/.test(await g('#tr-msg')), 'can\'t log without the three checks');
    for (const id of ['#tr-c1', '#tr-c2', '#tr-c3']) await p.check(id);
    await p.click('#tr-modal button:has-text("Log the trade")'); await p.waitForTimeout(500);
    const open = await p.evaluate(() => trOpen());
    ok(open && open.status === 'open' && open.plan.grade === 'B' && open.setup === 'TJR rules', 'trade logged as open with its plan');
    ok(/YOUR OPEN TRADE/.test(await g('#tr-open-slot')) && /Trades today 1 \/ 1/.test(await g('#tr-guard')), 'open trade card + 1 / 1 trades');
    await p.evaluate(() => showPage('tradelog')); await p.waitForTimeout(300);
    ok(/open/.test(await g('#tl-tbody')), 'Trade Log shows it as open'); await p.click('.tab-btn:has-text("Trade")'); await p.waitForTimeout(500);
    // close it at a loss → cool-down
    await p.evaluate(() => showPage('live')); await p.waitForTimeout(600);
    await p.fill('#tr-exit', '95'); await p.click('button:has-text("I closed it")'); await p.waitForTimeout(500);
    const closed = await p.evaluate(() => trades[0]);
    ok(closed.status === 'closed' && closed.exit === 95 && closed.pnl < 0 && closed.rr === '-0.50', `closed: pnl ${closed.pnl}, ${closed.rr}R`);
    ok(/Cool-down 1[45] min/.test(await g('#tr-guard')), 'cool-down after a loss: ' + (await g('#tr-guard')).match(/Cool-down[^P🔥]*/)?.[0]);
    // second trade: soft lock (limit reached + cool-down), needs a reason
    await p.evaluate(() => { trLastA = { kind: 'order', grade: 'B', head: 'Rules say BUY LIMIT 100.00', checks: [], size: { n: 2, per: 50 }, plan: { dir: 'long', entry: 100, stop: 90, risk: 10, tp1: null, target: 120, est: false } }; trTake(); }); await p.waitForTimeout(300);
    ok(/Pause/.test(await g('#tr-modal')) && /1 of your 1 trade/.test(await g('#tr-modal')), 'soft lock shows why');
    for (const id of ['#tr-c1', '#tr-c2', '#tr-c3']) await p.check(id);
    await p.click('#tr-modal button:has-text("Log the trade")'); await p.waitForTimeout(200);
    ok(/reason/.test(await g('#tr-msg')), 'override needs a reason');
    await p.fill('#tr-why', 'A+ setup at my level, size cut to 1'); await p.click('#tr-modal button:has-text("Log the trade")'); await p.waitForTimeout(400);
    ok((await p.evaluate(() => trOpen()?.override?.why)) === 'A+ setup at my level, size cut to 1', 'override logged with the reason');
    await p.click('button:has-text("Didn\'t fill / remove")'); await p.waitForTimeout(300);
    // 3 · Review
    await p.evaluate(() => showPage('journal')); await p.waitForTimeout(2500);
    await p.click('#jr-review .mtf-seg:has-text("Yes")'); await p.waitForTimeout(300);
    await p.fill('#tr-rv-lesson', 'Waited for 9:50'); await p.dispatchEvent('#tr-rv-lesson', 'change'); await p.waitForTimeout(300);
    const rv = await p.evaluate(() => trDay().review); await p.evaluate(() => showPage('live')); await p.waitForTimeout(800);
    ok(rv.followed === 'yes' && rv.lesson === 'Waited for 9:50' && /Plan streak 1 day/.test(await g('#tr-guard')), 'review saved, plan streak 1');
    // the plan card has the buttons when the analyzer has a real plan (shown only if one exists right now)
    console.log('   plan card now:', (await g('#lv-plan')).slice(0, 120));
    await p.screenshot({ path: path.join(__dirname, `trade-${name}.png`), fullPage: false });
    ok(!(await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), 'no sideways scroll');
    ok(errs.length === 0, 'JS errors: ' + errs.length + ' ' + errs.join(' | '));
    await p.close();
  }
  await b.close();
})();
