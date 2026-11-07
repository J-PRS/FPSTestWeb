// Merges both galleries' manifest.js into data.js for the combined UI.
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const here = dirname(fileURLToPath(import.meta.url));
const load = (rel) => {
  const src = readFileSync(join(here, rel, 'manifest.js'), 'utf8');
  return eval(src.replace('const MANIFEST =', 'const M=') + '; M');
};
writeFileSync(join(here, 'data.js'),
  'const DATA = ' + JSON.stringify({ vgs: load('../vgs_gallery'), announcer: load('../announcer_gallery') }) + ';\n');
console.log('data.js written');
