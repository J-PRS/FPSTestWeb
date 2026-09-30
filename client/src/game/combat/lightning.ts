import * as THREE from 'three';

import * as sfx from '../../core/sfx.js';
import { LightningBeam } from '../../effects/lightningBeam.js';
import { lgMuzzleAnchor } from '../lgAnchor.js';
import {
  LG_RANGE, LG_POP_DMG_CAP, LG_POP_RADIUS_MAX, LG_POP_RADIUS_MIN,
  LG_CHAIN_RANGE, LG_CHAIN_DMG_SCALE, LG_POP_CHARGE_MULT,
} from '../../core/config.js';
import { getWeaponStats, WeaponType } from '../../../../shared/weapons.js';
import { lgTickDamage, LG_RAMP_WINDOW_S } from '../../../../shared/combat.js';
import { segSolidHit } from '../../../../shared/solidWorld.js';
import { Projectile } from '../../projectiles/Projectile.js';
import type { CombatDeps, FireArgs, ExplosionArgs } from '../combat.js';
import type { BlastArgs } from '../blastForce.js';
import type { Targetable } from '../../entities/balls.js';

// Lightning beam scratch — rebuilt per trace, never retained
const _lgO = new THREE.Vector3();   // eye position — the honest ray
const _lgD = new THREE.Vector3();
const _lgP = new THREE.Vector3();   // terrain march point
const _lgTo = new THREE.Vector3();
const _lgTo2 = new THREE.Vector3(); // chain-pick scratch
const _lgHit = new THREE.Vector3();
const _lgMuzzle = new THREE.Vector3(); // visual start — bottom-right of view

type ProcessExplosion = (a: ExplosionArgs) => void;

export interface LightningHooks {
  processExplosion: ProcessExplosion;
  onTargetDestroyed: (t: Targetable, impulse?: THREE.Vector3, weaponType?: number) => void;
  applyForceToRemotes: (a: BlastArgs) => void;
}

interface LgState {
  beam: LightningBeam | null;
  lastFire: number;
  sizzleAt: number;
  beamTo: THREE.Vector3;
  acc: Map<number, number>;
  ramp: Map<number, { t: number; n: number }>;
  shroud: Map<number, { sprite: THREE.Sprite; seenAt: number }>;
}
const _traceT = { t: 0 };

// Charged-enemy shroud: one shared radial texture; per-target sprites
// scale and flicker with banked pop charge so a loaded victim reads
// "about to detonate" to anyone looking, not just the beamer.
let _shroudTex: THREE.Texture | null = null;
function shroudTexture(): THREE.Texture {
  if (_shroudTex) return _shroudTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.35, 'rgba(140,220,255,0.45)');
  g.addColorStop(1, 'rgba(60,140,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  _shroudTex = new THREE.CanvasTexture(c);
  return _shroudTex;
}

// Beam start: the muzzle node's actual rendered pixel, unprojected into
// world space through the main camera — FOV difference between the
// viewmodel pass (55) and world pass (90) means a raw view-space offset
// lands on the wrong ray, which read as the bolt lagging the gun.
function lgAnchorLive(deps: CombatDeps, cam: THREE.Camera, out: THREE.Vector3): void {
  if (!deps.lazyViewModel()?.muzzleAnchorWorld(WeaponType.Lightning, cam, out)) {
    lgMuzzleAnchor(cam, out); // fixed-offset fallback until the node exists
  }
}

// Chain pick — nearest OTHER live enemy within range of a contact point.
// Shared by the damage tick and the per-frame visual refresh so the arc
// and the damage always describe the same fork.
function pickChain(deps: CombatDeps, from: THREE.Vector3, exclude: (typeof deps.targets)[number]): (typeof deps.targets)[number] | null {
  let best: (typeof deps.targets)[number] | null = null;
  let bestD2 = LG_CHAIN_RANGE * LG_CHAIN_RANGE;
  const cam = deps.lazyCamera();
  cam.getWorldDirection(_lgTo);
  for (const t of deps.targets) {
    if (t.dead || t === exclude) continue;
    // Front hemisphere only — a bolt can't arc backward through you,
    // and a fork to an enemy beside/behind draws a giant fan ACROSS
    // the view that reads as "the beam detached" (it did, sorta)
    _lgTo2.copy(t.pos).sub(cam.position);
    if (_lgTo2.dot(_lgTo) <= 0) continue;
    // Fork must continue FORWARD-ish along the bolt — a perpendicular
    // hop (bird overhead, enemy beside the contact) draws an arc into
    // the sky that reads as the beam detaching, not a chain
    _lgTo2.copy(t.pos).sub(from);
    if (_lgTo2.dot(_lgD) < _lgTo2.length() * 0.35) continue;
    const d2 = t.pos.distanceToSquared(from);
    if (d2 < bestD2) { bestD2 = d2; best = t; }
  }
  return best;
}

