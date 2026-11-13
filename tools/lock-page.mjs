// Encrypt a finished page for a locked folder:
//   node tools/lock-page.mjs path/to/plain.html mexico-vacation
// writes mexico-vacation/page.enc.json. Keep the plain HTML out of this repo (the repo is public).
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { lockPage } from '../shared/page-crypto.js';

const [src, folder] = process.argv.slice(2);
if (!src || !folder) { console.error('usage: node tools/lock-page.mjs <plain.html> <folder>'); process.exit(1); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = JSON.parse(await readFile(path.join(root, 'shared/page-key.pub.json'), 'utf8'));
const box = await lockPage(await readFile(src, 'utf8'), pub);
const out = path.join(root, folder, 'page.enc.json');
await writeFile(out, JSON.stringify(box) + '\n');
console.log('wrote', path.relative(root, out));
