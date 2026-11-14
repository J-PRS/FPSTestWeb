import * as THREE from 'three';
import { LG_RANGE, LG_CHAIN_RANGE, LG_BOUNCE_RANGE } from '../../core/config.js';
import { classCapsule } from '../../../../shared/botClasses.js';
import { segSolidHit } from '../../../../shared/solidWorld.js';
import { Projectile } from '../../projectiles/Projectile.js';
import type { CombatDeps } from '../combat.js';

// The honest hitscan ray family: terrain march + structure stop +
// target/player entry solves, plus the chain-fork pick. Both the damage
// tick AND the per-frame visual refresh run lgTrace - a stale tip
// between ticks is what detached the bolt on strafes.

// Ray scratch - exported: callers read _lgHit (contact), _lgO (eye) and
// _lgD (beam dir) straight after a trace.
export const _lgO = new THREE.Vector3();   // eye position - the honest ray
export const _lgD = new THREE.Vector3();
export const _lgHit = new THREE.Vector3();
export const _lgBend = new THREE.Vector3(); // terrain-bounce corner, when bounced
const _lgD2 = new THREE.Vector3(); // bounce-pick scratch
const _lgGhost = new THREE.Vector3(); // ghost-epoch victim position
let _lgTransit = 0; // shooter transit - refreshed per trace call
const _lgP = new THREE.Vector3();   // terrain march point
const _lgTo = new THREE.Vector3();
const _lgTo2 = new THREE.Vector3(); // chain-pick scratch

// Chain pick - nearest OTHER live enemy within range of a contact point.
// Shared by the damage tick and the per-frame visual refresh so the arc
// and the damage always describe the same fork.
export function pickChain(deps: CombatDeps, from: THREE.Vector3, exclude: (typeof deps.targets)[number]): (typeof deps.targets)[number] | null {
  let best: (typeof deps.targets)[number] | null = null;
  let bestD2 = LG_CHAIN_RANGE * LG_CHAIN_RANGE;
  const cam = deps.lazyCamera();
  cam.getWorldDirection(_lgTo);
  for (const t of deps.targets) {
    if (t.dead || t === exclude) {continue;}
    // Front hemisphere only - a bolt can't arc backward through you,
    // and a fork to an enemy beside/behind draws a giant fan ACROSS
    // the view that reads as "the beam detached" (it did, sorta)
    _lgTo2.copy(t.pos).sub(cam.position);
    if (_lgTo2.dot(_lgTo) <= 0) {continue;}
    // Fork must continue FORWARD-ish along the bolt - a perpendicular
    // hop (bird overhead, enemy beside the contact) draws an arc into
    // the sky that reads as the beam detaching, not a chain
    _lgTo2.copy(t.pos).sub(from);
    if (_lgTo2.dot(_lgD) < _lgTo2.length() * 0.35) {continue;}
    const d2 = t.pos.distanceToSquared(from);
    if (d2 < bestD2) { bestD2 = d2; best = t; }
  }
  return best;
}

function tracePlayerHit(deps: CombatDeps, hitT: number, traceT: { t: number }, o: THREE.Vector3, d: THREE.Vector3): string | null {
  traceT.t = hitT;
  let hitId: string | null = null;
  // Teammates pass through, same as the server's beamSweep default
  // (includeTeammates=false): the authority never judges them, so latching
  // the visual bolt on a friendly was a lie - the beam detached-looking
  // attach point was a hit the server would never pay. Wire team resolves
  // the same way fillMapBlips does; teamless/FFA remotes stay hittable.
  const wirePlayers = deps.lazyNetworkManager?.().getPlayers?.();
  for (const [pid, rp] of deps.world.remotePlayers) {
    if (rp.isDead) {continue;}
    const team = (rp as { team?: string }).team ?? wirePlayers?.get(pid)?.team;
    if (team !== undefined && team === deps.world.localTeam) {continue;}
    // Ray vs the class capsule (shared/botClasses - the same shape the
    // server validates) at the GHOST epoch - the server judges the victim
    // ~0.7·renderDelay behind live; the rendered body is ~150ms stale
    // (pins on the stale visual read as hits the authority never saw).
    const entry = rayCapsuleEntry(rp.ghostPosition?.(_lgGhost, _lgTransit) ?? rp.position, traceT.t, rp.armorClass, o, d);
    if (entry !== null) { traceT.t = entry; hitId = pid; }
  }
  return hitId;
}




