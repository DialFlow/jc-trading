// Replay chart timeframes 5m · 15m · 1H · 4H · D, with "hide the future" respected on 4H and Daily.
// Usage: node tests/serve.js . 8090   then   node tests/replaytftest.js
const { chromium } = require('playwright'), path = require('path');
(async () => {
  const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
  const b = await chromium.launch({ channel: 'msedge' });
  for (const [name, vp] of [['desktop', { width: 1280, height: 1000 }], ['phone', { width: 390, height: 900 }]]) {
    const p = await b.newPage({ viewport: vp, colorScheme: 'dark' }), errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto('http://localhost:8090/'); await p.waitForTimeout(6000);
    await p.evaluate(() => { showPage('backtest'); labView('replay'); }); await p.waitForTimeout(3500);
    await p.evaluate(() => { document.getElementById('rp-day').value = '2026-10-08'; rpLoad(); }); await p.waitForTimeout(800);
    const btns = await p.evaluate(() => [...document.querySelectorAll('#rp-tf .mtf-seg')].map(b => b.textContent));
    ok(btns.join(' ') === '5m 15m 1H 4H D', `${name}: chart buttons ${btns.join(' · ')}`);
    for (const tf of ['5m', '15m', '1h', '4h', '1d']) {
      await p.evaluate(t => { rpSetTf(t); rpJump(600); }, tf); await p.waitForTimeout(400);   // 10:00 ET
      const info = await p.evaluate(() => ({ svg: !!document.querySelector('#rp-panels .rp-chart svg'), candles: document.querySelectorAll('#rp-panels .rp-chart svg line').length, tag: [...document.querySelectorAll('#rp-panels .rp-chart svg text')].map(t => t.textContent).find(s => /candles/.test(s)) }));
      ok(info.svg && info.tag && (tf === '5m' ? /^5m/ : new RegExp('^' + ({ '15m': '15m', '1h': '1H', '4h': '4H', '1d': 'D' })[tf] + ' ')).test(info.tag), `${name} ${tf}: chart drawn (${info.tag}, ${info.candles} lines)`);
    }
    // no look-ahead: at 10:00 the forming daily candle's high/low must not include the rest of the day
    const la = await p.evaluate(() => { const S = rpSets['NQ=F'], at = S.bars.findIndex(b => b.m >= 600), upto = S.bars.slice(0, at + 1);
      const d1 = rpHtf(S, upto, '1d').slice(-1)[0], dAll = rpHtf(S, S.bars, '1d').slice(-1)[0], h4 = rpHtf(S, upto, '4h').slice(-1)[0];
      return { d1, dAll, h4Last: h4.t + 14400 > upto.slice(-1)[0].t, upHi: Math.max(...upto.map(b => b.h)) }; });
    ok(la.d1.h >= la.upHi && la.d1.h <= la.dAll.h && la.d1.c !== la.dAll.c, `${name} daily at 10:00: H ${la.d1.h} (full day ${la.dAll.h}), close ${la.d1.c} vs end-of-replay ${la.dAll.c}`);
    ok(la.h4Last, `${name} 4H: the last candle is the one forming at 10:00`);
    await p.evaluate(() => { rpSetTf('1d'); rpJump(600); }); await p.waitForTimeout(300);
    await (await p.$('.rp-panel')).screenshot({ path: path.join(__dirname, `replay-1d-${name}.png`) });
    ok(!(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth)), name + ' no sideways scroll');
    ok(errs.length === 0, `${name} JS errors: ${errs.length} ${errs.join(' | ')}`);
    await p.close();
  }
  await b.close();
})();
