import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { execSync } from 'child_process';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const files = execSync('git status --short public', { cwd: process.cwd(), encoding: 'utf8' })
  .split('\n').filter(l => l.includes('.glb')).map(l => l.slice(3).trim()).filter(Boolean);
const stat = (d: any) => ({
  s: d.getRoot().listSkins().length,
  j: d.getRoot().listSkins().reduce((a: number, x: any) => a + x.listJoints().length, 0),
  a: d.getRoot().listAnimations().length,
  ch: d.getRoot().listAnimations().reduce((a: number, x: any) => a + x.listChannels().length, 0),
  n: d.getRoot().listNodes().length,
  m: d.getRoot().listMeshes().length,
});
let bad = 0;
for (const f of files) {
  try {
    const orig = execSync('git show HEAD:./' + f.split('\\').join('/'), { cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 });
    const d0 = await io.readBinary(new Uint8Array(orig));
    const d1 = await io.read(f);
    const a = stat(d0), b = stat(d1);
    const diff = Object.keys(a).filter(k => (a as any)[k] !== (b as any)[k]);
    if (diff.length) { bad++; console.log('DIFF', f, JSON.stringify(a), '->', JSON.stringify(b)); }
    else console.log('ok  ', f);
  } catch (e: any) { console.log('SKIP', f, String(e.message).slice(0, 80)); }
}
console.log('checked', files.length, 'bad', bad);
