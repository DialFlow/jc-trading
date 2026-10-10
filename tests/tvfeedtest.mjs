// TradingView live feed → Worker: ingest auth, merge into /bars for keyed requests only, 15m/1h roll-up.
// Runs cloudflare/worker.js in Node with an in-memory KV and a no-op cache (Yahoo is fetched for real).
// Usage: node tests/tvfeedtest.mjs
const mem = new Map();
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const env = { SYNC_KEY: 'sync-test', TV_KEY: 'tv-test', JC: { get: async (k, t) => mem.has(k) ? (t === 'json' ? JSON.parse(mem.get(k)) : mem.get(k)) : null, put: async (k, v) => { mem.set(k, v); } } };
const W = (await import(new URL('../cloudflare/worker.js', import.meta.url))).default;
const ctx = { waitUntil() {} };
const call = (path, init = {}) => W.fetch(new Request('https://w.test' + path, init), env, ctx);
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

// what the Pine alert sends: last 3 closed 5m candles for both contracts (ms timestamps, as Pine's time)
const now = Math.floor(Date.now() / 1000 / 300) * 300 - 300;
const rows = (base) => [2, 1, 0].map(k => [(now - k * 300) * 1000, base + k, base + k + 3, base + k - 2, base + k + 1]);
const msg = { k: 'tv-test', tf: '5', bars: { 'ES=F': rows(7000), 'NQ=F': rows(30000), 'VIX': rows(15) } };

ok((await call('/tv', { method: 'POST', body: JSON.stringify({ ...msg, k: 'nope' }) })).status === 401, 'wrong TV key is refused');
ok((await call('/tv', { method: 'POST', body: JSON.stringify({ ...msg, tf: '1' }) })).status === 400, 'a non-5-minute chart is refused');
ok((await call('/tv', { method: 'POST', body: 'not json' })).status === 400, 'garbage is refused');
const r1 = await call('/tv', { method: 'POST', body: JSON.stringify(msg) });
ok(r1.status === 200, 'feed accepted');
// the next alert overlaps by 2 candles: no duplicates
await call('/tv', { method: 'POST', body: JSON.stringify({ ...msg, bars: { 'ES=F': rows(7000).slice(1), 'NQ=F': rows(30000).slice(1) } }) });
const stored = JSON.parse(mem.get('tv'));
ok(stored.bars['NQ=F'].length === 3 && stored.bars['NQ=F'].at(-1)[0] === now, 'stored 3 candles, seconds timestamps, no duplicates');

const pub = await (await call('/bars')).json();
ok(!pub.live && pub.bars['NQ=F']['5m'].at(-1)[0] !== now || !pub.live, 'without the sync key: Yahoo only (no TradingView data)');
const wrong = await (await call('/bars', { headers: { 'X-Sync-Key': 'bad' } })).json();
ok(!wrong.live, 'wrong sync key: Yahoo only');
const priv = await (await call('/bars', { headers: { 'X-Sync-Key': 'sync-test' } })).json();
const n5 = priv.bars['NQ=F']['5m'];
ok(priv.live && priv.live.source === 'TradingView' && priv.live.last === now, 'with the sync key: live.source = TradingView');
ok(n5.at(-1)[0] === now && n5.at(-1)[4] === 30001, 'latest 5m candle is the TradingView one');
ok(n5.every((r, i) => !i || r[0] > n5[i - 1][0]), '5m candles sorted, no duplicate times');
ok(n5.length <= 600, '5m capped at 600');
const h1 = priv.bars['NQ=F']['1h'];
ok(h1.every((r, i) => !i || r[0] > h1[i - 1][0]), '1h candles still sorted after the roll-up');
ok(priv.live.vix && priv.live.vix[4] === 16, 'VIX from the feed is passed on (owner only): ' + JSON.stringify(priv.live.vix));
ok(!pub.live, 'friends get no VIX from the feed either');
// stale feed (> 30 min) is ignored
stored.updated -= 3600; mem.set('tv', JSON.stringify(stored));
ok(!(await (await call('/bars', { headers: { 'X-Sync-Key': 'sync-test' } })).json()).live, 'a feed older than 30 min falls back to Yahoo');