function traceTargetHit(deps: CombatDeps, hitT: number, traceT: { t: number }, o: THREE.Vector3, d: THREE.Vector3): (typeof deps.targets)[number] | null {
  traceT.t = hitT;
  let hit: (typeof deps.targets)[number] | null = null;
  for (const t of deps.targets) {
    if (t.dead) {continue;}
    _lgTo.copy(t.pos).sub(o);
    // Capsule bodies (totem): aim the test at the shaft's midpoint -
    // the feet-sphere misses a beam through the upper half entirely.
    if (t.capsuleTop) {_lgTo.y += t.capsuleTop * 0.5;}
    const proj = _lgTo.dot(d);
    if (proj < 0 || proj > traceT.t) {continue;}
    const entry = sphereEntry(traceT.t, (t.hitRadius ?? t.radius) + 0.45, proj);
    if (entry !== null) { traceT.t = entry; hit = t; }
  }
  return hit;
}



// Shared ray: eye + current camera forward → terrain march + nearest
// sphere hit. Both the damage tick AND the per-frame visual refresh run
// this - a stale tip between ticks is what detached the bolt on strafes.
export function lgTrace(deps: CombatDeps, cam: THREE.Camera, traceT: { t: number },
                        range = LG_RANGE, bounce = true): {
  hitT: number;
  hitTarget: (typeof deps.targets)[number] | null;
  hitPlayerId: string | null;
  /** Terrain-bounce corner - when set, the beam renders two legs and the
   *  hit pays half damage (server resolves the same skip). */
  bend: THREE.Vector3 | null;
} {
  _lgO.copy(cam.position);
  cam.getWorldDirection(_lgD);
  // Server rewind = view + (victimPing−myPing)/2 - ghost sweeps judge
  // the victim at the adjudicated epoch, not the rendered one.
  _lgTransit = (deps.lazyNetworkManager?.()?.serverPingMs ?? deps.lazyNetworkManager?.()?.getPing?.() ?? 0) / 2;

  // Terrain: march the ray in 1.5m steps until it goes under the heightmap,
  // then bisect the last step - the coarse march alone can leave the tip
  // buried ~1.5m inside a slope.
  let hitT = range;
  let fieldT = range; // terrain stop distance - a FIELD hit can bounce
  for (let d = 1.5; d <= range; d += 1.5) {
    _lgP.copy(_lgO).addScaledVector(_lgD, d);
    if (_lgP.y < deps.lazyTerrain().getHeight(_lgP.x, _lgP.z)) {
      let lo = d - 1.5, hi = d;
      for (let i = 0; i < 6; i += 1) {
        const mid = (lo + hi) * 0.5;
        _lgP.copy(_lgO).addScaledVector(_lgD, mid);
        if (_lgP.y < deps.lazyTerrain().getHeight(_lgP.x, _lgP.z)) {hi = mid;} else {lo = mid;}
      }
      fieldT = lo; hitT = lo; break;
    }
  }

  // Structures: the beam stops at walls - a bolt that could pierce a
  // base would splash targets inside it (server rejects those claims).
  if (Projectile.solidColliders.length > 0) {
    _lgP.copy(_lgO).addScaledVector(_lgD, hitT);
    const sh = segSolidHit(_lgO, _lgP, Projectile.solidColliders, undefined, deps.world.localTeam);
    if (sh) {hitT *= sh.t;} // entry as a fraction of the current reach
  }

  // Deployable hulls contest the same lane - a turret body-blocks the
  // beam (projectiles already detonate on these via the contact sweep).
  if (Projectile.dynColliders.length > 0) {
    _lgP.copy(_lgO).addScaledVector(_lgD, hitT);
    const dh = segSolidHit(_lgO, _lgP, Projectile.dynColliders, undefined, deps.world.localTeam);
    if (dh) {hitT *= dh.t;}
  }

  // Targets: ray-vs-sphere, nearest wins - tip lands on the SURFACE entry
  // point (exact aim), never magnetized to the center
  const hitTarget = traceTargetHit(deps, hitT, traceT, _lgO, _lgD);
  hitT = traceT.t;
  const hitPlayerId = tracePlayerHit(deps, hitT, traceT, _lgO, _lgD);
  hitT = traceT.t;

  _lgHit.copy(_lgO).addScaledVector(_lgD, hitT);

  // Terrain bounce: ground stopped the bolt (not a wall/hull, not an
  // entity) - skip off the slope once, ≤LG_BOUNCE_RANGE, half damage.
  // Mirrors the server's beamSweepRay leg-for-leg.
  if (bounce && !hitTarget && !hitPlayerId && fieldT < range && hitT === fieldT) {
    const bounced = bounceLeg(deps);
    if (bounced) {return bounced;}
  }
  return { hitT, hitTarget, hitPlayerId, bend: null };
}

