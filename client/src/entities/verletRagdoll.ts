// verletRagdoll — Jakobsen point/constraint ragdoll for our skinned rigs.
// One point mass per major bone, distance sticks rebuild the skeleton,
// the floor clamps to the rendered terrain. Write-back rotates each
// mapped bone so the direction to its simulated parent matches — limb
// positions come free through the parent chain. No physics dep.
import * as THREE from 'three';
import { GRAVITY } from '../core/config.js';
import type { Terrain } from '../world/terrain.js';

const norm = (n: string): string => n.toLowerCase().replace(/[^a-z0-9]/g, '');

type Slot = 'pelvis' | 'spine' | 'neck' | 'head' | 'uarm' | 'larm' | 'hand' | 'thigh' | 'shin' | 'foot';
// Tested against the side-stripped name — normalized rig names append
// l/r AFTER the slot word ('upperarml', 'thighl', 'calf_l'→'calfl').
const SLOT_RE: [Slot, RegExp][] = [
  ['pelvis', /(pelvis|hips)$/],
  ['neck', /neck\d*$/],
  ['head', /head\d*$/],
  ['uarm', /(upperarm|upper_arm|shoulder)\d*$/],
  ['larm', /(forearm|lowerarm|lower_arm)\d*$/],
  ['hand', /(hand|palm\d*)$/],
  ['thigh', /(thigh|upperleg|upper_leg)\d*$/],
  ['shin', /(shin|calf|lowerleg|lower_leg)\d*$/],
  ['foot', /foot\d*$/],
  ['spine', /(spine\d*|abdomen|torso\d*|chest|ribcage)$/],
];
const sideOf = (n: string): string =>
  /left|l$/.test(n) ? 'l' : /right|r$/.test(n) ? 'r'
    : /^l(?!ower)/.test(n) ? 'l' : /^r(?!ight)/.test(n) ? 'r' : '';
const SIDE_STRIP = /(left|right|l|r)$/;

interface Link {
  bone: THREE.Bone; idx: number; parentIdx: number;
  parentObj: THREE.Object3D; // mapped ancestor, or the nearest unmapped ancestor for the root
  restDir: THREE.Vector3; restQ: THREE.Quaternion;
  depth: number; rootInv?: THREE.Matrix4;
}

export class VerletRagdoll {
  private pts: { pos: THREE.Vector3; prev: THREE.Vector3 }[] = [];
  private sticks: { a: number; b: number; len: number }[] = [];
  private links: Link[] = [];
  private readonly _wq = new Map<THREE.Object3D, THREE.Quaternion>();
  private readonly _v = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();
  private readonly _q2 = new THREE.Quaternion();
  private readonly _m = new THREE.Matrix4();
  /** Seconds below move threshold — caller hides the corpse when this rests. */
  still = 0;
  /** Corpse removal: once settled, slide under the terrain and only then
   *  hide — a pop reads worse than a slow sink. */
  private sinking = false;
  private sinkT = 0;
  startSink(): void { this.sinking = true; }
  /** Fully submerged — the caller's cue to actually hide the model. */
  get gone(): boolean { return this.sinkT > 2.5; }

