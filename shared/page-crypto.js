// Encryption for "locked" pages (see README: Locked pages). Runs in the browser and in Node 22+.
// A page is encrypted to the site's public key (shared/page-key.pub.json), so anyone with the repo can
// lock a page, but only the private key, kept in Firestore for the approved accounts, can open one.
const b64u = {
  enc: bytes => btoa(Array.from(new Uint8Array(bytes), b => String.fromCharCode(b)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: str => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
};
const EC = { name: 'ECDH', namedCurve: 'P-256' };
const subtle = globalThis.crypto.subtle;

function aesKey(privateKey, publicKey, usage) {
  return subtle.deriveKey({ name: 'ECDH', public: publicKey }, privateKey, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

// pub: { kty, crv, x, y }. Returns the object to save as page.enc.json.
export async function lockPage(html, pub) {
  const sitePub = await subtle.importKey('jwk', pub, EC, false, []);
  const eph = await subtle.generateKey(EC, true, ['deriveKey']);
  const key = await aesKey(eph.privateKey, sitePub, 'encrypt');
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(html));
  const epk = await subtle.exportKey('jwk', eph.publicKey);
  return { v: 1, epk: { x: epk.x, y: epk.y }, iv: b64u.enc(iv), ct: b64u.enc(ct) };
}

// d: the private key's secret value (base64url). Throws if the key is wrong or the file was altered.
export async function unlockPage(box, pub, d) {
  const priv = await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y, d }, EC, false, ['deriveKey']);
  const ephPub = await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: box.epk.x, y: box.epk.y }, EC, false, []);
  const key = await aesKey(priv, ephPub, 'decrypt');
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: b64u.dec(box.iv) }, key, b64u.dec(box.ct));
  return new TextDecoder().decode(plain);
}
