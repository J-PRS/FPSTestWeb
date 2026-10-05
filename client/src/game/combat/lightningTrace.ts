import * as THREE from 'three';
import { LG_RANGE, LG_CHAIN_RANGE } from '../../core/config.js';
import { classCapsule } from '../../../../shared/botClasses.js';
import { segSolidHit } from '../../../../shared/solidWorld.js';
import { Projectile } from '../../projectiles/Projectile.js';
import type { CombatDeps } from '../combat.js';

// The honest hitscan ray family: terrain march + structure stop +
// target/player entry solves, plus the chain-fork pick. Both the damage
// tick AND the per-frame visual refresh run lgTrace — a stale tip
// between ticks is what detached the bolt on strafes.

// Ray scratch — exported: callers read _lgHit (contact), _lgO (eye) and
// _lgD (beam dir) straight after a trace.
export const _lgO = new THREE.Vector3();   // eye position — the honest ray
export const _lgD = new THREE.Vector3();
export const _lgHit = new THREE.Vector3();
const _lgP = new THREE.Vector3();   // terrain march point
const _lgTo = new THREE.Vector3();
const _lgTo2 = new THREE.Vector3(); // chain-pick scratch

// Chain pick — nearest OTHER live enemy within range of a contact point.
// Shared by the damage tick and the per-frame visual refresh so the arc
// and the damage always describe the same fork.
export function pickChain(deps: CombatDeps, from: THREE.Vector3, exclude: (typeof deps.targets)[number]): (typeof deps.targets)[number] | null {
  let best: (typeof deps.targets)[number] | null = null;
  let bestD2 = LG_CHAIN_RANGE * LG_CHAIN_RANGE;
  const cam = deps.lazyCamera();
  cam.getWorldDirection(_lgTo);
  for (const t of deps.targets) {
    if (t.dead || t === exclude) {continue;}
    // Front hemisphere only — a bolt can't arc backward through you,
    // and a fork to an enemy beside/behind draws a giant fan ACROSS
    // the view that reads as "the beam detached" (it did, sorta)
    _lgTo2.copy(t.pos).sub(cam.position);
    if (_lgTo2.dot(_lgTo) <= 0) {continue;}
    // Fork must continue FORWARD-ish along the bolt — a perpendicular
    // hop (bird overhead, enemy beside the contact) draws an arc into
    // the sky that reads as the beam detaching, not a chain
    _lgTo2.copy(t.pos).sub(from);
    if (_lgTo2.dot(_lgD) < _lgTo2.length() * 0.35) {continue;}
    const d2 = t.pos.distanceToSquared(from);
    if (d2 < bestD2) { bestD2 = d2; best = t; }
  }
  return best;
}

// Shared ray: eye + current camera forward → terrain march + nearest
// sphere hit. Both the damage tick AND the per-frame visual refresh run
// this — a stale tip between ticks is what detached the bolt on strafes.
export function lgTrace(deps: CombatDeps, cam: THREE.Camera, traceT: { t: number }): {
  hitT: number;
  hitTarget: (typeof deps.targets)[number] | null;
  hitPlayerId: string | null;
} {
  _lgO.copy(cam.position);
  cam.getWorldDirection(_lgD);

  // Terrain: march the ray in 1.5m steps until it goes under the heightmap,
  // then bisect the last step — the coarse march alone can leave the tip
  // buried ~1.5m inside a slope.
  let hitT = LG_RANGE;
  for (let d = 1.5; d <= LG_RANGE; d += 1.5) {
    _lgP.copy(_lgO).addScaledVector(_lgD, d);
    if (_lgP.y < deps.lazyTerrain().getHeight(_lgP.x, _lgP.z)) {
      let lo = d - 1.5, hi = d;
      for (let i = 0; i < 6; i++) {
        const mid = (lo + hi) * 0.5;
        _lgP.copy(_lgO).addScaledVector(_lgD, mid);
        if (_lgP.y < deps.lazyTerrain().getHeight(_lgP.x, _lgP.z)) {hi = mid;} else {lo = mid;}
      }
      hitT = lo; break;
    }
  }

  // Structures: the beam stops at walls — a bolt that could pierce a
  // base would splash targets inside it (server rejects those claims).
  if (Projectile.solidColliders.length) {
    _lgP.copy(_lgO).addScaledVector(_lgD, hitT);
    const sh = segSolidHit(_lgO, _lgP, Projectile.solidColliders);
    if (sh) {hitT *= sh.t;} // entry as a fraction of the current reach
  }

  // Targets: ray-vs-sphere, nearest wins — tip lands on the SURFACE entry
  // point (exact aim), never magnetized to the center
  const hitTarget = traceTargetHit(deps, hitT, traceT);
  hitT = traceT.t;
  const hitPlayerId = tracePlayerHit(deps, hitT, traceT);
  hitT = traceT.t;

  _lgHit.copy(_lgO).addScaledVector(_lgD, hitT);
  return { hitT, hitTarget, hitPlayerId };
}