// Death-burst: the corpse pops for the charge it banked. Damage AND
// radius scale with overcharge, capped — a tick-killed ball still pops
// small, a beamed-out overlord goes off like a barrel.
function lgPop(deps: CombatDeps, hooks: LightningHooks, pos: THREE.Vector3, acc: number): void {
  const dmg = Math.min(acc, LG_POP_DMG_CAP);
  const radius = Math.min(LG_POP_RADIUS_MIN + acc * 0.12, LG_POP_RADIUS_MAX);
  hooks.processExplosion({
    pos, radius, force: 30, forceMode: 'push', aoeDamage: dmg,
    falloffMultiplier: 1, collisionMultiplier: 1, forceMultiplier: 1,
    // Server sees a normal Lightning blast for remote-player prediction;
    // the scaled damage is the PvE fantasy side (enemies are client-run)
    sendAOE: (p, targetId) => deps.lazyNetworkManager()?.sendAOEShot({ position: p, weaponType: WeaponType.Lightning, excludeTargetId: targetId }),
    explosionTint: 0x8fdcff, vfxRadius: radius * 0.8, weaponType: WeaponType.Lightning,
  });
}

// Shared ray: eye + current camera forward → terrain march + nearest
// sphere hit. Both the damage tick AND the per-frame visual refresh run
// this — a stale tip between ticks is what detached the bolt on strafes.
function lgTrace(deps: CombatDeps, cam: THREE.Camera, traceT: { t: number }): {
  hitT: number;
  hitTarget: (typeof deps.targets)[number] | null;
  hitPlayerId: string | null;
} {
  _lgO.copy(cam.position);
  cam.getWorldDirection(_lgD);

  // Terrain: march the ray in 1.5m steps until it goes under the heightmap
  let hitT = LG_RANGE;
  for (let d = 1.5; d <= LG_RANGE; d += 1.5) {
    _lgP.copy(_lgO).addScaledVector(_lgD, d);
    if (_lgP.y < deps.lazyTerrain().getHeight(_lgP.x, _lgP.z)) { hitT = d; break; }
  }

  // Structures: the beam stops at walls — a bolt that could pierce a
  // base would splash targets inside it (server rejects those claims).
  if (Projectile.solidColliders.length) {
    _lgP.copy(_lgO).addScaledVector(_lgD, hitT);
    const sh = segSolidHit(_lgO, _lgP, Projectile.solidColliders);
    if (sh) hitT *= sh.t; // entry as a fraction of the current reach
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
    if (t.dead) continue;
    _lgTo.copy(t.pos).sub(_lgO);
    // Capsule bodies (totem): aim the test at the shaft's midpoint —
    // the feet-sphere misses a beam through the upper half entirely.
    if (t.capsuleTop) _lgTo.y += t.capsuleTop * 0.5;
    const proj = _lgTo.dot(_lgD);
    if (proj < 0 || proj > traceT.t) continue;
    const entry = sphereEntry(traceT.t, (t.hitRadius ?? t.radius) + 0.45, proj);
    if (entry !== null) { traceT.t = entry; hit = t; }
  }
  return hit;
}

function tracePlayerHit(deps: CombatDeps, hitT: number, traceT: { t: number }): string | null {
  traceT.t = hitT;
  let hitId: string | null = null;
  for (const [pid, rp] of deps.world.remotePlayers) {
    if (rp.isDead) continue;
    _lgTo.copy(rp.position).sub(_lgO);
    _lgTo.y += 0.9; // capsule center is ~chest, not feet
    const proj = _lgTo.dot(_lgD);
    if (proj < 0 || proj > traceT.t) continue;
    const entry = sphereEntry(traceT.t, 1.0, proj);
    if (entry !== null) { traceT.t = entry; hitId = pid; }
  }
  return hitId;
}

// Ray-vs-sphere entry distance along _lgD for the to-target vector in
// _lgTo; null when the ray misses or the sphere sits behind the tip.
// Beam is thin but not needle-thin — callers pad the radius.
function sphereEntry(hitT: number, r: number, proj: number): number | null {
  const perp2 = _lgTo.lengthSq() - proj * proj;
  if (perp2 >= r * r) return null;
  const entry = proj - Math.sqrt(r * r - perp2); // surface, not center
  return entry < hitT ? Math.max(entry, 0) : null;
}

