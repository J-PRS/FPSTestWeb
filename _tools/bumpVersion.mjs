#!/usr/bin/env node
// Version bump for the client + server package manifests.
//
//   node _tools/bumpVersion.mjs             # patch: 0.1.3 -> 0.1.4 (CI default)
//   node _tools/bumpVersion.mjs --to 0.1.0  # pin an exact version
//   node _tools/bumpVersion.mjs --dry       # print the plan, write nothing
//
// One number for both halves on purpose: a client only speaks to a server
// of the same protocol, so a shared version keeps the pair readable.
// The client lockfile repeats the root version and npm ci compares it, so
// it is patched in the same pass; the pre-commit hook also refuses a
// package.json whose lockfile is not staged.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFESTS = ['server_bun/package.json', 'client/package.json'];
const LOCKFILES = ['client/package-lock.json'];

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const toIdx = args.indexOf('--to');
const pinned = toIdx >= 0 ? args[toIdx + 1] : null;

function parse(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
  if (!m) throw new Error(`"${v}" is not x.y.z`);
  return m.slice(1).map(Number);
}

function cmp(a, b) {
  const A = parse(a);
  const B = parse(b);
  for (let i = 0; i < 3; i++) {if (A[i] !== B[i]) {return A[i] - B[i];}}
  return 0;
}

function bumpPatch(v) {
  const [a, b, c] = parse(v);
  return `${a}.${b}.${c + 1}`;
}

function readManifest(rel) {
  const text = readFileSync(join(ROOT, rel), 'utf8');
  const m = /^ {2}"version": "([^"]+)"/m.exec(text);
  if (!m) {throw new Error(`${rel}: no top-level "version"`);}
  return { rel, text, version: m[1] };
}

const manifests = MANIFESTS.map(readManifest);
const highest = manifests.map(m => m.version).sort(cmp).at(-1);
const next = pinned ?? bumpPatch(highest);
parse(next);

for (const m of manifests) {
  const out = m.text.replace(/^( {2}"version": )"[^"]+"/m, `$1"${next}"`);
  console.log(`${m.rel}: ${m.version} -> ${next}`);
  if (!dry) {writeFileSync(join(ROOT, m.rel), out);}
}

for (const rel of LOCKFILES) {
  const text = readFileSync(join(ROOT, rel), 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lock = JSON.parse(text);
  // Round-trip must be byte-identical, or the rewrite would reformat the file.
  if (JSON.stringify(lock, null, 2).replace(/\n/g, eol) + eol !== text) {
    throw new Error(`${rel}: not npm-canonical JSON; refusing to rewrite`);
  }
  lock.version = next;
  lock.packages[''].version = next;
  console.log(`${rel}: root + packages[""] -> ${next}`);
  if (!dry) {writeFileSync(join(ROOT, rel), JSON.stringify(lock, null, 2).replace(/\n/g, eol) + eol);}
}
