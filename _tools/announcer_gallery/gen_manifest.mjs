// Builds manifest.json: { chord, text } × available generator dirs.
// Run after renderers: node gen_manifest.mjs
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const lines = JSON.parse(readFileSync(join(here, 'lines.json'), 'utf8')).lines;
const gens = {};
for (const dir of readdirSync(join(here, 'out'))) {
  const files = readdirSync(join(here, 'out', dir)).filter(f => /\.(wav|mp3)$/.test(f));
  if (files.length) gens[dir] = Object.fromEntries(files.map(f => [f.replace(/\.\w+$/, ''), f]));
}
writeFileSync(join(here, 'manifest.js'), 'const MANIFEST = ' + JSON.stringify({ lines, gens }) + ';\n');
console.log(Object.keys(gens).length + ' generators, ' + lines.length + ' lines');
