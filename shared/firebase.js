// Shared Firebase setup for the list pages (to-do, grocery list).
// The config below is not a secret: access is enforced by the Firestore security rules,
// which only let the approved Google accounts read or write.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc, writeBatch, runTransaction, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyC5cboQtAIZw_FyNPccAoyL7UcECDB3FPA',
  authDomain: 'puneeth-alaina.firebaseapp.com',
  projectId: 'puneeth-alaina',
  storageBucket: 'puneeth-alaina.firebasestorage.app',
  messagingSenderId: '430292943650',
  appId: '1:430292943650:web:b994169bb6b8135a049b7b'
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Keep a copy on the device so the list opens instantly and works with bad signal in a store.
let db;
try {
  db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
} catch (e) {
  db = initializeFirestore(app, {});
}
export { db, collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc, writeBatch, runTransaction, serverTimestamp };

/*
  Sign-in gate. The page marks up these elements:
    [data-show="loading" | "out" | "in" | "denied"]  shown only in that state
    .js-signin, .js-signout (buttons), .who (filled with the signed-in email)
  and calls startGate({ onSignedIn(user), onSignedOut() }).
*/
function setState(s) { document.body.dataset.auth = s; }

export function denied() { setState('denied'); }

export function startGate({ onSignedIn, onSignedOut }) {
  setState('loading');
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  async function signIn() {
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      const code = e && e.code || '';
      if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
        await signInWithRedirect(auth, provider);
      } else if (code !== 'auth/popup-closed-by-user' && code !== 'auth/cancelled-popup-request') {
        alert('Sign-in didn’t work: ' + (e.message || code));
      }
    }
  }
  const out = () => signOut(auth);
  document.querySelectorAll('.js-signin').forEach(b => b.addEventListener('click', signIn));
  document.querySelectorAll('.js-signout').forEach(b => b.addEventListener('click', out));

  onAuthStateChanged(auth, user => {
    if (user) {
      document.querySelectorAll('.who').forEach(el => { el.textContent = user.email || ''; });
      setState('in');
      onSignedIn(user);
    } else {
      setState('out');
      if (onSignedOut) onSignedOut();
    }
  });
}

// True when a Firestore error means "this account isn't on the allowed list".
export function isDenied(err) { return !!err && err.code === 'permission-denied'; }
