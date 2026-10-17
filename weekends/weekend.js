// Weekend guides. Every word of a plan lives in Firestore (collection "weekends"), so the
// page source holds no plan content and only the signed-in allow-listed accounts can read it.
// A new weekend arrives as an encrypted seed.json next to its page; the key travels only in
// the setup link's #k=… fragment (never sent to the server, never committed), and the first
// signed-in open with that link decrypts it and writes it to Firestore once.
import { db, collection, doc, onSnapshot, updateDoc, runTransaction, serverTimestamp,
  startGate, denied, isDenied } from '/shared/firebase.js';

const COLL = 'weekends';

/* ---------- tiny DOM helper (text only, never innerHTML for data) ---------- */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const SVGNS = 'http://www.w3.org/2000/svg';
function icon(d) {
  const s = document.createElementNS(SVGNS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', d); p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '2.6'); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
  s.append(p); return s;
}
const I_CHECK = 'M5 12.5l4.5 4.5L19 7.5';
const I_NAV = 'M3 11l18-8-8 18-2-8-8-2z';

/* ---------- dates and times ---------- */
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function parseISO(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function todayISO() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function nowMins() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
function mins(t) { if (!t) return 9999; const [a, b] = t.split(':').map(Number); return a * 60 + b; }
function clock(t) {
  if (!t) return { t: '', ap: '' };
  let [a, b] = t.split(':').map(Number); const ap = a >= 12 ? 'pm' : 'am'; a = a % 12 || 12;
  return { t: `${a}:${String(b).padStart(2, '0')}`, ap };
}
function clockStr(t) { const c = clock(t); return c.t ? `${c.t} ${c.ap}` : ''; }
function rangeLabel(start, end) {
  const a = parseISO(start), b = parseISO(end || start);
  if (start === end || !end) return `${MON[a.getMonth()]} ${a.getDate()}`;
  if (a.getMonth() === b.getMonth()) return `${MON[a.getMonth()]} ${a.getDate()}–${b.getDate()}`;
  return `${MON[a.getMonth()]} ${a.getDate()} – ${MON[b.getMonth()]} ${b.getDate()}`;
}
function dayLabel(iso) { const d = parseISO(iso); return `${DOW[d.getDay()]}, ${MON[d.getMonth()]} ${d.getDate()}`; }
function inLabel(m) { if (m < 60) return `in ${m} min`; const hrs = Math.floor(m / 60), r = m % 60; return `in ${hrs} hr${r ? ' ' + r + ' min' : ''}`; }

/* ---------- maps ---------- */
function dirUrl(q) { return 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' + encodeURIComponent(q); }
function routeUrl(qs) {
  const list = qs.filter((q, i) => q && q !== qs[i - 1]);
  if (!list.length) return '';
  const dest = list[list.length - 1], way = list.slice(0, -1).slice(0, 9);
  let u = dirUrl(dest);
  if (way.length) u += '&waypoints=' + encodeURIComponent(way.join('|'));
  return u;
}

/* ---------- progress ---------- */
export function progress(w) {
  let done = 0, total = 0;
  for (const it of w.items || []) { total++; if (it.done) done++; }
  for (const t of w.todos || []) { total++; if (t.done) done++; }
  for (const d of w.week || []) for (const t of d.tasks || []) { total++; if (t.done) done++; }
  return { done, total };
}

const WHO = { A: 'Alaina', P: 'Puneeth' };
function whoBadge(w) { return WHO[w] ? h('span', { class: 'badge ' + w, text: WHO[w] }) : null; }
function uid(p) { return p + Math.random().toString(36).slice(2, 9); }

/* ---------- seed decryption ---------- */
function b64(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
async function decryptSeed(keyStr) {
  const res = await fetch('seed.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('The setup file for this weekend is missing.');
  const { iv, ct } = await res.json();
  const key = await crypto.subtle.importKey('raw', b64(keyStr), 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(iv) }, key, b64(ct));
  return JSON.parse(new TextDecoder().decode(plain));
}

/* =====================================================================
   One weekend
   ===================================================================== */
export function bootWeekend(id) {
  const ref = doc(db, COLL, id);
  const app = document.getElementById('app');
  const errEl = document.getElementById('err');
  let data = null, unsub = null, seeding = false, selDay = null, wx = null, wxLoaded = false;

  function showErr(e) { errEl.textContent = e ? (e.message || String(e)) : ''; }
  function save(field, value) {
    return updateDoc(ref, { [field]: value, updatedAt: serverTimestamp() }).catch(e => {
      showErr(isDenied(e) ? 'You don’t have access to change this.' : e);
    });
  }
  const placeById = pid => (data.places || []).find(p => p.id === pid);
  const itemsFor = day => (data.items || []).filter(i => i.day === day).sort((a, b) => mins(a.time) - mins(b.time));

  /* ----- weather (Open-Meteo, no key; only shown when the dates are in forecast range) ----- */
  async function loadWeather() {
    if (wxLoaded || !data.weather) return; wxLoaded = true;
    const w = data.weather;
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${w.lat}&longitude=${w.lon}` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code` +
      `&temperature_unit=fahrenheit&timezone=America%2FChicago&start_date=${data.start}&end_date=${data.end || data.start}`;
    try {
      const r = await fetch(u); if (!r.ok) return;
      const j = await r.json(); wx = j.daily; render();
    } catch (e) { /* weather is a nice-to-have */ }
  }
  function wxWord(c) {
    if (c === 0) return 'Clear'; if (c <= 2) return 'Partly cloudy'; if (c === 3) return 'Cloudy';
    if (c <= 48) return 'Fog'; if (c <= 57) return 'Drizzle'; if (c <= 67) return 'Rain';
    if (c <= 77) return 'Snow'; if (c <= 82) return 'Showers'; return 'Storms';
  }

  /* ----- up next ----- */
  function pickNext() {
    const t = todayISO(), days = data.days || [];
    if (!days.length) return null;
    if (t < data.start) {
      const first = itemsFor(days[0].id).find(i => !i.done);
      return first ? { item: first, label: `First up · ${days[0].name}` } : null;
    }
    const idx = days.findIndex(d => d.date === t);
    if (idx >= 0) {
      const todays = itemsFor(days[idx].id), cur = todays.find(i => !i.done);
      if (cur) {
        const gap = mins(cur.time) - nowMins();
        return { item: cur, label: gap > 0 ? `Next · ${inLabel(gap)}` : 'Now', current: true };
      }
      for (let k = idx + 1; k < days.length; k++) {
        const n = itemsFor(days[k].id).find(i => !i.done);
        if (n) return { item: n, label: `Today’s done · first up ${days[k].name}` };
      }
      return { done: true };
    }
    if (t > (data.end || data.start)) return { over: true };
    return null;
  }

  /* ----- render ----- */
  function render() {
    if (!data) return;
    const notesEl = document.getElementById('notes');
    const keepNotes = notesEl && document.activeElement === notesEl;
    const scrollY = window.scrollY;
    const days = data.days || [];
    if (!selDay || !days.some(d => d.id === selDay)) {
      const t = todayISO(); selDay = (days.find(d => d.date === t) || days[0] || {}).id;
    }
    document.title = `${rangeLabel(data.start, data.end)} · Weekend`;
    const pr = progress(data);
    const next = pickNext();

    const frag = document.createDocumentFragment();

    /* header */
    const wxRow = h('div', { class: 'wx' });
    if (wx && wx.time) wx.time.forEach((d, i) => {
      if (wx.temperature_2m_max[i] == null) return;
      wxRow.append(h('span', null, h('b', { text: DOW[parseISO(d).getDay()] }), ` ${Math.round(wx.temperature_2m_max[i])}° / ${Math.round(wx.temperature_2m_min[i])}° · ${wxWord(wx.weather_code[i])}` +
        (wx.precipitation_probability_max[i] >= 20 ? ` · ${wx.precipitation_probability_max[i]}% rain` : '')));
    });
    frag.append(h('header', { class: 'top wrap' },
      h('a', { class: 'back', href: '/weekends/', text: '← Weekends' }),
      h('p', { class: 'eyebrow', text: 'Weekend of' }),
      h('h1', { text: rangeLabel(data.start, data.end) }),
      data.title ? h('p', { class: 'title', text: data.title }) : null,
      data.summary ? h('p', { class: 'summary', text: data.summary }) : null,
      h('div', { class: 'statline' },
        h('div', { class: 'meter', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(pr.total), 'aria-valuenow': String(pr.done), 'aria-label': 'Weekend progress' },
          h('i', { style: `width:${pr.total ? Math.round(pr.done / pr.total * 100) : 0}%` })),
        h('span', { text: `${pr.done} of ${pr.total} done` })),
      (data.links || []).length ? h('div', { class: 'links' }, ...data.links.map(l => h('a', { href: l.href, text: l.label + ' →' }))) : null,
      wxRow.childNodes.length ? wxRow : null,
      renderNext(next)));

    /* section nav */
    frag.append(h('nav', { class: 'snav', 'aria-label': 'Sections' }, h('div', { class: 'wrap' },
      h('a', { href: '#plan', text: 'Timetable' }), h('a', { href: '#checklist', text: 'Checklist' }),
      (data.week || []).length ? h('a', { href: '#week', text: 'This week' }) : null,
      h('a', { href: '#places', text: 'Places' }), h('a', { href: '#notes-sec', text: 'Notes' }))));

    const main = h('div', { class: 'wrap' });
    main.append(renderPlan(days, next), renderChecklist(), renderWeek(), renderPlaces(), renderNotes(keepNotes ? notesEl.value : null));
    frag.append(main, h('footer', { class: 'wrap' }, 'Changes save right away and show up for both of you.'));

    if (keepNotes) {
      // Don't yank the notes box out from under someone typing: re-render around it.
      const old = notesEl; app.replaceChildren(frag);
      const fresh = document.getElementById('notes'); fresh.replaceWith(old); old.focus();
    } else app.replaceChildren(frag);
    window.scrollTo(0, scrollY);
  }

  function renderNext(n) {
    if (!n) return null;
    if (n.done) return h('div', { class: 'next alldone' }, h('p', { class: 'lab', text: 'All done' }), h('p', { class: 'what', text: 'Everything on the timetable is checked off. Nice weekend.' }));
    if (n.over) {
      const left = progress(data); const rest = left.total - left.done;
      return h('div', { class: 'next alldone' }, h('p', { class: 'lab', text: 'Weekend’s over' }),
        h('p', { class: 'what', text: rest ? `${rest} thing${rest === 1 ? '' : 's'} still open below.` : 'Everything got done.' }));
    }
    const it = n.item, pl = placeById(it.place);
    return h('div', { class: 'next', 'aria-live': 'polite' },
      h('p', { class: 'lab', text: n.label }),
      h('p', { class: 'when', text: clockStr(it.time) }),
      h('p', { class: 'what', text: it.title }),
      pl && pl.id !== 'home' ? h('p', { class: 'where', text: [pl.name, pl.addr].filter(Boolean).join(' · ') }) : null,
      it.drive ? h('p', { class: 'where drive', text: it.drive }) : null,
      it.note ? h('p', { class: 'note', text: it.note }) : null,
      h('div', { class: 'acts' },
        pl && pl.q ? h('a', { class: 'btn primary', href: dirUrl(pl.q), target: '_blank', rel: 'noopener' }, icon(I_NAV), 'Directions') : null,
        pl && !pl.q && pl.id !== 'home' ? h('button', { class: 'btn', type: 'button', onclick: () => editPlace(pl.id) }, 'Add address') : null,
        h('button', { class: 'btn', type: 'button', onclick: () => toggleItem(it.id) }, icon(I_CHECK), 'Done')));
  }

  function renderPlan(days, next) {
    const sec = h('section', { id: 'plan', 'aria-labelledby': 'plan-h' }, h('h2', { id: 'plan-h', text: 'Timetable' }),
      h('p', { class: 'hint', text: 'Tick each stop as you go. Tap “edit” to move a time or add an address.' }));
    const tabs = h('div', { class: 'tabs', role: 'tablist' });
    days.forEach(d => {
      const its = itemsFor(d.id), dn = its.filter(i => i.done).length;
      tabs.append(h('button', { class: 'tab', role: 'tab', type: 'button', 'aria-selected': String(d.id === selDay),
        onclick: () => { selDay = d.id; render(); } },
        h('span', { class: 'd', text: d.name }), h('span', { class: 's', text: `${dayLabel(d.date)} · ${dn}/${its.length}` })));
    });
    sec.append(tabs);
    const day = days.find(d => d.id === selDay);
    if (!day) return sec;
    const its = itemsFor(day.id);
    const route = routeUrl(its.map(i => (placeById(i.place) || {}).q || ''));
    sec.append(h('div', { class: 'daybar' }, h('p', { text: day.theme || '' }),
      h('div', { class: 'dayacts' },
        route ? h('a', { class: 'btn small', href: route, target: '_blank', rel: 'noopener' }, icon(I_NAV), `${day.name}’s route`) : null,
        h('button', { class: 'btn small', type: 'button', onclick: () => editItem(null, day.id) }, '+ Add stop'))));
    if (!its.length) { sec.append(h('p', { class: 'empty', text: 'Nothing planned yet.' })); return sec; }
    const ul = h('ol', { class: 'tl' });
    its.forEach(it => {
      const pl = placeById(it.place), c = clock(it.time);
      const isCur = next && next.current && next.item && next.item.id === it.id;
      ul.append(h('li', { class: (it.done ? 'done' : '') + (isCur ? ' cur' : '') },
        h('div', { class: 't' }, c.t, h('small', { text: c.ap })),
        h('div', { class: 'rail' }, h('button', { class: 'chk', type: 'button', 'aria-pressed': String(!!it.done), 'aria-label': (it.done ? 'Undo ' : 'Done: ') + it.title, onclick: () => toggleItem(it.id) }, icon(I_CHECK))),
        h('div', { class: 'body' },
          h('p', { class: 'ttl', text: it.title }),
          h('div', { class: 'meta' },
            it.fixed ? h('span', { class: 'badge fixed', text: 'Set time' }) : null,
            whoBadge(it.who),
            pl && pl.id !== 'home' ? h('span', { text: pl.name }) : null,
            pl && pl.id === 'home' ? h('span', { text: 'At home' }) : null,
            pl && pl.q ? h('a', { href: dirUrl(pl.q), target: '_blank', rel: 'noopener', text: 'Directions' }) : null,
            pl && !pl.q && pl.id !== 'home' ? h('button', { class: 'edit', type: 'button', onclick: () => editPlace(pl.id), text: 'add address' }) : null,
            it.drive ? h('span', { class: 'drive', text: it.drive }) : null,
            h('button', { class: 'edit', type: 'button', onclick: () => editItem(it.id), text: 'edit' })),
          it.note ? h('p', { class: 'note', text: it.note }) : null)));
    });
    sec.append(ul);
    return sec;
  }

  const DAYTAG = { sat: 'Sat', sun: 'Sun', fri: 'Fri', mon: 'Mon', week: 'This week' };
  function dayTag(d) { const f = (data.days || []).find(x => x.id === d); return f ? f.name.slice(0, 3) : (DAYTAG[d] || ''); }

  function renderChecklist() {
    const todos = data.todos || [];
    const groups = [...new Set(todos.map(t => t.group || 'Other'))];
    const sec = h('section', { id: 'checklist', 'aria-labelledby': 'cl-h' }, h('h2', { id: 'cl-h', text: 'Checklist' }),
      h('p', { class: 'hint', text: 'Everything on the list, grouped. Tap a line to edit it.' }));
    const grid = h('div', { class: 'groups' });
    groups.forEach(g => {
      const list = todos.filter(t => (t.group || 'Other') === g);
      const ul = h('ul', { class: 'checks' });
      list.forEach(t => ul.append(h('li', { class: t.done ? 'done' : '' },
        h('button', { class: 'chk', type: 'button', 'aria-pressed': String(!!t.done), 'aria-label': (t.done ? 'Undo ' : 'Done: ') + t.text, onclick: () => toggleTodo(t.id) }, icon(I_CHECK)),
        h('div', { class: 'txt', role: 'button', tabindex: '0', onclick: () => editTodo(t.id), onkeydown: e => { if (e.key === 'Enter') editTodo(t.id); } },
          h('span', { text: t.text }), ' ', whoBadge(t.who), t.note ? h('small', { text: t.note }) : null),
        t.day ? h('span', { class: 'pill', text: dayTag(t.day) }) : null)));
      const dn = list.filter(t => t.done).length;
      grid.append(h('div', { class: 'card' }, h('h3', null, g, h('span', { text: `${dn}/${list.length}` })), ul));
    });
    sec.append(grid);
    const inp = h('input', { id: 'newTodo', placeholder: 'Add to the list', autocomplete: 'off', 'aria-label': 'New checklist item' });
    const sel = h('select', { 'aria-label': 'Group' }, ...(groups.length ? groups : ['To do']).map(g => h('option', { value: g, text: g })));
    const add = () => { const v = inp.value.trim(); if (!v) return;
      save('todos', [...todos, { id: uid('t'), text: v, group: sel.value, who: 'both', day: '', note: '', done: false }]); inp.value = ''; };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    sec.append(h('div', { class: 'addrow' }, inp, sel, h('button', { class: 'btn', type: 'button', onclick: add, text: 'Add' })));
    return sec;
  }

  function renderWeek() {
    const week = data.week || [];
    if (!week.length) return document.createTextNode('');
    const sec = h('section', { id: 'week', 'aria-labelledby': 'wk-h' }, h('h2', { id: 'wk-h', text: 'Deep clean, spread over the week' }),
      h('p', { class: 'hint', text: 'One area a night, under an hour each, so it’s done before guests.' }));
    const grid = h('div', { class: 'week' });
    week.forEach(d => {
      const ul = h('ul', { class: 'checks' });
      (d.tasks || []).forEach(t => ul.append(h('li', { class: t.done ? 'done' : '' },
        h('button', { class: 'chk', type: 'button', 'aria-pressed': String(!!t.done), 'aria-label': (t.done ? 'Undo ' : 'Done: ') + t.text, onclick: () => toggleWeek(d.id, t.id) }, icon(I_CHECK)),
        h('div', { class: 'txt' }, h('span', { text: t.text })))));
      grid.append(h('div', { class: 'card' },
        h('h3', null, d.date ? dayLabel(d.date) : d.day, h('span', { text: d.mins ? `~${d.mins} min` : '' })),
        h('p', { class: 'wt', text: d.title }), ul));
    });
    sec.append(grid);
    return sec;
  }

  function renderPlaces() {
    const used = new Set((data.items || []).map(i => i.place));
    const places = (data.places || []).filter(p => p.id !== 'home');
    places.sort((a, b) => (used.has(b.id) - used.has(a.id)));
    const sec = h('section', { id: 'places', 'aria-labelledby': 'pl-h' }, h('h2', { id: 'pl-h', text: 'Places & directions' }),
      h('p', { class: 'hint', text: 'Directions open Google Maps from wherever you are.' }));
    const grid = h('div', { class: 'places' });
    places.forEach(p => grid.append(h('div', { class: 'card place' + (p.q ? '' : ' missing') },
      h('h4', { text: p.name }),
      p.addr ? h('p', { text: p.addr }) : null,
      p.hours ? h('p', null, h('b', { text: 'Hours: ' }), p.hours) : null,
      p.note ? h('p', { text: p.note }) : null,
      h('div', { class: 'acts' },
        p.q ? h('a', { class: 'btn small primary', href: dirUrl(p.q), target: '_blank', rel: 'noopener' }, icon(I_NAV), 'Directions') : null,
        h('button', { class: 'btn small', type: 'button', onclick: () => editPlace(p.id), text: p.q ? 'Edit' : 'Add address' })))));
    sec.append(grid);
    return sec;
  }

  let notesTimer = null;
  function renderNotes(val) {
    const ta = h('textarea', { id: 'notes', class: 'notes', placeholder: 'Anything to remember: confirmation times, sizes, who’s picking up what…', 'aria-labelledby': 'nt-h' });
    ta.value = val != null ? val : (data.notes || '');
    const saved = h('p', { class: 'saved', id: 'saved', 'aria-live': 'polite' });
    ta.addEventListener('input', () => {
      clearTimeout(notesTimer); document.getElementById('saved').textContent = 'Saving…';
      notesTimer = setTimeout(() => save('notes', ta.value).then(() => { const s = document.getElementById('saved'); if (s) s.textContent = 'Saved'; }), 700);
    });
    return h('section', { id: 'notes-sec' }, h('h2', { id: 'nt-h', text: 'Notes' }), ta, saved);
  }

  /* ----- changes ----- */
  function toggleItem(iid) {
    const items = structuredClone(data.items || []); const it = items.find(i => i.id === iid); if (!it) return;
    it.done = !it.done; save('items', items);
  }
  function toggleTodo(tid) {
    const todos = structuredClone(data.todos || []); const t = todos.find(x => x.id === tid); if (!t) return;
    t.done = !t.done; save('todos', todos);
  }
  function toggleWeek(did, tid) {
    const week = structuredClone(data.week || []); const d = week.find(x => x.id === did); const t = d && d.tasks.find(x => x.id === tid); if (!t) return;
    t.done = !t.done; save('week', week);
  }

  /* ----- dialogs ----- */
  const dlg = document.getElementById('dlg');
  function openDialog(title, fields, onSave, onDelete) {
    const form = h('form', { method: 'dialog' }, h('h3', { text: title }));
    const inputs = {};
    fields.forEach(f => {
      let el;
      if (f.type === 'select') el = h('select', { id: 'f_' + f.k }, ...f.options.map(([v, l]) => h('option', { value: v, text: l })));
      else if (f.type === 'textarea') el = h('textarea', { id: 'f_' + f.k });
      else if (f.type === 'checkbox') el = h('input', { id: 'f_' + f.k, type: 'checkbox' });
      else el = h('input', { id: 'f_' + f.k, type: f.type || 'text', autocomplete: 'off', placeholder: f.ph || '' });
      if (f.type === 'checkbox') el.checked = !!f.v; else el.value = f.v == null ? '' : f.v;
      if (f.required) el.required = true;
      inputs[f.k] = el;
      form.append(f.type === 'checkbox'
        ? h('div', { class: 'field' }, h('label', null, el, ' ', f.label))
        : h('div', { class: 'field' }, h('label', { for: 'f_' + f.k, text: f.label }), el));
    });
    form.append(h('div', { class: 'dacts' },
      onDelete ? h('button', { class: 'btn danger', type: 'button', onclick: () => { if (confirm('Delete this?')) { onDelete(); dlg.close(); } }, text: 'Delete' }) : null,
      h('span', { class: 'grow' }),
      h('button', { class: 'btn', type: 'button', onclick: () => dlg.close(), text: 'Cancel' }),
      h('button', { class: 'btn primary', type: 'submit', text: 'Save' })));
    form.addEventListener('submit', e => {
      e.preventDefault();
      const out = {}; for (const [k, el] of Object.entries(inputs)) out[k] = el.type === 'checkbox' ? el.checked : el.value.trim();
      onSave(out); dlg.close();
    });
    dlg.replaceChildren(form); dlg.showModal();
    const first = form.querySelector('input,select,textarea'); if (first) first.focus();
  }
  const WHO_OPTS = [['both', 'Both'], ['P', 'Puneeth'], ['A', 'Alaina']];

  function editItem(iid, dayId) {
    const it = iid ? (data.items || []).find(i => i.id === iid) : { day: dayId, time: '', title: '', place: '', who: 'both', note: '', fixed: false };
    const placeOpts = [['', 'No place'], ...(data.places || []).map(p => [p.id, p.name])];
    openDialog(iid ? 'Edit stop' : 'Add a stop', [
      { k: 'time', label: 'Time', type: 'time', v: it.time },
      { k: 'title', label: 'What', v: it.title, required: true },
      { k: 'place', label: 'Where', type: 'select', options: placeOpts, v: it.place },
      { k: 'who', label: 'Who', type: 'select', options: WHO_OPTS, v: it.who || 'both' },
      { k: 'note', label: 'Note', type: 'textarea', v: it.note },
      { k: 'fixed', label: 'Set time (an appointment that can’t move)', type: 'checkbox', v: it.fixed },
      { k: 'day', label: 'Day', type: 'select', options: (data.days || []).map(d => [d.id, d.name]), v: it.day },
    ], out => {
      const items = structuredClone(data.items || []);
      if (iid) Object.assign(items.find(i => i.id === iid), out);
      else items.push({ id: uid('i'), drive: '', done: false, ...out });
      save('items', items);
    }, iid ? () => save('items', (data.items || []).filter(i => i.id !== iid)) : null);
  }

  function editTodo(tid) {
    const t = (data.todos || []).find(x => x.id === tid); if (!t) return;
    const groups = [...new Set((data.todos || []).map(x => x.group || 'Other'))];
    openDialog('Edit item', [
      { k: 'text', label: 'Item', v: t.text, required: true },
      { k: 'group', label: 'Group', type: 'select', options: groups.map(g => [g, g]), v: t.group },
      { k: 'who', label: 'Who', type: 'select', options: WHO_OPTS, v: t.who || 'both' },
      { k: 'day', label: 'When', type: 'select', options: [['', 'Any time'], ...(data.days || []).map(d => [d.id, d.name]), ['week', 'This week']], v: t.day || '' },
      { k: 'note', label: 'Note', v: t.note },
    ], out => {
      const todos = structuredClone(data.todos || []); Object.assign(todos.find(x => x.id === tid), out); save('todos', todos);
    }, () => save('todos', (data.todos || []).filter(x => x.id !== tid)));
  }

  function editPlace(pid) {
    const p = (data.places || []).find(x => x.id === pid); if (!p) return;
    openDialog('Edit place', [
      { k: 'name', label: 'Name', v: p.name, required: true },
      { k: 'q', label: 'Address or name to search in Maps', v: p.q, ph: 'e.g. Labcorp, 123 Main St, New Braunfels' },
      { k: 'hours', label: 'Hours', v: p.hours },
      { k: 'note', label: 'Note', type: 'textarea', v: p.note },
    ], out => {
      const places = structuredClone(data.places || []); const t = places.find(x => x.id === pid);
      Object.assign(t, out); if (out.q && !t.addr) t.addr = out.q;
      save('places', places);
    });
  }

  /* ----- missing / seeding ----- */
  function showMissing(msg) {
    app.replaceChildren(h('div', { class: 'wrap top' },
      h('a', { class: 'back', href: '/weekends/', text: '← Weekends' }),
      h('h1', { text: 'Not set up yet' }),
      h('p', { class: 'summary', text: msg || 'This weekend hasn’t been loaded into your shared list yet. Open the setup link from Claude once, while signed in.' })));
  }
  async function seed(key) {
    const obj = await decryptSeed(key);
    await runTransaction(db, async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists()) tx.set(ref, { ...obj, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    });
    history.replaceState(null, '', location.pathname);
  }

  // Re-pick "up next" as the clock moves.
  setInterval(() => { if (data && document.body.dataset.auth === 'in' && !dlg.open) render(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && data && !dlg.open) render(); });

  startGate({
    onSignedIn() {
      if (unsub) unsub();
      unsub = onSnapshot(ref, { includeMetadataChanges: true }, snap => {
        if (snap.exists()) { data = snap.data(); showErr(''); render(); loadWeather(); return; }
        if (snap.metadata.fromCache) return; // wait for the server's answer
        const key = new URLSearchParams(location.hash.slice(1)).get('k');
        if (key && !seeding) {
          seeding = true;
          app.replaceChildren(h('div', { class: 'wrap top' }, h('p', { class: 'summary', text: 'Setting up this weekend…' })));
          seed(key).catch(e => { seeding = false; showMissing(isDenied(e) ? 'This account doesn’t have access.' : 'Couldn’t load the setup: ' + (e.message || e)); });
        } else if (!seeding) showMissing();
      }, err => { if (isDenied(err)) denied(); else showErr(err); });
    },
    onSignedOut() { if (unsub) { unsub(); unsub = null; } data = null; app.replaceChildren(); }
  });
}

/* =====================================================================
   The list of weekends
   ===================================================================== */
export function bootHub() {
  const list = document.getElementById('list');
  const errEl = document.getElementById('err');
  let unsub = null;
  function render(ws) {
    const t = todayISO();
    const up = ws.filter(w => (w.end || w.start) >= t).sort((a, b) => a.start < b.start ? -1 : 1);
    const past = ws.filter(w => (w.end || w.start) < t).sort((a, b) => a.start > b.start ? -1 : 1);
    const ul = h('ul', { class: 'wlist' });
    if (!ws.length) ul.append(h('li', { class: 'empty', text: 'No weekends yet.' }));
    const row = (w, tag) => {
      const p = progress(w);
      return h('li', null, h('a', { href: `/weekends/${w.id}/` },
        h('span', { class: 'dt', text: rangeLabel(w.start, w.end) }),
        h('span', { class: 'nm', text: w.title || 'Weekend' }),
        h('span', { class: 'sb' }, tag ? h('span', { class: 'tag' + (tag === 'Past' ? ' past' : ''), text: tag }) : null,
          h('span', { text: `${p.done} of ${p.total} done` }))));
    };
    up.forEach(w => ul.append(row(w, t >= w.start && t <= (w.end || w.start) ? 'This weekend' : 'Coming up')));
    if (past.length) { ul.append(h('li', null, h('h3', { text: 'Past weekends' }))); past.forEach(w => ul.append(row(w, 'Past'))); }
    list.replaceChildren(ul);
  }
  startGate({
    onSignedIn() {
      if (unsub) unsub();
      unsub = onSnapshot(collection(db, COLL), snap => {
        render(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      }, err => { if (isDenied(err)) denied(); else errEl.textContent = err.message || String(err); });
    },
    onSignedOut() { if (unsub) { unsub(); unsub = null; } list.replaceChildren(); }
  });
}
