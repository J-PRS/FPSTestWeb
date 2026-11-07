/* oxlint-disable typescript/no-explicit-any -- test stubs are deliberately loosely typed */
/* oxlint-disable vitest/no-conditional-in-test -- table/fuzz harness: branchy drives and ?? fallbacks ARE the test logic */
/**
 * Root-motion audit — every class body GLB's clips are checked for hip XZ
 * translation (root motion), the thing that drags the mesh out from under
 * the hitbox. Reports per-clip pre-strip drift (the profiling answer) and
 * asserts stripHipXZ leaves ~zero residual drift on every real track.
 *
 * GLBs are parsed raw (JSON + BIN chunks) so no renderer/DOM is needed.
 * Vexa runs cm-scale FBX exports, so drift is also reported normalized to
 * her in-game fit (drift × fitH/rawHeight = what the player sees).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { stripHipXZ } from '../entities/playerClipSurgery.js';
import { RIG_MANIFEST } from '../entities/playerClips.js';

const MODELS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/assets/models');

interface Glb { json: any; bin: Buffer; }

function parseGlb(file: string): Glb {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46_54_6C_67) {throw new Error(`${file}: not a GLB`);}
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const off = 20 + jsonLen;
  const binLen = buf.readUInt32LE(off);
  const bin = buf.subarray(off + 8, off + 8 + binLen);
  return { json, bin };
}

const N_OF = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 } as Record<string, number>;

function accessor(g: Glb, i: number): Float32Array {
  const a = g.json.accessors[i];
  if (a.componentType !== 5126) {throw new Error(`accessor ${i}: componentType ${a.componentType}`);}
  const n = N_OF[a.type] || 1;
  // Spec: an accessor without bufferView is all-zero (gltf-transform emits
  // this for degenerate single-keyframe constant tracks).
  if (a.bufferView === undefined) {return new Float32Array(a.count * n);}
  const bv = g.json.bufferViews[a.bufferView];
  const byteOff = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const src = g.bin.buffer.slice(g.bin.byteOffset + byteOff, g.bin.byteOffset + byteOff + a.count * n * 4);
  return new Float32Array(src);
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Same rule PlayerModel computes: ancestor chain of the shallowest skin
 *  joint, plus the static hip names — the carriers of baked root motion. */
function rootMotionNodes(g: Glb): Set<string> {
  const parents = new Map<number, number>();
  (g.json.nodes || []).forEach((n: any, i: number): void => {
    for (const c of n.children || []) {parents.set(c, i);}
  });
  const depth = (i: number): number => { let d = 0; for (let p = parents.get(i); p !== undefined; p = parents.get(p)) {d += 1;} return d; };
  const set = new Set<string>();
  for (const skin of g.json.skins || []) {
    let root: number | null = null, rd = Infinity;
    for (const j of skin.joints) {
      const d = depth(j);
      if (d < rd) { root = j; rd = d; }
    }
    for (let n = root; n !== null; n = parents.get(n) ?? null) {
      const nm = g.json.nodes[n]?.name;
      if (nm) {set.add(norm(nm));}
    }
  }
  for (const b of ['defhips', 'root', 'hips', 'bone']) {set.add(b);}
  return set;
}

function isRootCarrier(nodeName: string, roots: Set<string>): boolean {
  const n = norm(nodeName);
  return roots.has(n) || n.endsWith('pelvis');
}

interface Drift { clip: string; node: string; track: THREE.VectorKeyframeTrack; preMax: number; postMax: number; }

function xzMax(v: Float32Array | number[]): number {
  const [x0, , z0] = v;
  let m = 0;
  for (let i = 0; i < v.length; i += 3) {m = Math.max(m, Math.hypot(v[i] - x0, v[i + 2] - z0));}
  return m;
}