// Per-frame beam visual refresh — called from gameLoop AFTER
// viewModel.update so the muzzle node's swayed transform is THIS frame's,
// not one stale. Beam start = the viewmodel emitter's real position
// rotated into world space (vmScene shares the camera quaternion about
// the eye) — the bolt is welded to the rendered gun, sway and all.
function updateBeamVisual(deps: CombatDeps, lg: LgState): void {
  if (!lg.beam || lg.lastFire <= 0 || performance.now() - lg.lastFire > 90) return;
  const cam = deps.lazyCamera();
  lgAnchorLive(deps, cam, _lgMuzzle);
  // Re-trace EVERY FRAME — the 44ms tick tip goes ~1.7m stale during a
  // strafe, and a live trace tracks the enemy's surface as it moves.
  // Damage stays per-tick; this is purely welding the visual.
  const { hitT, hitTarget } = lgTrace(deps, cam, _traceT); // refreshes _lgHit at the live camera
  lg.beamTo.copy(_lgHit);
  if (hitTarget) {
    const chain = pickChain(deps, _lgHit, hitTarget);
    if (chain) lg.beam.fireChain(_lgHit, chain.pos); else lg.beam.clearChain();
  } else {
    lg.beam.clearChain();
  }
  lg.beam.fire(_lgMuzzle, lg.beamTo, cam.position, hitT < LG_RANGE);
}

// Beam fades ~80ms after the last tick — driven from updateProjectiles.
function tickBeam(lg: LgState, dt: number): void {
  if (!lg.beam) return;
  lg.beam.update(dt);
  const lgAge = performance.now() - lg.lastFire;
  if (lg.lastFire > 0 && lgAge > 90) {
    sfx.beamLoopStop(); // trigger dropped — ramp the hum out
    lg.lastFire = 0;
    lg.beam.clearChain();
  }
  // Charge shrouds: flicker with banked charge, die out when the beam
  // leaves the victim (same window as the ramp reset).
  const now = performance.now() / 1000;
  for (const [id, sh] of lg.shroud) {
    const age = now - sh.seenAt;
    if (age > LG_RAMP_WINDOW_S * 2) {
      sh.sprite.removeFromParent();
      lg.shroud.delete(id);
      continue;
    }
    const charge = Math.min((lg.acc.get(id) ?? 0) / LG_POP_DMG_CAP, 1);
    const flicker = 0.75 + Math.random() * 0.25 + charge * 0.5 * (Math.random() < 0.3 ? 1 : 0);
    (sh.sprite.material as THREE.SpriteMaterial).opacity = Math.min(1, (0.15 + charge * 0.8) * flicker);
  }
  // NOTE: beam weld lives in updateBeamVisual, called post-viewModel
  // update from gameLoop — the muzzle node is stale here.
}

// One beam tick of damage: number + health bar + bank toward the pop —
// every tick pumped into a target charges its burst. Shared by the
// primary strike and the chain fork.
function zapTarget(deps: CombatDeps, hooks: LightningHooks, lg: LgState,
    t: (typeof deps.targets)[number], dmgScale: number, cam: THREE.Camera): void {
  // Stepped ramp-down: sustained hold bleeds to the floor — the beam's
  // burst is the first contact, the pop is the payoff for the cost paid.
  const now = performance.now() / 1000;
  const st = lg.ramp.get(t.id);
  const n = st && now - st.t <= LG_RAMP_WINDOW_S ? st.n + 1 : 1;
  lg.ramp.set(t.id, { t: now, n });
  if (lg.ramp.size > 32) {
    for (const [id, s] of lg.ramp) if (now - s.t > LG_RAMP_WINDOW_S) lg.ramp.delete(id);
  }
  const dmg = lgTickDamage(n) * dmgScale;
  deps.lazyDamageNumbers().spawn(t.pos, dmg, '#8fdcff', cam);
  // The pop banks what the ramp withheld, not what it dealt — a fresh
  // beam charges nothing, a held beam detonates for the decay it paid.
  const acc = (lg.acc.get(t.id) ?? 0) + (8 - lgTickDamage(n)) * dmgScale * LG_POP_CHARGE_MULT;
  lg.acc.set(t.id, acc);
  // Shroud grows + hardens with charge — a readable countdown to the pop.
  const charge = Math.min(acc / LG_POP_DMG_CAP, 1);
  let sh = lg.shroud.get(t.id);
  if (!sh) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: shroudTexture(), transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, color: 0x9fd8ff,
    }));
    deps.lazyScene().add(sprite);
    sh = { sprite, seenAt: 0 };
    lg.shroud.set(t.id, sh);
  }
  sh.seenAt = now;
  sh.sprite.position.copy(t.pos);
  sh.sprite.scale.setScalar(1.5 + charge * 4);
  deps.reportTargetDamage?.(t, dmg);
  if (t.takeDamage(dmg)) {
    hooks.onTargetDestroyed(t, t.vel, WeaponType.Lightning);
    lgPop(deps, hooks, t.pos, acc);
    lg.acc.delete(t.id);
    const dead = lg.shroud.get(t.id);
    if (dead) { dead.sprite.removeFromParent(); lg.shroud.delete(t.id); }
  } else if (!t.hideHealthBar) {
    deps.lazyHealthBarSystem().spawnBall(t, dmg, t.health);
  }
}

