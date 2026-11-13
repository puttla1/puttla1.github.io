// A locked page: the folder holds a small sign-in shell (index.html) and the real page as an
// encrypted page.enc.json. After Google sign-in this reads the site's private key from Firestore
// (only the approved accounts can), decrypts the page and shows it in place of the shell.
//
// One-time setup: the private key first travels in a link ending #k=…; the first signed-in open with
// that link saves it to Firestore. After that every locked page opens with sign-in alone.
import { db, doc, getDoc, setDoc, serverTimestamp, startGate, denied, isDenied } from '/shared/firebase.js';
import { unlockPage } from '/shared/page-crypto.js';

// Lives beside the weekend plans because that collection is already limited to the approved accounts.
const KEY_DOC = ['weekends', 'page-keys'];

export function bootLocked() {
  const msg = document.getElementById('lockmsg');
  const say = t => { if (msg) msg.textContent = t; };
  let started = false;

  async function json(url) {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error('Couldn’t load ' + url);
    return r.json();
  }

  async function open() {
    const linkKey = (location.hash.match(/[#&]k=([\w-]+)/) || [])[1] || null;
    const [pub, box, snap] = await Promise.all([
      json('/shared/page-key.pub.json'), json('page.enc.json'), getDoc(doc(db, ...KEY_DOC))
    ]);
    const saved = snap.exists() ? snap.data().d : null;
    if (!saved && !linkKey) { say('This page needs its one-time setup link. Open that link once, signed in, and it will work everywhere after.'); return; }

    let html;
    try { html = await unlockPage(box, pub, saved || linkKey); }
    catch (e) { say(saved ? 'Couldn’t unlock this page. It may need to be published again.' : 'That setup link doesn’t match this site.'); return; }

    if (!saved) await setDoc(doc(db, ...KEY_DOC), { kind: 'page-keys', d: linkKey, at: serverTimestamp() });
    if (linkKey) history.replaceState(null, '', location.pathname + location.search);

    document.open();
    document.write(html);
    document.close();
  }

  startGate({
    onSignedIn() {
      if (started) return;
      started = true;
      say('Opening…');
      open().catch(e => {
        started = false;
        if (isDenied(e)) denied(); else say('Couldn’t open this page: ' + (e.message || e));
      });
    },
    onSignedOut() { started = false; }
  });
}
