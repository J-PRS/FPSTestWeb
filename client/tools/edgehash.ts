// Equivalence check: bake a weapon's geometries through vertexAO and hash
// the produced attributes. Run before/after a refactor to prove the
// output is byte-identical.
(globalThis as any).location ??= { search: '', href: 'http://x/' };
(globalThis as any).window ??= {};
(globalThis as any).window.location ??= (globalThis as any).location;
(globalThis as any).window.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
(globalThis as any).localStorage ??= (globalThis as any).window.localStorage;
// Wear-texture raster runs on a real canvas in the browser — here a stub
// is enough: only geometry attributes are hashed, texture pixels aren't.
(globalThis as any).document ??= {
  createElement: () => ({
    width: 0, height: 0,
    getContext: () => new Proxy({}, { get: (t, k) => (typeof k === 'string' && ['fillStyle','lineCap','globalAlpha','lineWidth','strokeStyle'].includes(k) ? undefined : () => {}), set: () => true }),
  }),
};

const { bakeVertexAO } = await import('../src/effects/vertexAO.js');
const { MODEL_BUILDERS } = await import('../src/entities/viewmodel/weaponsGeo.js');
import * as THREE from 'three';
import { createHash } from 'crypto';

const g = new THREE.Group();
for (const [, b] of MODEL_BUILDERS) g.add(b());
bakeVertexAO(g);
let h = createHash('sha256');
g.traverse((o: any) => {
  if (!o.isMesh) return;
  for (const name of Object.keys(o.geometry.attributes).sort()) {
    const a = o.geometry.getAttribute(name);
    h.update(name); h.update(Buffer.from(a.array.buffer, a.array.byteOffset, a.array.byteLength));
  }
});
console.log('ATTRHASH', h.digest('hex').slice(0, 32));
