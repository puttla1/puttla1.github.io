// Grocery picture helper: a Cloudflare Worker.
// Given an item name, it runs a Google Images search (via SerpApi), then asks Claude Haiku to look at
// the top results and pick the one that best shows that exact grocery item. The keys live here, as
// Worker secrets, so they never appear in the public website code.
//
// Worker settings (Settings -> Variables and Secrets):
//   SERPAPI_KEY        secret  required
//   ANTHROPIC_API_KEY  secret  optional; without it the first Google result is used
//   ALLOWED_EMAILS     text    comma-separated Google accounts allowed to use this helper

const FIREBASE_PROJECT = 'puneeth-alaina';
const ALLOWED_ORIGINS = ['https://puneeth-alaina.com', 'https://www.puneeth-alaina.com', 'https://puttla1.github.io'];
const MODEL = 'claude-haiku-5-5';
const MAX_CANDIDATES = 8;   // returned to the page as alternates
const AI_CANDIDATES = 6;    // how many of those Claude looks at (fewer = faster)

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Headers': 'Authorization',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Vary': 'Origin'
    };
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (url.pathname !== '/pick') return reply(404, { error: 'not found' });

    // Only signed-in, approved accounts can spend the search quota.
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    let user;
    try { user = await verifyFirebaseToken(token); } catch (e) { return reply(401, { error: 'sign in again' }); }
    const allowed = (env.ALLOWED_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    if (!user.email_verified || !allowed.includes(String(user.email).toLowerCase())) return reply(403, { error: 'not allowed' });

    const q = (url.searchParams.get('q') || '').trim().slice(0, 120);
    if (!q) return reply(400, { error: 'missing q' });
    if (!env.SERPAPI_KEY) return reply(500, { error: 'SERPAPI_KEY is not set' });

    // Stream two lines so the page can show the top Google result right away:
    //   {"options":[...]}                        as soon as the search returns
    //   {"done":true,"index":n,"by":"ai"|...}     once Claude has picked (index into options)
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter(), enc = new TextEncoder();
    const send = obj => writer.write(enc.encode(JSON.stringify(obj) + '\n'));
    (async () => {
      try {
        const options = await googleImages(q, env.SERPAPI_KEY);
        await send({ options });
        let index = 0, by = options.length ? 'first' : 'none';
        if (options.length > 1 && env.ANTHROPIC_API_KEY) {
          try {
            const chosen = await claudePick(q, options.slice(0, AI_CANDIDATES), env.ANTHROPIC_API_KEY);
            if (chosen != null) { index = chosen; by = 'ai'; }
          } catch (e) { by = 'first (ai failed: ' + e.message + ')'; }
        }
        await send({ done: true, index, by });
      } catch (e) {
        await send({ error: 'image search failed: ' + e.message });
      } finally {
        await writer.close();
      }
    })();
    return new Response(readable, { headers: { ...cors, 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' } });
  }
};

/* ---------- Google Images via SerpApi ---------- */
async function googleImages(q, key) {
  const api = 'https://serpapi.com/search.json?engine=google_images&gl=us&hl=en&safe=active' +
    '&q=' + encodeURIComponent(q) + '&api_key=' + encodeURIComponent(key);
  const r = await fetch(api);
  if (!r.ok) throw new Error('SerpApi ' + r.status);
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return (d.images_results || [])
    .filter(x => x.thumbnail)
    .slice(0, MAX_CANDIDATES)
    .map(x => ({ img: x.original || x.thumbnail, thumb: x.thumbnail, cap: x.title || null, source: x.source || null }));
}

/* ---------- Claude picks the best picture ---------- */
async function claudePick(q, options, key) {
  // Download the small thumbnails here so Claude sees exactly what the page will show.
  const imgs = await Promise.all(options.map(o => toBase64Image(o.thumb).catch(() => null)));
  const content = [{
    type: 'text',
    text: 'We keep a visual grocery list. Each item shows one picture so we can recognize it at a glance in the store.\n' +
      'List item: "' + q + '"\n\n' +
      'Below are the top Google Images results. Pick the one that best shows exactly this item as a shopper would find it: ' +
      'the right brand, flavor, variety and form (for a packaged product, its package; for produce or a generic food, a clear photo of the food itself). ' +
      'Prefer a single clean product shot on a plain background. Avoid infographics, images with lots of text, people, recipes, dishes, collages, ads, logos alone, nutrition labels and screenshots.\n' +
      'Reply with only the image number.'
  }];
  const numbers = [];
  options.forEach((o, i) => {
    if (!imgs[i]) return;
    numbers.push(i + 1);
    content.push({ type: 'text', text: 'Image ' + (i + 1) + ': ' + (o.cap || '') + (o.source ? ' (from ' + o.source + ')' : '') });
    content.push({ type: 'image', source: { type: 'base64', media_type: imgs[i].type, data: imgs[i].data } });
  });
  if (!numbers.length) return null;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 10, messages: [{ role: 'user', content }] })
  });
  if (!r.ok) throw new Error('Claude ' + r.status);
  const d = await r.json();
  const text = (d.content || []).map(c => c.text || '').join(' ');
  const n = parseInt((text.match(/\d+/) || [])[0], 10);
  return numbers.includes(n) ? n - 1 : null;
}

async function toBase64Image(src) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(src, { signal: ctl.signal });
    if (!r.ok) throw new Error(String(r.status));
    let type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (type === 'image/jpg') type = 'image/jpeg';
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(type)) throw new Error('type ' + type);
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.length > 3_000_000) throw new Error('too big');
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return { type, data: btoa(bin) };
  } finally { clearTimeout(t); }
}

/* ---------- Firebase sign-in check ---------- */
let jwksCache = null;
async function googleKeys() {
  if (jwksCache && jwksCache.expires > Date.now()) return jwksCache.keys;
  const r = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
  const d = await r.json();
  jwksCache = { keys: d.keys || [], expires: Date.now() + 60 * 60 * 1000 };
  return jwksCache.keys;
}
function b64urlBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  const bin = atob(s); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function verifyFirebaseToken(token) {
  const parts = (token || '').split('.');
  if (parts.length !== 3) throw new Error('bad token');
  const header = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[0])));
  const payload = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[1])));
  if (header.alg !== 'RS256') throw new Error('alg');
  const jwk = (await googleKeys()).find(k => k.kid === header.kid);
  if (!jwk) throw new Error('kid');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!ok) throw new Error('signature');
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== FIREBASE_PROJECT || payload.iss !== 'https://securetoken.google.com/' + FIREBASE_PROJECT) throw new Error('audience');
  if (!(payload.exp > now) || payload.iat > now + 300) throw new Error('expired');
  return payload;
}
