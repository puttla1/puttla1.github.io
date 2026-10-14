// Grocery picture helper (and food-log label reader): a Cloudflare Worker.
// Given what someone typed ("pepsi 20 oz"), it:
//   1. searches Kroger's product catalog (fast, clean studio photos with package sizes) and shows that first,
//   2. adds Google Images results (via SerpApi),
//   3. asks Claude Haiku to pick the best picture from both, and to tidy the name and size
//      ("pepsi 20 oz" -> "Pepsi" / "20 fl oz").
// The keys live here as Worker secrets, so they never appear in the public website code.
//
// Worker settings (Settings -> Variables and Secrets):
//   SERPAPI_KEY           secret  Google Images search
//   KROGER_CLIENT_ID      text    Kroger catalog (optional)
//   KROGER_CLIENT_SECRET  secret  Kroger catalog (optional)
//   ANTHROPIC_API_KEY     secret  smart pick + name cleanup (optional; without it the first result is used)
//   ALLOWED_EMAILS        text    comma-separated Google accounts allowed to use this helper

const FIREBASE_PROJECT = 'puneeth-alaina';
const ALLOWED_ORIGINS = ['https://puneeth-alaina.com', 'https://www.puneeth-alaina.com', 'https://puttla1.github.io'];
const MODEL = 'claude-haiku-5-5';
const KROGER_RESULTS = 6;   // returned to the page
const GOOGLE_RESULTS = 6;
const AI_PER_SOURCE = 4;    // how many from each source Claude looks at (fewer = faster)

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Vary': 'Origin'
    };
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (!['/pick', '/tidy', '/label'].includes(url.pathname)) return reply(404, { error: 'not found' });

    // Only signed-in, approved accounts can spend the search quota.
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    let user;
    try { user = await verifyFirebaseToken(token); } catch (e) { return reply(401, { error: 'sign in again' }); }
    const allowed = (env.ALLOWED_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    if (!user.email_verified || !allowed.includes(String(user.email).toLowerCase())) return reply(403, { error: 'not allowed' });

    // /label: read a nutrition label photo for the food log (POST {image: base64 jpeg}).
    if (url.pathname === '/label') {
      if (request.method !== 'POST') return reply(405, { error: 'use POST' });
      if (!env.ANTHROPIC_API_KEY) return reply(500, { error: 'ANTHROPIC_API_KEY is not set' });
      let body;
      try { body = await request.json(); } catch (e) { return reply(400, { error: 'bad request' }); }
      const image = String(body.image || '');
      const type = ['image/jpeg', 'image/png', 'image/webp'].includes(body.type) ? body.type : 'image/jpeg';
      if (!image || image.length > 7_000_000) return reply(400, { error: 'missing or too large photo' });
      try { return reply(200, await claudeLabel(image, type, env.ANTHROPIC_API_KEY)); }
      catch (e) { return reply(502, { error: e.message }); }
    }

    const q = (url.searchParams.get('q') || '').trim().slice(0, 120);
    if (!q) return reply(400, { error: 'missing q' });

    // /tidy: just fix the name and size of an item that already has a picture (text only, no image search).
    if (url.pathname === '/tidy') {
      if (!env.ANTHROPIC_API_KEY) return reply(500, { error: 'ANTHROPIC_API_KEY is not set' });
      try {
        const out = await claudeTidy(q, (url.searchParams.get('cap') || '').slice(0, 200), (url.searchParams.get('size') || '').slice(0, 40), env.ANTHROPIC_API_KEY);
        return reply(200, out);
      } catch (e) { return reply(502, { error: e.message }); }
    }
    if (!env.SERPAPI_KEY && !env.KROGER_CLIENT_ID) return reply(500, { error: 'no image source is set up' });

    // Streamed as lines of JSON so the page can show something right away:
    //   {"options":[...]}   Kroger results, as soon as they arrive (usually well under a second)
    //   {"options":[...]}   Kroger + Google results
    //   {"done":true,"index":n,"name":"...","size":"...","by":"ai"|"first"}   Claude's pick (index into the last options)
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter(), enc = new TextEncoder();
    const send = obj => writer.write(enc.encode(JSON.stringify(obj) + '\n'));
    (async () => {
      try {
        const krogerP = env.KROGER_CLIENT_ID ? krogerSearch(q, env).catch(e => { console.log('kroger', e.message); return []; }) : Promise.resolve([]);
        const googleP = env.SERPAPI_KEY ? googleImages(q, env.SERPAPI_KEY).catch(e => { console.log('google', e.message); return []; }) : Promise.resolve([]);

        const kroger = await krogerP;
        if (kroger.length) await send({ options: kroger });
        const google = await googleP;
        const options = kroger.concat(google);
        if (google.length || !kroger.length) await send({ options });

        let result = { index: 0, by: options.length ? 'first' : 'none' };
        if (options.length && env.ANTHROPIC_API_KEY) {
          const idx = [];
          for (let i = 0; i < Math.min(AI_PER_SOURCE, kroger.length); i++) idx.push(i);
          for (let i = 0; i < Math.min(AI_PER_SOURCE, google.length); i++) idx.push(kroger.length + i);
          try {
            const ai = await claudePick(q, idx.map(i => options[i]), env.ANTHROPIC_API_KEY);
            if (ai) result = { index: ai.pick != null ? idx[ai.pick] : 0, name: ai.name, size: ai.size, by: 'ai' };
          } catch (e) { result.by = 'first (ai failed: ' + e.message + ')'; }
        }
        await send({ done: true, ...result });
      } catch (e) {
        await send({ error: 'image search failed: ' + e.message });
      } finally {
        await writer.close();
      }
    })();
    return new Response(readable, { headers: { ...cors, 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' } });
  }
};

/* ---------- Food log: read a nutrition label photo ---------- */
async function claudeLabel(data, type, key) {
  const { text, stop } = await callClaude([
    { type: 'image', source: { type: 'base64', media_type: type, data } },
    { type: 'text', text:
      'This is a photo of a food package, taken to log what someone ate. Read the Nutrition Facts panel ' +
      '(and the front of the package, if visible, for the product name and brand).\n' +
      'Give the numbers for ONE serving exactly as printed. If the label has columns for a serving and for the whole package, use the per-serving column.\n' +
      '- name: short product name as on the package, normal capitalization (e.g. "Greek Yogurt, Vanilla"); "" if not visible\n' +
      '- brand: brand name; "" if not visible\n' +
      '- serving: the serving size text as printed (e.g. "2/3 cup (55g)", "1 bar (60g)")\n' +
      '- grams: grams (or ml for drinks) in one serving as a number, or null if not printed\n' +
      '- kcal, protein, carbs, fat: numbers per serving (carbs = Total Carbohydrate, fat = Total Fat), null if not shown\n' +
      '- found: false if there is no readable nutrition label in the photo\n' +
      'Reply with only the JSON, no other text: ' +
      '{"found": true, "name": "", "brand": "", "serving": "", "grams": null, "kcal": null, "protein": null, "carbs": null, "fat": null}' }
  ], 1500, key);
  const out = parseJSON(text);
  if (out.found == null && out.kcal == null) throw new Error('no answer (stop: ' + stop + ') ' + text.slice(0, 80));
  const n = v => { const x = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^\d.]/g, '')); return isFinite(x) ? x : null; };
  const found = out.found !== false && n(out.kcal) != null;
  return { found, name: tidy(out.name), brand: tidy(out.brand), serving: tidy(out.serving),
    grams: n(out.grams), kcal: n(out.kcal), protein: n(out.protein), carbs: n(out.carbs), fat: n(out.fat) };
}

