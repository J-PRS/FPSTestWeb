// Live-scene geometry audit — the "is something rendered in an absurd
// place" check the line-streak bug demanded. Runs a scene traverse on
// demand (Alt+Q section 'visAudit', or the _tools/e2e/visaudit.ts probe)
// and flags primitives spanning impossible distances, NaN verts, and
// giant/orphaned instances. Terrain/sky/sprites legitimately span the
// world — only structures where a long edge is always wrong are checked.
import type * as THREE from 'three';
import { registerDiag } from './fxDiag';

// A legit trail/line segment is a few meters (a 200m/s projectile moves
// ~3m per 60fps sample). 60m flags teleports with slack below the
// ribbon guard's own trigger.
const SEG_LIMIT = 60;
const LIM2 = SEG_LIMIT * SEG_LIMIT;
// trailBatch slot layout: RIBBON_SAMPLES*2 verts per slot.
const SLOT_VERTS = 96;
const MAX_OFFENDERS = 20;

export interface VisOffender {
  tag: string;
  type: string;
  edge: number;
  at: number[];
  verts: number;
  nan: number;
  visible: boolean;
}

export interface VisAuditResult {
  scanned: number;
  offenders: VisOffender[];
  limit: number;
}

const tagOf = (o: THREE.Object3D) =>
  (o.userData?.probe?.kind as string) || (o.userData?.dbg?.kind as string) || (o.userData?.kind as string) || o.name || o.type;

export function auditScene(scene: THREE.Scene): VisAuditResult {
  const out: VisAuditResult = { scanned: 0, offenders: [], limit: SEG_LIMIT };

  scene.traverse((o) => {
    const geo = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    const pos = geo?.attributes?.position;
    const arr = pos?.array as ArrayLike<number> | undefined;
    if (!geo || !arr || arr.length === 0) {return;}
    o.updateWorldMatrix(true, false);
    const m = o.matrixWorld.elements;
    const X = (v: number) => m[0] * arr[v * 3] + m[4] * arr[v * 3 + 1] + m[8] * arr[v * 3 + 2] + m[12];
    const Y = (v: number) => m[1] * arr[v * 3] + m[5] * arr[v * 3 + 1] + m[9] * arr[v * 3 + 2] + m[13];
    const Z = (v: number) => m[2] * arr[v * 3] + m[6] * arr[v * 3 + 1] + m[10] * arr[v * 3 + 2] + m[14];
    let maxEdge = 0, nan = 0;
    let at = [0, 0, 0];
    const check = (a: number, b: number) => {
      const dx = X(a) - X(b), dy = Y(a) - Y(b), dz = Z(a) - Z(b);
      const e = dx * dx + dy * dy + dz * dz;
      if (!isFinite(e)) {nan += 1; return; }
      if (e > maxEdge) { maxEdge = e; at = [Math.trunc(X(a)), Math.trunc(Y(a)), Math.trunc(Z(a))]; }
    };

    const anyO = o as unknown as { isLine?: boolean; isLineSegments?: boolean; isInstancedMesh?: boolean; count?: number; instanceMatrix?: { array: ArrayLike<number> } };
    if (anyO.isLine || anyO.isLineSegments) {
      // Real segment pairs — the only honest measure for lines.
out.scanned += 1;
      const idx = geo.index ? geo.index.array : null;
      const nseg = idx ? idx.length / 2 : arr.length / 6;
      const step = Math.max(1, Math.floor(nseg / 2000));
      for (let s = 0; s < nseg; s += step) {
        check(idx ? idx[s * 2] : s * 2, idx ? idx[s * 2 + 1] : s * 2 + 1);
      }
    } else if (o.userData?.probe?.kind === 'trailBatch') {
      // Ribbon slots: only consecutive-sample edges within a quad matter.
out.scanned += 1;
      const nslot = Math.floor(arr.length / 3 / SLOT_VERTS);
      const dr = geo.drawRange ? geo.drawRange.count : Infinity;
      const usedSlots = Math.min(nslot, Math.floor(dr / ((SLOT_VERTS / 2 - 1) * 6)) + 1);
      for (let s = 0; s < usedSlots; s += 1) {
        const base = s * SLOT_VERTS;
        for (let i = 0; i < SLOT_VERTS / 2 - 1; i += 1) {check(base + i * 2, base + i * 2 + 2);}
      }
    } else if ((anyO as { isSkinnedMesh?: boolean }).isSkinnedMesh) {
      // Geometry is authored at bind pose — a stretched rig hides in the
      // BONES' world positions, so measure skeleton spread, not verts.
      // The 60m edge limit that catches trail teleports catches an
      // exploded skeleton identically.
      const skel = (o as unknown as { skeleton?: { bones: { updateWorldMatrix(a: boolean, b: boolean): void; matrixWorld: { elements: ArrayLike<number> } }[] } }).skeleton;
      if (!skel || skel.bones.length < 2) {return;}
out.scanned += 1;
      // matrixWorld.elements[12..14] — no Vector3 needed (THREE is a
      // type-only import in this file).
      const step = Math.max(1, Math.floor(skel.bones.length / 64));
      const px = (i: number) => { skel.bones[i].updateWorldMatrix(true, false); return skel.bones[i].matrixWorld.elements; };
      for (let i = 0; i < skel.bones.length; i += step) {
        const ea = px(i);
        for (let j = i + step; j < skel.bones.length; j += step) {
          const eb = px(j);
          const dx = ea[12] - eb[12], dy = ea[13] - eb[13], dz = ea[14] - eb[14];
          const e = dx * dx + dy * dy + dz * dz;
          if (!isFinite(e)) {nan += 1; continue; }
          if (e > maxEdge) { maxEdge = e; at = [Math.trunc(ea[12]), Math.trunc(ea[13]), Math.trunc(ea[14])]; }
        }
      }
    } else if (anyO.isInstancedMesh && anyO.instanceMatrix && anyO.count != null) {
      // Giant or off-field instances — matrix rows give scale+position.
out.scanned += 1;
      const im = anyO.instanceMatrix.array;
      for (let i = 0; i < (anyO.count ?? 0); i += 1) {
        const b = i * 16;
        const sx = Math.hypot(im[b], im[b + 1], im[b + 2]);
        if (!isFinite(sx)) {nan += 1; continue; }
        if (sx * sx > LIM2) {
          maxEdge = Math.max(maxEdge, sx * sx);
          at = [Math.trunc(im[b + 12]), Math.trunc(im[b + 13]), Math.trunc(im[b + 14])];
        }
      }
    } else {
      return; // terrain/sky/sprites legitimately span the world
    }

    if ((maxEdge > LIM2 || nan) && out.offenders.length < MAX_OFFENDERS) {
      out.offenders.push({
        tag: tagOf(o), type: o.type, edge: Number(Math.sqrt(maxEdge).toFixed(0)),
        at, verts: arr.length / 3, nan, visible: o.visible,
      });
    }
  });
  return out;
}

registerDiag('visAudit', () => {
  const scene = (window as unknown as { __test?: { scene?: THREE.Scene } }).__test?.scene;
  if (!scene) {return { visAudit: 'no scene' };}
  const r = auditScene(scene);
  return {
    visAudit: r.offenders.length > 0
      ? `${r.offenders.length} offenders / ${r.scanned} scanned: ${r.offenders.slice(0, 5).map(o => `${o.tag}@${o.edge}m`).join(', ')}`
      : `clean — ${r.scanned} objects scanned`,
  };
});