  /** bones = deduped skeleton bones; vel = corpse launch velocity (seeds momentum). */
  constructor(bones: THREE.Bone[], vel: THREE.Vector3, seedDt = 1 / 30) {
    const boneIdx = new Map<THREE.Bone, number>();
    const keyed = new Map<string, number>(); // slot+side → point index (first skin wins)
    const boneSlot = new Map<THREE.Bone, string>();
    const depthOf = (b: THREE.Object3D): number => { let d = 0, o: THREE.Object3D | null = b; while (o.parent) { d += 1; o = o.parent; } return d; };
    for (const b of bones) {
      const n = norm(b.name);
      // Mid-name side probe for rigs that prefix the letter before the
      // limb word (Base_HumanLUpperArm) — both arms else collide on one key.
      const side = sideOf(n)
        || (/l(?=(upper|lower|fore|thigh|shin|calf|foot|hand))/.test(n) ? 'l' : '')
        || (/r(?=(upper|lower|fore|thigh|shin|calf|foot|hand))/.test(n) ? 'r' : '');
      const base = side ? n.replace(SIDE_STRIP, '') : n;
      const slot = SLOT_RE.find(([, re]) => re.test(base));
      if (!slot) {continue;}
      const key = slot[0] + side;
      if (keyed.has(key)) {continue;} // multi-skin rigs duplicate bone names
      keyed.set(key, this.pts.length);
      boneIdx.set(b, this.pts.length);
      boneSlot.set(b, key);
      const pos = b.getWorldPosition(new THREE.Vector3());
      this.pts.push({ pos, prev: pos.clone().addScaledVector(vel, -seedDt) });
    }
    if (this.pts.length < 5) {this.pts.length = 0; return;} // unmapped rig — caller falls back
    for (const [b, idx] of boneIdx) {
      // Nearest mapped ancestor = the stick parent. The chain rebuilds
      // itself — unmapped bones just ride their parent's transform.
      let anc: THREE.Object3D | null = b.parent, pIdx = -1;
      while (anc) { const i = boneIdx.get(anc as THREE.Bone); if (i !== undefined) { pIdx = i; break; } anc = anc.parent; }
      const parentObj = anc ?? b.parent!;
      const pw = pIdx >= 0 ? this.pts[pIdx]!.pos : parentObj.getWorldPosition(new THREE.Vector3());
      const link: Link = {
        bone: b, idx, parentIdx: pIdx, parentObj,
        restDir: this.pts[idx]!.pos.clone().sub(pw).normalize(),
        restQ: b.getWorldQuaternion(new THREE.Quaternion()),
        depth: depthOf(b),
      };
      if (pIdx >= 0) {this.sticks.push({ a: pIdx, b: idx, len: this.pts[pIdx]!.pos.distanceTo(this.pts[idx]!.pos) || 0.01 });}
      else {link.rootInv = parentObj.matrixWorld.clone().invert();} // root (pelvis): world→local for position write-back
      this.links.push(link);
    }
    this.links.sort((a, z) => a.depth - z.depth);
  }

  get valid(): boolean { return this.pts.length > 0; }

  step(dt: number, terrain: Terrain | null): void {
    if (dt <= 0 || !this.pts.length) {return;}
    if (this.sinking) {
      // Slow slide under the surface — no relax, no ground clamp (it
      // would fight the sink); prev tracks pos so nothing flips on exit.
      this.sinkT += dt;
      for (const p of this.pts) { p.pos.y -= 0.55 * dt; p.prev.y = p.pos.y; }
      return;
    }
    const dt2 = dt * dt;
    let moved = 0;
    for (const p of this.pts) {
      const px = p.pos.x, py = p.pos.y, pz = p.pos.z;
      p.pos.x += (p.pos.x - p.prev.x) * 0.99;
      p.pos.y += (p.pos.y - p.prev.y) * 0.99 + GRAVITY * dt2;
      p.pos.z += (p.pos.z - p.prev.z) * 0.99;
      p.prev.set(px, py, pz);
      moved += Math.abs(p.pos.x - px) + Math.abs(p.pos.y - py) + Math.abs(p.pos.z - pz);
    }
    for (let i = 0; i < 6; i += 1) {
      for (const s of this.sticks) {
        const a = this.pts[s.a]!.pos, b = this.pts[s.b]!.pos;
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const d = Math.hypot(dx, dy, dz) || 1e-4;
        const k = (s.len - d) / d * 0.5;
        a.x -= dx * k; a.y -= dy * k; a.z -= dz * k;
        b.x += dx * k; b.y += dy * k; b.z += dz * k;
      }
      for (const p of this.pts) {
        const gy = terrain ? terrain.getRenderedHeight(p.pos.x, p.pos.z) : 0;
        if (Number.isFinite(gy) && p.pos.y < gy + 0.3) {p.pos.y = gy + 0.3;}
      }
    }
    this.still = moved / this.pts.length < 0.004 ? this.still + dt : 0;
  }

  /** World quat of obj's parent — sim results win, unmapped ancestors chain off their local pose. */
  private parentWorldQ(obj: THREE.Object3D): THREE.Quaternion {
    const p = obj.parent;
    if (!p) {return this._q2.identity();}
    const hit = this._wq.get(p);
    if (hit) {return hit;}
    const q = this.parentWorldQ(p).clone().multiply(p.quaternion);
    this._wq.set(p, q);
    return q;
  }