/* ---------- Kroger product catalog ---------- */
let krogerToken = null;
async function krogerAuth(env) {
  if (krogerToken && krogerToken.expires > Date.now()) return krogerToken.value;
  const r = await fetch('https://api.kroger.com/v1/connect/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa(env.KROGER_CLIENT_ID + ':' + env.KROGER_CLIENT_SECRET),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'User-Agent': 'puneeth-alaina-grocery/1.0'
    },
    body: 'grant_type=client_credentials&scope=product.compact'
  });
  if (!r.ok) throw new Error('token ' + r.status);
  const d = await r.json();
  krogerToken = { value: d.access_token, expires: Date.now() + Math.max(60, (d.expires_in || 1800) - 120) * 1000 };
  return krogerToken.value;
}
async function krogerSearch(q, env) {
  // Kroger wants 3+ characters and at most 8 words.
  const term = q.replace(/[^\w\s'&.-]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 8).join(' ');
  if (term.length < 3) return [];
  const token = await krogerAuth(env);
  const r = await fetch('https://api.kroger.com/v1/products?filter.limit=' + KROGER_RESULTS + '&filter.term=' + encodeURIComponent(term), {
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json', 'User-Agent': 'puneeth-alaina-grocery/1.0' }
  });
  if (!r.ok) throw new Error('search ' + r.status);
  const d = await r.json();
  return (d.data || []).map(p => {
    const imgs = p.images || [];
    const front = imgs.find(i => i.perspective === 'front') || imgs.find(i => i.featured) || imgs[0];
    if (!front) return null;
    const by = s => ((front.sizes || []).find(x => x.size === s) || {}).url;
    const img = by('xlarge') || by('large') || by('medium');
    const thumb = by('medium') || by('small') || by('thumbnail') || img;
    if (!img) return null;
    const size = ((p.items || [])[0] || {}).size || null;
    return { img, thumb, cap: p.description || null, size, source: 'Kroger' };
  }).filter(Boolean);
}

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
    .slice(0, GOOGLE_RESULTS)
    .map(x => ({ img: x.original || x.thumbnail, thumb: x.thumbnail, cap: x.title || null, size: null, source: x.source || 'Google' }));
}

/* ---------- Claude: pick the picture, tidy the name and size ---------- */
async function claudePick(q, cands, key) {
  // Download the small thumbnails here so Claude sees exactly what the page will show.
  const imgs = await Promise.all(cands.map(o => toBase64Image(o.thumb).catch(() => null)));
  const content = [{
    type: 'text',
    text: 'We keep a visual grocery list. Each item shows one picture so we can recognize it at a glance in the store.\n' +
      'Someone typed: "' + q + '"\n\n' +
      'Below are candidate pictures from Kroger\'s catalog and from Google Images.\n' +
      '1. Pick the picture that best shows exactly this item as a shopper would find it: the right brand, flavor, variety and form ' +
      '(for a packaged product, its package; for produce or a generic food, a clear photo of the food itself). ' +
      'Kroger catalog photos are clean studio shots, so prefer one when it matches equally well. ' +
      'Avoid infographics, images with lots of text, people, recipes, dishes, collages, ads, logos alone, nutrition labels and screenshots.\n' +
      '2. ' + NAME_RULES + '\n\n' +
      'Reply with only the JSON, no other text: {"pick": <image number>, "name": "<name>", "size": "<size or empty>"}'
  }];
  const numbers = [];
  cands.forEach((o, i) => {
    const label = 'Image ' + (i + 1) + ' (' + (o.source === 'Kroger' ? 'Kroger catalog' : 'Google, ' + (o.source || 'web')) + '): ' +
      (o.cap || '') + (o.size ? ' | size: ' + o.size : '');
    if (!imgs[i]) { content.push({ type: 'text', text: label + ' [picture unavailable]' }); return; }
    numbers.push(i + 1);
    content.push({ type: 'text', text: label });
    content.push({ type: 'image', source: { type: 'base64', media_type: imgs[i].type, data: imgs[i].data } });
  });

  const { text, stop } = await callClaude(content, 1500, key);
  const out = parseJSON(text);
  if (out.pick == null && !/\d/.test(text)) throw new Error('no answer (stop: ' + stop + ') ' + text.slice(0, 80));
  const n = parseInt(out.pick != null ? out.pick : (text.match(/\d+/) || [])[0], 10);
  return {
    pick: numbers.includes(n) ? n - 1 : (numbers.length ? numbers[0] - 1 : null),
    name: tidy(out.name) || null,
    size: typeof out.size === 'string' ? tidy(out.size) : null
  };
}

const tidy = s => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, 80) : '');
function parseJSON(text) {
  try { return JSON.parse((text.match(/\{[\s\S]*\}/) || ['{}'])[0]); } catch (e) { return {}; }
}
const NAME_RULES =
  'Write the item name as it should appear on a tidy shopping list: fix spelling and capitalization, use the brand\'s own styling ' +
  '(e.g. "Chips Ahoy!", "Cosmic Crisp Apples", "Mountain Dew Baja Blast"), and keep the same level of detail they typed. ' +
  'Do not add a flavor, variety or brand they did not ask for. Leave the size out of the name.\n' +
  'For the size: if they typed one, normalize it (e.g. "20 oz" soda -> "20 fl oz"); otherwise use the package size of the pictured product when known; ' +
  'for loose produce or when unsure, use "".';

