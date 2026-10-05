// NaN geometry sniffer. THREE only logs "computeBoundingSphere(): radius
// is NaN" and dumps the geometry — no owner, no call site. Patch the
// prototype once so a NaN radius triggers a scene walk that names the
// mesh/group chain holding the buffer (incl. userData.dbg probe tags),
// then surfaces every hit in the Alt+Q census via registerDiag.
import * as THREE from 'three';
import Logger from './Logger.js';
import { registerDiag } from './fxDiag.js';

interface NanHit {
  uuid: string;
  /** scene path Scene/…/Type(name) — '(detached)' when never added */
  owner: string;
  /** dbg probe tag kind, when the owner was markProbe'd */
  tag?: string;
  verts: number;
  /** attribute names present — 'position+normal' fingerprints the system */
  attrs: string;
  at: number; // seconds
  n: number;  // times this geometry computed NaN
}

const hits = new Map<string, NanHit>();
let scene: THREE.Scene | null = null;
let installed = false;

function pathOf(obj: THREE.Object3D): string {
  const parts: string[] = [];
  for (let o: THREE.Object3D | null = obj; o; o = o.parent) {
    parts.unshift(`${o.type}${o.name ? `(${o.name})` : ''}`);
  }
  return parts.join('/');
}

function reportNaN(geo: THREE.BufferGeometry): void {
  const pos = geo.getAttribute('position');
  const hit = hits.get(geo.uuid);
  if (hit) { hit.n++; return; }
  // Owner walk — NaN computes are rare (the error itself is once per
  // geometry per bounds miss), so a full traverse is fine here.
  let owner = '(detached)';
  let tag: string | undefined;
  try {
    scene?.traverse((o) => {
      const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
      if (g === geo) {
        owner = pathOf(o);
        tag = (o.userData.dbg as { kind?: string } | undefined)?.kind;
        throw STOP;
      }
    });
  } catch (e) {
    if (e !== STOP) throw e;
  }
  hits.set(geo.uuid, {
    uuid: geo.uuid.slice(0, 8),
    owner,
    tag,
    verts: pos ? pos.count : -1,
    attrs: Object.keys(geo.attributes).join('+'),
    at: Math.round(performance.now() / 1000),
    n: 1,
  });
  Logger.warn(`[geoNaN] ${owner}${tag ? ` tag=${tag}` : ''} uuid=${geo.uuid.slice(0, 8)} verts=${pos?.count ?? '?'} attrs=${Object.keys(geo.attributes).join('+')}`);
}

const STOP = new Error('geoNaN-stop');

/** Wire the watch — call once with the live scene. Re-calling with a new
 *  scene (room rebuild) just re-points the owner walk. */
export function installGeoNaNWatch(s: THREE.Scene): void {
  scene = s;
  if (installed) return;
  installed = true;
  const orig = THREE.BufferGeometry.prototype.computeBoundingSphere;
  THREE.BufferGeometry.prototype.computeBoundingSphere = function (this: THREE.BufferGeometry): void {
    orig.call(this);
    const r = this.boundingSphere?.radius;
    if (r !== undefined && r !== r) reportNaN(this); // NaN only
  };
  registerDiag('geoNaN', () => ({ geoNaN: [...hits.values()] }));
}