// Lightning gun: honest hitscan — raycast from the eye every tick (~44ms),
// beam VFX shows exactly where damage lands (truelightning, no smooth fake
// shaft). Enemies take directDamage per tick with a steady pin shove; remote
// players go through the aoeShot server-claim path at the hit point.
export function createLightning(deps: CombatDeps, hooks: LightningHooks) {
  const lg: LgState = {
    beam: null,
    lastFire: 0,
    sizzleAt: 0, // throttle the connect sizzle — one crackle per ~6 ticks
    beamTo: new THREE.Vector3(), // beam tip — follows the target between ticks
    acc: new Map(), // beam charge per target — detonated on the kill
    ramp: new Map(), // consecutive-tick count per target — steps damage down
    shroud: new Map(), // charged-enemy glow — telegraphs the banked pop
  };

  // Beam start: the muzzle node's actual rendered pixel, unprojected into
  // world space through the main camera — FOV difference between the
  // viewmodel pass (55) and world pass (90) means a raw view-space offset
  // lands on the wrong ray, which read as the bolt lagging the gun.

  // One beam tick of damage: number + health bar + bank toward the pop —
  // every tick pumped into a target charges its burst. Shared by the
  // primary strike and the chain fork.
  function lightning(_e: FireArgs): void {
    const cam = deps.lazyCamera();
    const player = deps.lazyPlayer();
    const stats = getWeaponStats(WeaponType.Lightning);
    if (!lg.beam) lg.beam = new LightningBeam(deps.lazyScene());

    const { hitT, hitTarget, hitPlayerId } = lgTrace(deps, cam, _traceT);

    lg.beamTo.copy(_lgHit); // tip = exact aim point on the surface, no snap
    const lgNow = performance.now();
    lg.lastFire = lgNow;
    sfx.beamLoop(); // continuous drone — keepalive per tick
    // Connect sizzle — beam frying SOMETHING sounds different than beaming
    // air: positional crackle at the contact, throttled so 22t/s doesn't smear
    if ((hitTarget || hitPlayerId) && lgNow - lg.sizzleAt > 160) {
      lg.sizzleAt = lgNow;
      sfx.lgSizzle(_lgHit);
    }

    // Same anchor as the per-frame refresh — one function, no drift.
    lgAnchorLive(deps, cam, _lgMuzzle);
    lg.beam.fire(_lgMuzzle, _lgHit, _lgO, hitT < LG_RANGE);

    deps.lazyViewModel()?.kick(0.22); // per-tick hum — stacks into a buzz
    // Contact sparks only when the bolt actually lands on something —
    // a max-range miss is arcing into empty air, no impact to show
    if (hitT < LG_RANGE) deps.lazyEffects().spawnImpact(_lgHit, _lgD);
    sfx.shoot(WeaponType.Lightning);

    if (hitTarget) {
      hitTarget.applyKnockback(player.pos, stats.knockbackForce); // the pin
      zapTarget(deps, hooks, lg, hitTarget, 1, cam);
      deps.lazyHud().showHitMarker();

      // Chain fork: arc from the CONTACT POINT to the nearest OTHER enemy
      // in range — half damage, but it banks its own pop charge too
      const chainT = pickChain(deps, _lgHit, hitTarget);
      if (chainT) {
        lg.beam.fireChain(_lgHit, chainT.pos);
        chainT.applyKnockback(hitTarget.pos, stats.knockbackForce * 0.6);
        zapTarget(deps, hooks, lg, chainT, LG_CHAIN_DMG_SCALE, cam);
      }
    }

    if (hitPlayerId) {
      // Server-authoritative damage claim at the point the beam lands on them;
      // applyForceToRemotes mirrors knockback+damage through the RTT gap.
      const networkManager = deps.lazyNetworkManager();
      if (networkManager?.isConnected()) {
        networkManager.sendAOEShot({
          position: { x: _lgHit.x, y: _lgHit.y, z: _lgHit.z },
          weaponType: WeaponType.Lightning, excludeTargetId: hitPlayerId,
        });
      }
      hooks.applyForceToRemotes({ pos: _lgHit, radius: stats.aoeRadius, force: stats.knockbackForce, forceMode: 'push', aoeDamage: stats.aoeDamage, directHitTargetId: null, falloffMultiplier: 1, collisionMultiplier: 1, forceMultiplier: 1 });
    }
  }


  return { lightning, updateBeamVisual: () => updateBeamVisual(deps, lg), tickBeam: (dt: number) => tickBeam(lg, dt) };
}
