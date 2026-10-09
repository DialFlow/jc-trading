// JC Trading API — Cloudflare Worker (free plan).
// Paste this whole file into the Worker editor in the Cloudflare dashboard.
//
// Needs, under the Worker's Settings → Bindings / Variables:
//   JC        KV namespace binding (stores the synced journal)
//   SYNC_KEY     Secret: Jacob's owner key. Creating an account with it as the invite code makes that account the owner
//                (moves the old shared journal into it, and only the owner gets the TradingView real-time candles)
//   INVITE_CODE  Secret (optional): the code friends use to create their own accounts
//   TV_KEY    Secret: the key in the TradingView live-feed alert (jc_tv_live_feed.pine)
//   GOOGLE_CLIENT_ID  Variable (optional): OAuth web client ID from Google Cloud; turns on "Continue with Google"
//
// Routes:
//   GET /prices?symbols=ES=F,NQ=F,...  → { updated, source, quotes: { sym: {price, prev, time} } }
//   POST /tv   body { k: TV_KEY, tf: '5', bars: { 'ES=F': [[t,o,h,l,c]…], 'NQ=F': … } } ← TradingView webhook, one per closed 5m candle
//   GET /bars  (with X-Sync-Key: TradingView 5m candles merged in, real time; without: Yahoo only, ~10 min late)
//   GET /bars                          → { updated, bars: { "ES=F": { "5m": [[t,o,h,l,c]…], "15m", "1h", "1d" }, "NQ=F": … } }
//   GET /news                          → this week's USD high/medium events (Forex Factory)
//   GET /sectors                       → sector ETF 1d/5d performance
//   POST /account/signup { name, email, pass, invite } → { token, name, owner, email, google }   (one account per person)
//   POST /account/login  { name (username or email), pass } → same
//   POST /account/google { credential, invite?, name? } → same (new Google users need the invite code once)
//   GET/POST /account/me (X-User-Token) → profile · POST { email } or { credential } adds an email / connects Google
//   GET /account/config → { googleClientId }
//   POST /account/logout (X-User-Token)
//   GET /sync                         → that user's { key: { v, t } }   (header X-User-Token; old X-Sync-Key = the owner)
//   PUT /sync   body { key: { v, t } } → merged state, newest t wins per key (the journal merges day by day)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Key, X-User-Token',
};
const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...extra } });

// Only these keys are stored; anything else in a PUT is ignored
const SYNC_KEYS = ['jct_bias', 'jct_bt_chat', 'jct_checklist', 'jct_dash_notes', 'jct_edge_notes', 'jct_risk', 'jct_plan',
  'jct_journal', 'jct_levels', 'jct_trades', 'tjr_bias'];
