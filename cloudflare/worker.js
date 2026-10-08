// JC Trading API — Cloudflare Worker (free plan).
// Paste this whole file into the Worker editor in the Cloudflare dashboard.
//
// Needs, under the Worker's Settings → Bindings / Variables:
//   JC        KV namespace binding (stores the synced journal)
//   SYNC_KEY  Secret: the private key each device enters once
//
// Routes:
//   GET /prices?symbols=ES=F,NQ=F,...  → { updated, source, quotes: { sym: {price, prev, time} } }
//   GET /sync                          → { key: { v, t } }        (header X-Sync-Key required)
//   PUT /sync   body { key: { v, t } } → merged state, newest t wins per key

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Key',
};
const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...extra } });

// Only these keys are stored; anything else in a PUT is ignored
const SYNC_KEYS = ['jct_bias', 'jct_bt_chat', 'jct_checklist', 'jct_dash_notes', 'jct_edge_notes',
  'jct_journal', 'jct_levels', 'jct_trades', 'tjr_bias'];
const MAX_BODY = 5 * 1024 * 1024;

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    try {
      if (url.pathname === '/prices' && req.method === 'GET') return await prices(url, ctx);
      if (url.pathname === '/sync') return await sync(req, env);
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};

async function prices(url, ctx) {
  const syms = [...new Set((url.searchParams.get('symbols') || '').split(',').map(s => s.trim()).filter(Boolean))].slice(0, 100);
  if (!syms.length) return json({ error: 'symbols required' }, 400);

  // Share one Yahoo call per symbol set across all viewers for 15 s
  const cache = caches.default;
  const cacheKey = new Request('https://cache.local/prices?' + syms.slice().sort().join(','));
  const hit = await cache.match(cacheKey);
  if (hit) return new Response(hit.body, { headers: { 'Content-Type': 'application/json', ...CORS } });

  const quotes = {};
  for (let i = 0; i < syms.length; i += 20) { // Yahoo spark: max 20 symbols per call
    const batch = syms.slice(i, i + 20);
    const res = await fetch('https://query1.finance.yahoo.com/v8/finance/spark?range=1d&interval=1m&symbols='
      + encodeURIComponent(batch.join(',')), { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) continue;
    const data = await res.json();
    for (const [sym, x] of Object.entries(data)) {
      const closes = x.close || [];
      let k = closes.length - 1;
      while (k >= 0 && closes[k] == null) k--;
      if (k < 0) continue;
      quotes[sym] = { price: closes[k], prev: x.previousClose ?? x.chartPreviousClose ?? closes[k], time: x.timestamp[k] };
    }
  }
  const body = JSON.stringify({ updated: Math.floor(Date.now() / 1000), source: 'Yahoo Finance via Worker', quotes });
  ctx.waitUntil(cache.put(cacheKey, new Response(body, { headers: { 'Cache-Control': 'max-age=15' } })));
  return new Response(body, { headers: { 'Content-Type': 'application/json', ...CORS } });
}

async function sync(req, env) {
  if (!env.SYNC_KEY || !env.JC) return json({ error: 'Worker not configured (SYNC_KEY / JC binding)' }, 500);
  if (req.headers.get('X-Sync-Key') !== env.SYNC_KEY) return json({ error: 'wrong sync key' }, 401);

  const state = (await env.JC.get('state', 'json')) || {};
  if (req.method === 'GET') return json(state, 200, { 'Cache-Control': 'no-store' });
  if (req.method !== 'PUT') return json({ error: 'method not allowed' }, 405);

  const text = await req.text();
  if (text.length > MAX_BODY) return json({ error: 'too large' }, 413);
  const incoming = JSON.parse(text);
  let changed = false;
  for (const k of SYNC_KEYS) {
    const e = incoming[k];
    if (!e || typeof e.t !== 'number' || typeof e.v !== 'string') continue;
    if (!state[k] || e.t > state[k].t) { state[k] = { v: e.v, t: e.t }; changed = true; }
  }
  if (changed) await env.JC.put('state', JSON.stringify(state));
  return json(state, 200, { 'Cache-Control': 'no-store' });
}