function traceTargetHit(deps: CombatDeps, hitT: number, traceT: { t: number }): (typeof deps.targets)[number] | null {
  traceT.t = hitT;
  let hit: (typeof deps.targets)[number] | null = null;
  for (const t of deps.targets) {
    if (t.dead) {continue;}
    _lgTo.copy(t.pos).sub(_lgO);
    // Capsule bodies (totem): aim the test at the shaft's midpoint —
    // the feet-sphere misses a beam through the upper half entirely.
    if (t.capsuleTop) {_lgTo.y += t.capsuleTop * 0.5;}
    const proj = _lgTo.dot(_lgD);
    if (proj < 0 || proj > traceT.t) {continue;}
    const entry = sphereEntry(traceT.t, (t.hitRadius ?? t.radius) + 0.45, proj);
    if (entry !== null) { traceT.t = entry; hit = t; }
  }
  return hit;
}

function tracePlayerHit(deps: CombatDeps, hitT: number, traceT: { t: number }): string | null {
  traceT.t = hitT;
  let hitId: string | null = null;
  for (const [pid, rp] of deps.world.remotePlayers) {
    if (rp.isDead) {continue;}
    // Ray vs the class capsule (shared/botClasses — the same shape the
    // server validates). rp.position is eye height; the capsule axis runs
    // feet+R .. feet+HEIGHT−R below it.
    const entry = rayCapsuleEntry(rp.position, traceT.t, rp.armorClass);
    if (entry !== null) { traceT.t = entry; hitId = pid; }
  }
  return hitId;
}

/** Entry distance along _lgD for the player capsule at eyePos, or null.
 *  Closest-approach between the ray and the capsule's vertical axis
 *  segment, then back off the surface by sqrt(r²−d²) — the standard
 *  capsule-beam solve (exact for horizontal rays, ≤cm error for steep
 *  ones vs a true cylindrical cast). */
function rayCapsuleEntry(eyePos: THREE.Vector3, hitT: number, cls?: string): number | null {
  const cap = classCapsule(cls);
  const capPad = cap.radius + 0.2; // beam is thin but not needle-thin
  const yLo = eyePos.y - cap.eye + cap.radius;
  const axisH = (cap.height - 2 * cap.radius); // yLo .. yLo+axisH
  const wx = _lgO.x - eyePos.x;
  const wy = _lgO.y - yLo;
  const wz = _lgO.z - eyePos.z;
  const a = _lgD.y;                        // axis dir is (0,1,0) → only y matters
  const b = wx * _lgD.x + wy * _lgD.y + wz * _lgD.z; // w0·D (D normalized)
  const denom = a * a - 1;                 // −(Dx²+Dz²): 0 for a vertical ray
  // Unclamped line-line closest axis param, then clamp to the segment and
  // re-optimize the ray param for the clamped point.
  let s = denom < -1e-6 ? (b * a - wy) / denom : (a > 0 ? 0 : axisH);
  s = Math.min(Math.max(s, 0), axisH);
  let t = s * a - b;
  t = Math.min(Math.max(t, 0), hitT);
  s = Math.min(Math.max(t * a + wy, 0), axisH); // re-solve s for clamped t
  const px = _lgO.x + _lgD.x * t - eyePos.x;
  const py = _lgO.y + _lgD.y * t - (yLo + s);
  const pz = _lgO.z + _lgD.z * t - eyePos.z;
  const d2 = px * px + py * py + pz * pz;
  if (d2 >= capPad * capPad) {return null;}
  const entry = t - Math.sqrt(capPad * capPad - d2);
  return entry < hitT ? Math.max(entry, 0) : null;
}

// Ray-vs-sphere entry distance along _lgD for the to-target vector in
// _lgTo; null when the ray misses or the sphere sits behind the tip.
// Beam is thin but not needle-thin — callers pad the radius.
function sphereEntry(hitT: number, r: number, proj: number): number | null {
  const perp2 = _lgTo.lengthSq() - proj * proj;
  if (perp2 >= r * r) {return null;}
  const entry = proj - Math.sqrt(r * r - perp2); // surface, not center
  return entry < hitT ? Math.max(entry, 0) : null;
}