async function callClaude(content, maxTokens, key) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content }] })
  });
  if (!r.ok) {
    let detail = '';
    try { const e = await r.json(); detail = (e.error && (e.error.type + ': ' + e.error.message)) || ''; } catch (e) {}
    throw new Error('Claude ' + r.status + (detail ? ' ' + detail.slice(0, 160) : ''));
  }
  const d = await r.json();
  const text = (d.content || []).filter(c => c.type === 'text').map(c => c.text || '').join(' ');
  return { text, stop: d.stop_reason || '' };
}

async function claudeTidy(q, cap, size, key) {
  const text = await callClaude([{ type: 'text', text:
    'Someone typed "' + q + '" on our grocery list.' +
    (cap ? ' The picture we chose for it is: "' + cap + '"' + (size ? ' (size: ' + size + ')' : '') + '.' : '') + '\n' +
    NAME_RULES + '\nReply with only the JSON, no other text: {"name": "<name>", "size": "<size or empty>"}' }], 1000, key);
  const out = parseJSON(text.text);
  if (!tidy(out.name)) throw new Error('no name in reply (stop: ' + text.stop + ') ' + text.text.slice(0, 80));
  return { name: tidy(out.name) || null, size: typeof out.size === 'string' ? tidy(out.size) : null };
}

async function toBase64Image(src) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(src, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (grocery list picture helper)' } });
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