  /** Rotate mapped bones so parent→child directions match the sim. Call
   *  AFTER the anim update so our writes win the frame. */
  apply(): void {
    this._wq.clear();
    for (const l of this.links) {
      let dir: THREE.Vector3;
      if (l.parentIdx >= 0) {
        dir = this._v.copy(this.pts[l.idx]!.pos).sub(this.pts[l.parentIdx]!.pos);
        if (dir.lengthSq() < 1e-6) {dir.copy(l.restDir);}
        dir.normalize();
      } else {dir = this._v.copy(l.restDir);}
      const wq = this._q.setFromUnitVectors(l.restDir, dir).multiply(l.restQ).clone();
      this._wq.set(l.bone, wq);
      const pq = this.parentWorldQ(l.bone);
      l.bone.quaternion.copy(pq.invert()).multiply(wq);
      if (l.rootInv) { // pelvis also translates — it anchors the whole body
        l.bone.position.copy(this.pts[l.idx]!.pos).applyMatrix4(l.rootInv);
      }
    }
    this.links[0]?.bone.updateMatrixWorld();
  }
}

/** Loose-prop drop — the held gun detaches to world space and arcs free
 *  on a point-mass bounce, so a ragdolled corpse doesn't keep a glued
 *  weapon. The pivot wraps it at the bounding-box CENTER — spinning the
 *  group origin (the grip) reads as orbiting, not tumbling.
 *  restore() puts it back in the hand on respawn. */
export class GunDrop {
  private readonly vel = new THREE.Vector3();
  private readonly ang = new THREE.Vector3();
  private readonly pivot = new THREE.Object3D();
  private readonly _v = new THREE.Vector3();
  private readonly home: { parent: THREE.Object3D; pos: THREE.Vector3; quat: THREE.Quaternion; scale: THREE.Vector3 };
  constructor(private readonly obj: THREE.Object3D, sceneRoot: THREE.Object3D, vel: THREE.Vector3) {
    this.home = { parent: obj.parent!, pos: obj.position.clone(), quat: obj.quaternion.clone(), scale: obj.scale.clone() };
    // attach() reads matrixWorld — both trees must be fresh or the gun
    // snaps to a stale spot (proxy reparents run between renders).
    obj.updateWorldMatrix(true, false);
    sceneRoot.updateWorldMatrix(true, true);
    const center = new THREE.Box3().setFromObject(obj).getCenter(new THREE.Vector3());
    sceneRoot.add(this.pivot);
    // position is LOCAL — convert the world-space bbox center through the
    // parent or the pivot lands on an invisible offset and the gun orbits it.
    this.pivot.position.copy(sceneRoot.worldToLocal(center));
    this.pivot.attach(obj);
    this.vel.copy(vel).multiplyScalar(0.5); this.vel.y += 1.5; // nudge free, not a launch
    this.ang.set(Math.random() * 3 - 1.5, Math.random() * 3 - 1.5, Math.random() * 3 - 1.5);
  }
  step(dt: number, terrain: Terrain | null): void {
    this.vel.y += GRAVITY * dt;
    const p = this.pivot;
    // World-space sim — the pivot may sit under a transformed parent, so
    // local coords would double-apply that transform on the floor check.
    const w = p.getWorldPosition(this._v).addScaledVector(this.vel, dt);
    p.rotation.x += this.ang.x * dt; p.rotation.y += this.ang.y * dt; p.rotation.z += this.ang.z * dt;
    const gy = (terrain ? terrain.getRenderedHeight(w.x, w.z) : 0) + 0.15;
    if (w.y < gy) {w.y = gy; this.vel.y *= -0.25; this.vel.x *= 0.5; this.vel.z *= 0.5; this.ang.multiplyScalar(0.4);}
    p.position.copy(p.parent!.worldToLocal(w));
    // Air drag on the spin — unclamped rad/s tumble reads chaotic.
    this.ang.multiplyScalar(Math.max(0, 1 - dt));
  }
  restore(): void {
    const h = this.home;
    this.pivot.removeFromParent();
    h.parent.add(this.obj);
    this.obj.position.copy(h.pos); this.obj.quaternion.copy(h.quat); this.obj.scale.copy(h.scale);
  }
}

/** Deduped bone list across all skinned meshes under a model root. */
export function collectBones(root: THREE.Object3D): THREE.Bone[] {
  const seen = new Set<THREE.Bone>(), out: THREE.Bone[] = [];
  root.traverse((o): void => {
    const sk = o as THREE.SkinnedMesh;
    if (sk.isSkinnedMesh) {for (const b of sk.skeleton.bones) {if (!seen.has(b)) {seen.add(b); out.push(b);}}}
  });
  return out;
}
