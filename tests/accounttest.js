// Accounts + journal: every person has a private journal that autosaves and follows them across devices.
// The real cloudflare/worker.js answers /sync and /account/* in-process (in-memory KV); everything else goes to the network.
// Usage: node tests/serve.js . 8090   then   node tests/accounttest.js
const { chromium } = require('playwright');
const { pathToFileURL } = require('url'), path = require('path');
(async () => {
  const W = (await import(pathToFileURL(path.join(__dirname, '../cloudflare/worker.js')))).default;
  const mem = new Map();
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  const env = { SYNC_KEY: 'owner-key', INVITE_CODE: 'friend-code', JC: {
    get: async (k, ty) => mem.has(k) ? (ty === 'json' ? JSON.parse(mem.get(k)) : mem.get(k)) : null,
    put: async (k, v) => { mem.set(k, v); }, delete: async k => { mem.delete(k); } } };
  // the owner's old shared journal (synced with the old key) waiting to be moved into his account
  mem.set('state', JSON.stringify({ jct_journal: { v: JSON.stringify({ '2026-10-01': { obs: 'old shared entry', rows: {}, u: 1 } }), t: 1 } }));
  const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
  const b = await chromium.launch({ channel: 'msedge' }), errs = [];
  async function device(vp) {
    const ctx = await b.newContext({ viewport: vp });
    await ctx.route(/workers\.dev\/(sync|account)/, async route => {
      const r = route.request();
      const res = await W.fetch(new Request(r.url(), { method: r.method(), headers: r.headers(), body: ['GET', 'HEAD'].includes(r.method()) ? undefined : r.postData() }), env, { waitUntil() {} });
      route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() });
    });
    const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
    await p.goto('http://localhost:8090/'); await p.waitForTimeout(3500);
    return p;
  }
  const journal = async p => { await p.click('.tab-btn:has-text("Journal")'); await p.waitForTimeout(300); };
  const signIn = async (p, mode, name, pass, invite) => {
    await p.click('#sync-pill'); await p.waitForTimeout(200);
    await p.evaluate(m => Sync.mode(m), mode);
    await p.fill('#acct-user', name); await p.fill('#acct-pass', pass); if (invite) await p.fill('#acct-invite', invite);
    await p.click('#acct-go'); await p.waitForTimeout(2500);
  };
  const msg = p => p.evaluate(() => document.getElementById('sync-msg').textContent);
  const label = p => p.evaluate(() => document.getElementById('sync-label').textContent);

  for (const [name, vp] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    console.log(`--- ${name}`);
    for (const k of [...mem.keys()]) if (k !== 'state') mem.delete(k);
    // 1. typing autosaves and survives a reload (no account yet)
    const A = await device(vp); await journal(A);
    const today = await A.evaluate(() => document.getElementById('journal-date').value);
    await A.fill('#journal-obs', 'alice notes ' + name); await A.waitForTimeout(1200);
    ok(/Saved/.test(await A.evaluate(() => document.getElementById('journal-saved').textContent)), 'typing autosaves (no Save button needed)');
    await A.reload(); await A.waitForTimeout(3000); await journal(A);
    ok(await A.evaluate(() => document.getElementById('journal-obs').value) === 'alice notes ' + name, 'entry still there after a reload');
    // 2. account errors
    await signIn(A, 'up', 'alice', 'secret1', 'bad-code'); ok(/invite/i.test(await msg(A)), 'wrong invite code is refused: ' + await msg(A));
    await A.click('button:has-text("Cancel")');
    // 3. create alice: this device's entry goes into her account
    await signIn(A, 'up', 'alice', 'secret1', 'friend-code'); await A.waitForTimeout(2500);
    ok(/alice/.test(await label(A)), 'header shows the signed-in person: ' + await label(A));
    await journal(A);
    ok(await A.evaluate(() => document.getElementById('journal-obs').value) === 'alice notes ' + name, 'entry kept after creating the account');
    await A.waitForTimeout(9500); // batched upload
    ok(JSON.parse(mem.get('state:alice') || '{}').jct_journal?.v.includes('alice notes'), 'saved to alice in the cloud');
    // 4. a second device signs in as alice and sees it; edits on both devices merge day by day
    const B = await device(vp); await signIn(B, 'in', 'alice', 'wrong-pass'); ok(/Wrong name or password/.test(await msg(B)), 'wrong password is refused');
    await B.click('button:has-text("Cancel")');
    await signIn(B, 'in', 'alice', 'secret1'); await B.waitForTimeout(2500); await journal(B);
    ok(await B.evaluate(() => document.getElementById('journal-obs').value) === 'alice notes ' + name, 'second device sees alice\'s entry');
    await B.fill('#journal-date', '2026-10-05'); await B.dispatchEvent('#journal-date', 'change'); await B.fill('#journal-obs', 'other day from B'); await B.waitForTimeout(1200);
    await A.fill('#journal-obs', 'alice notes ' + name + ' (edited on A)'); await A.waitForTimeout(1200);
    await B.evaluate(() => Sync.push()); await A.evaluate(() => Sync.push()); await A.evaluate(() => Sync.pull()); await B.evaluate(() => Sync.pull());
    const days = JSON.parse(JSON.parse(mem.get('state:alice')).jct_journal.v);
    ok(days[today]?.obs.includes('(edited on A)') && days['2026-10-05']?.obs === 'other day from B', 'both devices\' days kept (no overwrite)');
    // 5. sign out, then bob signs in on the same device: he never sees alice's journal
    await A.click('#sync-pill'); await A.waitForTimeout(200); await A.click('button:has-text("Sign out")'); await A.waitForTimeout(3500); await journal(A);
    ok(await A.evaluate(() => document.getElementById('journal-obs').value) === '' && /Sign in/.test(await label(A)), 'signed out: alice\'s journal removed from this device');
    await signIn(A, 'up', 'bob', 'secret2', 'friend-code'); await A.waitForTimeout(2500); await journal(A);
    ok(await A.evaluate(() => document.getElementById('journal-obs').value) === '' && /bob/.test(await label(A)), 'bob starts with his own empty journal');
    // 6. Jacob: creating his account with the old sync key moves the old shared journal into it
    const J = await device(vp); await signIn(J, 'up', 'jacob', 'secret3', 'owner-key'); await J.waitForTimeout(2500);
    await J.click('.tab-btn:has-text("Journal")'); await J.fill('#journal-date', '2026-10-01'); await J.dispatchEvent('#journal-date', 'change'); await J.waitForTimeout(300);
    ok(await J.evaluate(() => document.getElementById('journal-obs').value) === 'old shared entry', 'owner account took over the old shared journal');
    const hs = await A.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    await A.click('#sync-pill'); await A.waitForTimeout(200); await A.screenshot({ path: path.join(__dirname, `account-${name}.png`) });
    ok(!hs, 'no sideways scroll');
    for (const p of [A, B, J]) await p.context().close();
  }
  // 7. evening date: 9:30 pm ET on Oct 8 must default to Oct 8 (it used to jump to Oct 9)
  const ctx = await b.newContext(), p = await ctx.newPage(); await p.clock.setFixedTime(new Date('2026-10-09T01:30:00Z'));
  await p.goto('http://localhost:8090/'); await p.waitForTimeout(2500); await p.click('.tab-btn:has-text("Journal")');
  ok(await p.evaluate(() => document.getElementById('journal-date').value) === '2026-10-08', 'journal date at 9:30 pm ET is today in ET');
  ok(errs.length === 0, 'JS errors: ' + errs.length + ' ' + errs.join(' | '));
  await b.close();
})();