function clipDrifts(g: Glb, roots: Set<string>): Drift[] {
  const out: Drift[] = [];
  const nodes = g.json.nodes || [];
  for (const anim of g.json.animations || []) {
    for (const ch of anim.channels) {
      if (ch.target.path !== 'translation') {continue;}
      const nodeName = nodes[ch.target.node]?.name || `node${  ch.target.node}`;
      if (!isRootCarrier(nodeName, roots)) {continue;}
      const s = anim.samplers[ch.sampler];
      const times = accessor(g, s.input);
      const vals = accessor(g, s.output);
      // Some exports ship a translation channel with zero keys — no
      // motion to pin; GLTFLoader skips it and so should we.
      if (times.length === 0 || vals.length === 0) {continue;}
      const track = new THREE.VectorKeyframeTrack(`${nodeName  }.position`, Array.from(times), Array.from(vals));
      const clip = new THREE.AnimationClip(anim.name, -1, [track]);
      const preMax = xzMax(vals);
      stripHipXZ(clip, roots);
      const postMax = xzMax(track.values);
      out.push({ clip: anim.name, node: nodeName, track, preMax, postMax });
    }
  }
  return out;
}

function rawHeight(g: Glb): number {
  let max = 0;
  for (const n of g.json.nodes || []) {
    const t = n.translation;
    if (t && t[1] > max) {([, max] = t);}
  }
  return max || 1;
}

const BODIES: [file: string, fitH: number][] = [
  ['class_light.glb', 1.89],
  ['class_medium.glb', 2.2],
  ['class_heavy.glb', 2.76],
];

// Native anims tables must name real clips — a typo'd entry silently
// leaves the previous action running (or bind-poses on first request).
// Clips can live in the class GLB or any of the variant's retarget sources.
describe('class anims tables resolve to real clips', (): void => {
  const SRC_FILES: Record<string, string> = { ual1: 'robot-anims.glb', ual2: 'robot-anims2.glb', kevdev: 'kevdev-anims.glb', mannequin: 'mannequin.glb' };
  const names = (variant: string): Set<string> => {
    const rig = RIG_MANIFEST[variant]!;
    const out = new Set<string>();
    for (const f of [path.basename(rig.url), 'class_scout.glb', ...rig.sources.map((s): string => SRC_FILES[s]!)]) {
      const g = parseGlb(path.join(MODELS_DIR, f));
      for (const a of (g.json.animations || []) as { name: string }[]) {out.add(a.name); out.add(`UAL_${a.name}`);}
    }
    return out;
  };
  for (const [variant, rig] of Object.entries(RIG_MANIFEST)) {
    if (!rig.anims) {continue;}
    // oxlint-disable-next-line valid-title -- table-driven titles name the variant under test
    it(variant, (): void => {
      const avail = names(variant);
      for (const [state, clip] of Object.entries(rig.anims!)) {
        expect(avail.has(clip!), `${variant} ${state} → '${clip}'`).toBe(true);
      }
    });
  }
});

describe('class body root motion', (): void => {
  for (const [file, fitH] of BODIES) {
    it(`${file  } — every root track is pinned by stripHipXZ`, (): void => {
      const g = parseGlb(path.join(MODELS_DIR, file));
      const drifts = clipDrifts(g, rootMotionNodes(g));
      const scale = fitH / rawHeight(g);
      for (const d of drifts) {
        console.log(`  ${file} ${d.clip} :: ${d.node} raw drift ${d.preMax.toFixed(3)} raw-units (in-game ~${(d.preMax * scale).toFixed(3)}m)`);
      }
      // Exports with no nonzero root-carrier keys pin vacuously — the
      // drift contract only applies where motion data exists.
      if (drifts.length === 0) {return;}
      for (const d of drifts) {
        expect(d.postMax, `${file} ${d.clip} ${d.node} residual drift`).toBeLessThan(1e-6);
      }
    });
  }

  it('stripHipXZ pins Vexa Base_HumanPelvis XZ (the regression)', (): void => {
    const clip = new THREE.AnimationClip('run', 1, [
      new THREE.VectorKeyframeTrack('Base_HumanPelvis.position', [0, 1], [0, 1, 0, 5, 1.2, 3]),
    ]);
    stripHipXZ(clip);
    const v = clip.tracks[0].values;
    expect(v[3]).toBe(0);
    expect(v[5]).toBe(0);
    expect(v[4]).toBeCloseTo(1.2, 5); // Y bob survives
  });
});