// Second leg off the terrain hit in _lgHit: the bolt grounds, then arcs
// to the nearest enemy within LG_BOUNCE_RANGE of the contact - any angle
// (the server's beamSweepRay resolves the same pick). Null = nobody near.
function bounceLeg(deps: CombatDeps): {
  hitT: number;
  hitTarget: (typeof deps.targets)[number] | null;
  hitPlayerId: string | null;
  bend: THREE.Vector3;
} | null {
  _lgBend.copy(_lgHit);
  let bestD2 = LG_BOUNCE_RANGE * LG_BOUNCE_RANGE;
  let bTarget: (typeof deps.targets)[number] | null = null;
  let bPlayer: string | null = null;
  for (const t of deps.targets) {
    if (t.dead) {continue;}
    const d2 = _lgBend.distanceToSquared(t.pos) - (t.hitRadius ?? t.radius) ** 2;
    if (d2 < bestD2) { bestD2 = d2; bTarget = t; bPlayer = null; _lgTo.copy(t.pos); }
  }
  const picked = pickBouncePlayer(deps, bestD2);
  if (picked) { bPlayer = picked; bTarget = null; }
  if (!bTarget && !bPlayer) {return null;}
  _lgHit.copy(_lgTo);
  return { hitT: _lgBend.distanceTo(_lgHit), hitTarget: bTarget, hitPlayerId: bPlayer, bend: _lgBend };
}

/** Nearest live ENEMY remote within range of _lgBend - ghost-epoch
 *  capsule midpoint, same teammate pass-through as the straight leg and
 *  the server's bounce pick. Winner's midpoint lands in _lgTo. */
function pickBouncePlayer(deps: CombatDeps, initD2: number): string | null {
  const wirePlayers = deps.lazyNetworkManager?.().getPlayers?.();
  let pid: string | null = null;
  let bestD2 = initD2;
  for (const [id, rp] of deps.world.remotePlayers) {
    if (rp.isDead) {continue;}
    const team = (rp as { team?: string }).team ?? wirePlayers?.get(id)?.team;
    if (team !== undefined && team === deps.world.localTeam) {continue;}
    // Ghost epoch (server's lag-comp rewind), not the rendered body -
    // eye height; measure to the capsule midpoint so a contact at the
    // feet still catches a standing enemy.
    const cap = classCapsule(rp.armorClass);
    const gp = rp.ghostPosition?.(_lgGhost, _lgTransit) ?? rp.position;
    _lgD2.set(gp.x, gp.y - cap.eye + cap.height * 0.5, gp.z);
    const d2 = _lgBend.distanceToSquared(_lgD2) - cap.radius * cap.radius;
    if (d2 < bestD2) { bestD2 = d2; pid = id; _lgTo.copy(_lgD2); }
  }
  return pid;
}

// Ray-vs-sphere entry distance along _lgD for the to-target vector in
// _lgTo; null when the ray misses or the sphere sits behind the tip.
// Beam is thin but not needle-thin - callers pad the radius.
function sphereEntry(hitT: number, r: number, proj: number): number | null {
  const perp2 = _lgTo.lengthSq() - proj * proj;
  if (perp2 >= r * r) {return null;}
  const entry = proj - Math.sqrt(r * r - perp2); // surface, not center
  return entry < hitT ? Math.max(entry, 0) : null;
}



/** Entry distance along _lgD for the player capsule at eyePos, or null.
 *  Closest-approach between the ray and the capsule's vertical axis
 *  segment, then back off the surface by sqrt(r²−d²) - the standard
 *  capsule-beam solve (exact for horizontal rays, ≤cm error for steep
 *  ones vs a true cylindrical cast). */
function rayCapsuleEntry(eyePos: THREE.Vector3, hitT: number, cls: string | undefined, o: THREE.Vector3, d: THREE.Vector3): number | null {
  const cap = classCapsule(cls);
  const capPad = cap.radius + 0.2; // beam is thin but not needle-thin
  const yLo = eyePos.y - cap.eye + cap.radius;
  const axisH = (cap.height - 2 * cap.radius); // yLo .. yLo+axisH
  const wx = o.x - eyePos.x;
  const wy = o.y - yLo;
  const wz = o.z - eyePos.z;
  const a = d.y;                        // axis dir is (0,1,0) → only y matters
  const b = wx * d.x + wy * d.y + wz * d.z; // w0·D (D normalized)
  const denom = a * a - 1;                 // −(Dx²+Dz²): 0 for a vertical ray
  // Unclamped line-line closest axis param, then clamp to the segment and
  // re-optimize the ray param for the clamped point.
  let s;
  if (denom < -1e-6) {s = (b * a - wy) / denom;}
  else {s = a > 0 ? 0 : axisH;}
  s = Math.min(Math.max(s, 0), axisH);
  let t = s * a - b;
  t = Math.min(Math.max(t, 0), hitT);
  s = Math.min(Math.max(t * a + wy, 0), axisH); // re-solve s for clamped t
  const px = o.x + d.x * t - eyePos.x;
  const py = o.y + d.y * t - (yLo + s);
  const pz = o.z + d.z * t - eyePos.z;
  const d2 = px * px + py * py + pz * pz;
  if (d2 >= capPad * capPad) {return null;}
  const entry = t - Math.sqrt(capPad * capPad - d2);
  return entry < hitT ? Math.max(entry, 0) : null;
}