const MAX_BODY = 5 * 1024 * 1024;

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    try {
      if (url.pathname === '/prices' && req.method === 'GET') return await prices(url, ctx);
      if (url.pathname === '/bars' && req.method === 'GET') return await barsFor(req, env, ctx);
      if (url.pathname === '/tv' && req.method === 'POST') return await tvIn(req, env);
      if (url.pathname === '/news' && req.method === 'GET') return await cached(ctx, 'news', 1800, news);
      if (url.pathname === '/sectors' && req.method === 'GET') return await cached(ctx, 'sectors', 300, sectors);
      if (url.pathname === '/journal' && req.method === 'GET') return await journal(url, ctx);
      if (url.pathname === '/sync') return await sync(req, env);
      if (url.pathname === '/account/signup' && req.method === 'POST') return await signup(req, env);
      if (url.pathname === '/account/login' && req.method === 'POST') return await login(req, env);
      if (url.pathname === '/account/logout' && req.method === 'POST') return await logout(req, env);
      if (url.pathname === '/account/google' && req.method === 'POST') return await google(req, env);
      if (url.pathname === '/account/me') return await me(req, env);
      if (url.pathname === '/account/config' && req.method === 'GET') return authConfig(env);
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

// Candles for the multi-timeframe FVG scan (same shape as bars.json from GitHub Actions)
const BAR_SPECS = [
  { tf: '1m',  interval: '1m',  range: '2d',  keep: 300 },
  { tf: '5m',  interval: '5m',  range: '5d',  keep: 600 }, // ≥2 sessions: the Lab's live tracker needs the prior day for PDH/PDL
  { tf: '15m', interval: '15m', range: '10d', keep: 300 },
  { tf: '30m', interval: '30m', range: '1mo', keep: 300 },
  { tf: '1h',  interval: '60m', range: '3mo', keep: 1300 }, // 4h is built from these in the page
  { tf: '1d',  interval: '1d',  range: '1y',  keep: 250 },
];
async function bars(ctx) {
  const cache = caches.default;
  const cacheKey = new Request('https://cache.local/bars');
  const hit = await cache.match(cacheKey);
  if (hit) return new Response(hit.body, { headers: { 'Content-Type': 'application/json', ...CORS } });
  const out = {}, contracts = {};
  await Promise.all(['ES=F', 'NQ=F'].flatMap(sym => BAR_SPECS.map(async s => {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${s.interval}&range=${s.range}&includePrePost=true`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return;
    const r = (await res.json())?.chart?.result?.[0], q = r?.indicators?.quote?.[0];
    if (!r || !q) return;
    if (r.meta?.longName || r.meta?.shortName) contracts[sym] = r.meta.longName || r.meta.shortName;
    const rows = [];
    r.timestamp.forEach((t, i) => {
      if ([q.open[i], q.high[i], q.low[i], q.close[i]].some(v => v == null)) return;
      rows.push([t, q.open[i], q.high[i], q.low[i], q.close[i]].map((v, j) => j ? Math.round(v * 100) / 100 : v));
    });
    (out[sym] ||= {})[s.tf] = rows.slice(-s.keep);
  })));
  const body = JSON.stringify({ updated: Math.floor(Date.now() / 1000), source: 'Yahoo Finance via Worker', contracts, bars: out });
  ctx.waitUntil(cache.put(cacheKey, new Response(body, { headers: { 'Cache-Control': 'max-age=60' } })));
  return new Response(body, { headers: { 'Content-Type': 'application/json', ...CORS } });
}

// ---------- TradingView live feed ----------
// The TradingView alert (jc_tv_live_feed.pine) posts the last 3 closed 5m candles of ES1! and NQ1! on every 5m close.
// One KV write per alert (~280/day, inside the free 1,000/day). Served only to devices with the sync key: real-time
// CME data from Jacob's TradingView subscription is for his own use, so friends keep the delayed Yahoo candles.
const TV_KEEP = 700, TV_FRESH = 30 * 60;
async function tvIn(req, env) {
  if (!env.TV_KEY || !env.JC) return json({ error: 'Worker not configured (TV_KEY / JC binding)' }, 500);
  const text = await req.text();
  if (text.length > 20000) return json({ error: 'too large' }, 413);
  let msg; try { msg = JSON.parse(text); } catch (e) { return json({ error: 'not JSON' }, 400); }
  if (msg.k !== env.TV_KEY) return json({ error: 'wrong key' }, 401);
  if (String(msg.tf) !== '5') return json({ error: 'put the feed on a 5-minute chart' }, 400);
  const store = (await env.JC.get('tv', 'json')) || { bars: {} };
  for (const sym of ['ES=F', 'NQ=F']) {
    const rows = (msg.bars && msg.bars[sym]) || [];
    const byT = new Map((store.bars[sym] || []).map(r => [r[0], r]));
    for (const r of rows) {
      if (!Array.isArray(r) || r.length < 5 || r.some(v => typeof v !== 'number' || !isFinite(v))) continue;
      byT.set(Math.round(r[0] > 1e11 ? r[0] / 1000 : r[0]), [Math.round(r[0] > 1e11 ? r[0] / 1000 : r[0]), r[1], r[2], r[3], r[4]]);
    }
    store.bars[sym] = [...byT.values()].sort((a, b) => a[0] - b[0]).slice(-TV_KEEP);
  }
  store.updated = Math.floor(Date.now() / 1000);
  await env.JC.put('tv', JSON.stringify(store));
  return json({ ok: true, updated: store.updated });
}
// roll 5m rows into a higher timeframe (bucket = floor(t / sec) * sec, as Yahoo stamps 15m / 1h candles)
function rollUp(rows, sec) {
  const out = [];
  for (const [t, o, h, l, c] of rows) {
    const k = Math.floor(t / sec) * sec, last = out[out.length - 1];
    if (last && last[0] === k) { last[2] = Math.max(last[2], h); last[3] = Math.min(last[3], l); last[4] = c; } else out.push([k, o, h, l, c]);
  }
  return out;
}
// TradingView candles replace Yahoo's at the same time; Yahoo fills any candle a missed alert left out
function mergeRows(base, tv) {
  if (!tv.length) return base;
  const byT = new Map((base || []).map(r => [r[0], r]));
  for (const r of tv) byT.set(r[0], r);
  return [...byT.values()].sort((a, b) => a[0] - b[0]);
}
async function barsFor(req, env, ctx) {
  const res = await bars(ctx);
  const who = await whoIs(req, env);
  if (!who || !who.owner) return res;
  const tv = await env.JC.get('tv', 'json');
  if (!tv || !tv.updated || Date.now() / 1000 - tv.updated > TV_FRESH) return res;
  const body = await res.json();
  for (const sym of ['ES=F', 'NQ=F']) {
    const t5 = (tv.bars && tv.bars[sym]) || [], b = body.bars[sym]; if (!t5.length || !b) continue;
    b['5m'] = mergeRows(b['5m'], t5).slice(-600);
    // the latest 15m / 1h candles from the real-time 5m (the first partial bucket is left to Yahoo)
    for (const [tf, sec] of [['15m', 900], ['1h', 3600]]) {
      const firstFull = Math.ceil(t5[0][0] / sec) * sec, rolled = rollUp(t5.filter(r => r[0] >= firstFull), sec);
      if (rolled.length) b[tf] = mergeRows(b[tf], rolled);
    }
  }
  body.live = { source: 'TradingView', updated: tv.updated, last: Math.max(...['ES=F', 'NQ=F'].map(s => ((tv.bars[s] || []).at(-1) || [0])[0])) };
  return json(body, 200, { 'Cache-Control': 'no-store' });
}

// ---------- Morning Journal: the numbers for one date, per symbol ----------
// GET /journal?date=YYYY-MM-DD&t1=505&t2=585&symbols=ES=F,SPY,…  (t1/t2 = ET minutes; 505 = 8:25)
// → { date, syms: { sym: { close, p1, p2, asia: { h, l, took }, ldn: { h, l, took } } } }
//   close = prior session's 4:00 pm ET price · p1/p2 = price at t1/t2 (close of the 5m candle ending then; null if not reached)
//   asia = 6 pm–3 am ET, ldn = 3–8:30 am ET; took = what price did after the session up to the later time: 'up' (took the high),
//   'down' (took the low), 'both', 'inside'. Stocks have no Asian session (pre-market starts 4 am).
const etParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function etOf(t) { const p = {}; for (const x of etParts.formatToParts(new Date(t * 1000))) p[x.type] = x.value; return { d: `${p.year}-${p.month}-${p.day}`, m: +p.hour * 60 + +p.minute }; }
async function journal(url, ctx) {
  const date = url.searchParams.get('date') || '', t1 = +url.searchParams.get('t1') || 505, t2 = +url.searchParams.get('t2') || 585;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'date=YYYY-MM-DD required' }, 400);
  const syms = [...new Set((url.searchParams.get('symbols') || '').split(',').map(s => s.trim()).filter(Boolean))].slice(0, 45);
  const key = new Request(`https://cache.local/journal?${date}&${t1}&${t2}&${syms.slice().sort().join(',')}`), hit = await caches.default.match(key);
  if (hit) return new Response(hit.body, { headers: { 'Content-Type': 'application/json', ...CORS } });
  const prevDay = new Date(Date.parse(date + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
  const out = {};
  await Promise.all(syms.map(async sym => {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=5m&range=10d&includePrePost=true`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return;
    const r = (await res.json())?.chart?.result?.[0], q = r?.indicators?.quote?.[0]; if (!r || !q) return;
    const bars = []; r.timestamp.forEach((t, i) => { if ([q.high[i], q.low[i], q.close[i]].every(v => v != null)) bars.push({ ...etOf(t), h: q.high[i], l: q.low[i], c: q.close[i] }); });
    const round = v => v == null ? null : Math.round(v * 100) / 100;
    // prior close: the last candle starting at or before 3:55 pm on the latest earlier date
    const before = bars.filter(b => b.d < date && b.m <= 955), close = before.length ? before[before.length - 1].c : null;
    const at = tm => { const b = bars.filter(x => x.d === date && x.m <= tm - 5); const last = b[b.length - 1]; return last && last.m >= tm - 30 ? last.c : null; };
    const p1 = at(t1), p2 = at(t2);
    const range = f => { const s = bars.filter(f); return s.length ? { h: Math.max(...s.map(b => b.h)), l: Math.min(...s.map(b => b.l)) } : null; };
    const upTo = Math.max(t1, t2), reached = bars.some(b => b.d === date && b.m >= upTo - 5);
    const end = reached ? upTo : 24 * 60;
    const took = (rg, from) => { if (!rg) return null; const s = bars.filter(b => b.d === date && b.m >= from && b.m < end); if (!s.length) return null;
      const hi = Math.max(...s.map(b => b.h)) > rg.h, lo = Math.min(...s.map(b => b.l)) < rg.l; return hi && lo ? 'both' : hi ? 'up' : lo ? 'down' : 'inside'; };
    const allHours = /=F$|-USD$/.test(sym);   // futures and crypto trade overnight; stocks only have after-hours/pre-market
    const asia = !allHours ? null : range(b => (b.d === prevDay && b.m >= 1080) || (b.d === date && b.m < 180)), ldn = range(b => b.d === date && b.m >= 180 && b.m < 510);
    out[sym] = { close: round(close), p1: round(p1), p2: round(p2),
      asia: asia ? { h: round(asia.h), l: round(asia.l), took: took(asia, 180) } : null, ldn: ldn ? { h: round(ldn.h), l: round(ldn.l), took: took(ldn, 510) } : null };
  }));
  const body = JSON.stringify({ date, t1, t2, syms: out });
  ctx.waitUntil(caches.default.put(key, new Response(body, { headers: { 'Cache-Control': 'max-age=120' } })));
  return new Response(body, { headers: { 'Content-Type': 'application/json', ...CORS } });
}

async function cached(ctx, name, ttl, make) {
  const key = new Request('https://cache.local/' + name), hit = await caches.default.match(key);
  if (hit) return new Response(hit.body, { headers: { 'Content-Type': 'application/json', ...CORS } });
  const body = JSON.stringify(await make());
  ctx.waitUntil(caches.default.put(key, new Response(body, { headers: { 'Cache-Control': 'max-age=' + ttl } })));
  return new Response(body, { headers: { 'Content-Type': 'application/json', ...CORS } });
}
async function news() {
  const res = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const all = res.ok ? await res.json() : [];
  return { updated: Math.floor(Date.now() / 1000), source: 'Forex Factory calendar', events: all.filter(e => e.country === 'USD' && (e.impact === 'High' || e.impact === 'Medium'))
    .map(e => ({ date: e.date, title: e.title, impact: e.impact, forecast: e.forecast || '', previous: e.previous || '' })) };
}
const SECTORS = { XLK: 'Technology', XLC: 'Communication', XLY: 'Consumer Discretionary', XLF: 'Financials', XLV: 'Health Care', XLI: 'Industrials',
  XLE: 'Energy', XLB: 'Materials', XLP: 'Consumer Staples', XLU: 'Utilities', XLRE: 'Real Estate' };
async function sectors() {
  const res = await fetch('https://query1.finance.yahoo.com/v8/finance/spark?range=5d&interval=1d&symbols=' + Object.keys(SECTORS).join(','), { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const data = res.ok ? await res.json() : {};
  return { updated: Math.floor(Date.now() / 1000), source: 'SPDR sector ETFs via Yahoo', sectors: Object.entries(SECTORS).map(([sym, name]) => {
    const c = (data[sym]?.close || []).filter(v => v != null);
    return c.length >= 2 ? { sym, name, last: c.at(-1), d1: +((c.at(-1) / c.at(-2) - 1) * 100).toFixed(2), d5: +((c.at(-1) / c[0] - 1) * 100).toFixed(2) } : null;
  }).filter(Boolean).sort((a, b) => b.d1 - a.d1) };
}

// ---------- accounts: one private journal per person ----------
// KV keys: user:<name> = { salt, hash, iter, owner, created } · tok:<token> = name (expires) · state:<name> = synced data.
// The old shared data under "state" belongs to the owner (anyone holding SYNC_KEY).
const NAME_RE = /^[a-z0-9_.-]{2,24}$/, TOKEN_TTL = 400 * 86400, ITER = 10000; // PBKDF2 kept light for the free plan's CPU limit
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
async function hashPass(pass, saltHex, iter) {
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, key, 256));
}
const same = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
async function body(req) { const t = await req.text(); if (t.length > 4096) throw new Error('too large'); return JSON.parse(t || '{}'); }
async function newToken(env, name) {
  const tok = hex(crypto.getRandomValues(new Uint8Array(24)));
  await env.JC.put('tok:' + tok, name, { expirationTtl: TOKEN_TTL });
  return tok;
}
// email:<address> = username, so people can sign in with either; Google accounts are found by their verified email
// Terms & Conditions (terms.html): every new account must accept the current version; it's stored on the user
const TERMS_V = '2026-10-09';
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;
const inviteKind = (env, invite) => invite && invite === env.SYNC_KEY ? 'owner' : invite && env.INVITE_CODE && invite === env.INVITE_CODE ? 'friend' : null;
async function createUser(env, name, rec) {
  await env.JC.put('user:' + name, JSON.stringify({ ...rec, created: Date.now() }));
  if (rec.email) await env.JC.put('email:' + rec.email, name);
  // the owner's account takes over the journal that was synced with the shared key
  if (rec.owner && !(await env.JC.get('state:' + name))) { const old = await env.JC.get('state'); if (old) await env.JC.put('state:' + name, old); }
}
const session = async (env, name, u) => json({ token: await newToken(env, name), name, owner: !!u.owner, email: u.email || '', google: !!u.google });
async function signup(req, env) {
  if (!env.JC || !env.SYNC_KEY) return json({ error: 'Worker not configured' }, 500);
  const { name: raw, pass, invite, email: em, agree } = await body(req), name = String(raw || '').trim().toLowerCase(), email = String(em || '').trim().toLowerCase();
  if (!NAME_RE.test(name)) return json({ error: 'Username: 2–24 letters, numbers, . _ or -' }, 400);
  if (!EMAIL_RE.test(email)) return json({ error: 'Enter a valid email address' }, 400);
  if (typeof pass !== 'string' || pass.length < 8 || pass.length > 200) return json({ error: 'Password: at least 8 characters' }, 400);
  if (agree !== true) return json({ error: 'Please read and accept the Terms & Conditions', needTerms: true }, 400);
  const kind = inviteKind(env, invite); if (!kind) return json({ error: 'Wrong invite code' }, 403);
  if (await env.JC.get('user:' + name)) return json({ error: 'That username is taken' }, 409);
  if (await env.JC.get('email:' + email)) return json({ error: 'That email already has an account: sign in instead' }, 409);
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  const u = { salt, hash: await hashPass(pass, salt, ITER), iter: ITER, owner: kind === 'owner', email, terms: { v: TERMS_V, at: Date.now() } };
  await createUser(env, name, u);
  return session(env, name, u);
}
async function login(req, env) {
  if (!env.JC) return json({ error: 'Worker not configured' }, 500);
  const { name: raw, pass } = await body(req), id = String(raw || '').trim().toLowerCase();
  const name = id.includes('@') ? await env.JC.get('email:' + id) : id;
  const u = name && NAME_RE.test(name) && await env.JC.get('user:' + name, 'json');
  if (!u || !u.hash || typeof pass !== 'string' || !same(await hashPass(pass, u.salt, u.iter), u.hash))
    return json({ error: u && !u.hash ? 'This account uses Google: tap Continue with Google' : 'Wrong username/email or password' }, 401);
  return session(env, name, u);
}
// Google: the page gets an ID token from Google Identity Services; Google's tokeninfo endpoint checks the signature
async function googleId(credential, env) {
  if (!env.GOOGLE_CLIENT_ID) throw new Error('Google sign-in is not set up');
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(String(credential || '')));
  const g = r.ok ? await r.json() : null;
  if (!g || g.aud !== env.GOOGLE_CLIENT_ID || !['accounts.google.com', 'https://accounts.google.com'].includes(g.iss) || String(g.email_verified) !== 'true' || +g.exp * 1000 < Date.now())
    throw new Error('Google sign-in failed: try again');
  return { sub: g.sub, email: String(g.email).toLowerCase() };
}
async function google(req, env) {
  if (!env.JC) return json({ error: 'Worker not configured' }, 500);
  const { credential, invite, name: raw, agree } = await body(req);
  let g; try { g = await googleId(credential, env); } catch (e) { return json({ error: e.message }, 401); }
  const existing = await env.JC.get('email:' + g.email);
  if (existing) { const u = await env.JC.get('user:' + existing, 'json');
    if (u && u.google && u.google !== g.sub) return json({ error: 'That email is linked to a different Google account' }, 401);
    if (u && !u.google) { u.google = g.sub; await env.JC.put('user:' + existing, JSON.stringify(u)); }
    return session(env, existing, u); }
  // first time with Google: needs an invite code, like any new account
  const kind = inviteKind(env, invite);
  if (!kind) return json({ error: 'New here? Enter the invite code and accept the Terms, then tap Continue with Google again', needInvite: true }, 403);
  if (agree !== true) return json({ error: 'Please read and accept the Terms & Conditions, then tap Continue with Google again', needTerms: true, needInvite: true }, 400);
  let name = String(raw || g.email.split('@')[0]).toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 20);
  if (name.length < 2) name = 'user';
  for (let k = 0; await env.JC.get('user:' + name); k++) name = name.slice(0, 18) + (k + 2);
  const u = { google: g.sub, email: g.email, owner: kind === 'owner', terms: { v: TERMS_V, at: Date.now() } };
  await createUser(env, name, u);
  return session(env, name, u);
}
// signed in: see / add the email, connect Google to an existing account
async function me(req, env) {
  const who = await whoIs(req, env); if (!who || !who.name) return json({ error: 'signed out' }, 401);
  const u = (await env.JC.get('user:' + who.name, 'json')) || {};
  if (req.method === 'GET') return json({ name: who.name, owner: !!u.owner, email: u.email || '', google: !!u.google, password: !!u.hash });
  const { email: em, credential } = await body(req);
  if (credential) {
    let g; try { g = await googleId(credential, env); } catch (e) { return json({ error: e.message }, 401); }
    const taken = await env.JC.get('email:' + g.email); if (taken && taken !== who.name) return json({ error: 'That Google email already has its own account' }, 409);
    if (u.email && u.email !== g.email) await env.JC.delete('email:' + u.email);
    Object.assign(u, { google: g.sub, email: g.email });
  } else {
    const email = String(em || '').trim().toLowerCase(); if (!EMAIL_RE.test(email)) return json({ error: 'Enter a valid email address' }, 400);
    const taken = await env.JC.get('email:' + email); if (taken && taken !== who.name) return json({ error: 'That email already has an account' }, 409);
    if (u.email && u.email !== email) await env.JC.delete('email:' + u.email);
    u.email = email;
  }
  await env.JC.put('user:' + who.name, JSON.stringify(u)); await env.JC.put('email:' + u.email, who.name);
  return json({ name: who.name, owner: !!u.owner, email: u.email, google: !!u.google, password: !!u.hash });
}
// public: which sign-in options exist (the Google client ID is public by design)
const authConfig = env => json({ googleClientId: env.GOOGLE_CLIENT_ID || '' }, 200, { 'Cache-Control': 'max-age=300' });
async function logout(req, env) {
  const tok = req.headers.get('X-User-Token');
  if (tok && /^[0-9a-f]{48}$/.test(tok) && env.JC) await env.JC.delete('tok:' + tok);
  return json({ ok: true });
}
// who is calling: { stateKey, name, owner } or null
async function whoIs(req, env) {
  const tok = req.headers.get('X-User-Token');
  if (tok && env.JC && /^[0-9a-f]{48}$/.test(tok)) {
    const name = await env.JC.get('tok:' + tok); if (!name) return null;
    const u = await env.JC.get('user:' + name, 'json');
    return { stateKey: 'state:' + name, name, owner: !!(u && u.owner) };
  }
  const k = req.headers.get('X-Sync-Key');
  if (k && env.SYNC_KEY && same(k, env.SYNC_KEY)) return { stateKey: 'state', name: null, owner: true };
  return null;
}
// journal entries merge day by day (each day carries u = when it was last edited), so two devices can't wipe each other's days
function mergeJournal(a, b) {
  try {
    const x = JSON.parse(a), y = JSON.parse(b), out = { ...x };
    for (const d in y) if (!out[d] || (y[d] && (y[d].u || 0) > (out[d].u || 0))) out[d] = y[d];
    return JSON.stringify(out);
  } catch (e) { return null; }
}

async function sync(req, env) {
  if (!env.JC) return json({ error: 'Worker not configured (JC binding)' }, 500);
  const who = await whoIs(req, env);
  if (!who) return json({ error: req.headers.get('X-User-Token') ? 'signed out' : 'wrong sync key' }, 401);

  const state = (await env.JC.get(who.stateKey, 'json')) || {};
  if (req.method === 'GET') return json(state, 200, { 'Cache-Control': 'no-store' });
  if (req.method !== 'PUT') return json({ error: 'method not allowed' }, 405);

  const text = await req.text();
  if (text.length > MAX_BODY) return json({ error: 'too large' }, 413);
  const incoming = JSON.parse(text);
  let changed = false;
  for (const k of SYNC_KEYS) {
    const e = incoming[k];
    if (!e || typeof e.t !== 'number' || typeof e.v !== 'string') continue;
    if (k === 'jct_journal' && state[k] && e.v !== state[k].v) {
      const m = mergeJournal(state[k].v, e.v);
      if (m && m !== state[k].v) { state[k] = { v: m, t: Math.max(e.t, state[k].t) }; changed = true; }
      continue;
    }
    if (!state[k] || e.t > state[k].t) { state[k] = { v: e.v, t: e.t }; changed = true; }
  }
  if (changed) await env.JC.put(who.stateKey, JSON.stringify(state));
  return json(state, 200, { 'Cache-Control': 'no-store' });
}