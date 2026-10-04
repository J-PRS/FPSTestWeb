import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const namesOfBuf = (buf) => {
  try {
    const j = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString());
    return new Set(j.nodes.map(n => n.name));
  } catch { return null; }
};
const namesOf = (f) => { try { return namesOfBuf(fs.readFileSync(f)); } catch { return null; } };

// git-tracked GLBs: compare current vs pre-optimize (72fb5ef^)
const tracked = execSync('git ls-files "client/public/assets/**/*.glb"', { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
for (const f of tracked) {
  try {
    const old = execSync('git show 72fb5ef^:' + f.split(path.sep).join('/'), { encoding: null, maxBuffer: 64 * 1024 * 1024 });
    const a = namesOf(f), b = namesOfBuf(old);
    if (!a || !b) continue;
    const missing = [...b].filter(x => !a.has(x));
    if (missing.length) console.log('GIT', f, 'LOST:', missing.join(','));
  } catch { /* file not in that commit */ }
}
// gitignored files: compare vs dist snapshot (pre-optimize build)
const pub = 'client/public/assets/models', dist = 'client/dist/assets/models';
for (const f of fs.readdirSync(pub).filter(x => x.endsWith('.glb'))) {
  const a = namesOf(path.join(pub, f)), b = namesOf(path.join(dist, f));
  if (!a || !b) continue;
  const missing = [...b].filter(x => !a.has(x));
  if (missing.length) console.log('DIST', f, 'LOST:', missing.join(','));
}
console.log('done');
