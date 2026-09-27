import * as THREE from 'three';

import * as sfx from '../../core/sfx.js';
import { LightningBeam } from '../../effects/lightningBeam.js';
import { lgMuzzleAnchor } from '../lgAnchor.js';
import {
  LG_RANGE, LG_POP_DMG_CAP, LG_POP_RADIUS_MAX, LG_POP_RADIUS_MIN,
  LG_CHAIN_RANGE, LG_CHAIN_DMG_SCALE,
} from '../../core/config.js';
import { getWeaponStats, WeaponType } from '../../../../shared/weapons.js';
import type { CombatDeps, FireArgs } from '../combat.js';
import type { Targetable } from '../../entities/balls.js';

// Lightning beam scratch — rebuilt per trace, never retained
const _lgO = new THREE.Vector3();   // eye position — the honest ray
const _lgD = new THREE.Vector3();
const _lgP = new THREE.Vector3();   // terrain march point
const _lgTo = new THREE.Vector3();
const _lgTo2 = new THREE.Vector3(); // chain-pick scratch
const _lgHit = new THREE.Vector3();
const _lgMuzzle = new THREE.Vector3(); // visual start — bottom-right of view

type ProcessExplosion = (
  pos: THREE.Vector3, radius: number, force: number, forceMode: 'push' | 'pull',
  aoeDamage: number, falloffMultiplier: number, collisionMultiplier: number,
  forceMultiplier: number, shooterId?: string, directHit?: boolean,
  directHitTargetId?: string | null, age?: number,
  sendAOE?: (pos: { x: number; y: number; z: number }, targetId: string | null) => void,
  explosionType?: 'rocket' | 'grenade', explosionTint?: string | number,
  vfxRadius?: number, weaponType?: number,
) => void;

export interface LightningHooks {
  processExplosion: ProcessExplosion;
  onTargetDestroyed: (t: Targetable, impulse?: THREE.Vector3, weaponType?: number) => void;
  applyForceToRemotes: (pos: THREE.Vector3, radius: number, force: number, forceMode: 'push' | 'pull', aoeDamage: number, directHitTargetId: string | null) => void;
}

// Lightning gun: honest hitscan — raycast from the eye every tick (~44ms),
// beam VFX shows exactly where damage lands (truelightning, no smooth fake
// shaft). Enemies take directDamage per tick with a steady pin shove; remote
// players go through the aoeShot server-claim path at the hit point.
export function createLightning(deps: CombatDeps, hooks: LightningHooks) {
  let lgBeam: LightningBeam | null = null;
  let lgLastFire = 0;
  let lgSizzleAt = 0; // throttle the connect sizzle — one crackle per ~6 ticks
  const lgBeamTo = new THREE.Vector3(); // beam tip — follows the target between ticks
  // Beam charge per target — damage dealt this run, detonated on the kill.
  const lgAcc = new Map<number, number>();

  // Beam start: the muzzle node's actual rendered pixel, unprojected into
  // world space through the main camera — FOV difference between the
  // viewmodel pass (55) and world pass (90) means a raw view-space offset
  // lands on the wrong ray, which read as the bolt lagging the gun.
  function lgAnchorLive(cam: THREE.Camera, out: THREE.Vector3): void {
    if (!deps.lazyViewModel()?.muzzleAnchorWorld(WeaponType.Lightning, cam, out)) {
      lgMuzzleAnchor(cam, out); // fixed-offset fallback until the node exists
    }
  }

  // Chain pick — nearest OTHER live enemy within range of a contact point.
  // Shared by the damage tick and the per-frame visual refresh so the arc
  // and the damage always describe the same fork.
  function pickChain(from: THREE.Vector3, exclude: (typeof deps.targets)[number]): (typeof deps.targets)[number] | null {
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
  function lgPop(pos: THREE.Vector3, acc: number): void {
    const dmg = Math.min(acc, LG_POP_DMG_CAP);
    const radius = Math.min(LG_POP_RADIUS_MIN + acc * 0.12, LG_POP_RADIUS_MAX);
    hooks.processExplosion(
      pos, radius, 30, 'push', dmg, 1, 1, 1,
      undefined, false, null, 0,
      // Server sees a normal Lightning blast for remote-player prediction;
      // the scaled damage is the PvE fantasy side (enemies are client-run)
      (p, targetId) => deps.lazyNetworkManager()?.sendAOEShot(p, WeaponType.Lightning, targetId),
      'rocket', 0x8fdcff, radius * 0.8, WeaponType.Lightning,
    );
  }

  // Shared ray: eye + current camera forward → terrain march + nearest
  // sphere hit. Both the damage tick AND the per-frame visual refresh run
  // this — a stale tip between ticks is what detached the bolt on strafes.
  function lgTrace(cam: THREE.Camera): {
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

    // Targets: ray-vs-sphere, nearest wins — tip lands on the SURFACE entry
    // point (exact aim), never magnetized to the center
    let hitTarget: (typeof deps.targets)[number] | null = null;
    for (const t of deps.targets) {
      if (t.dead) continue;
      _lgTo.copy(t.pos).sub(_lgO);
      // Capsule bodies (totem): aim the test at the shaft's midpoint —
      // the feet-sphere misses a beam through the upper half entirely.
      if (t.capsuleTop) _lgTo.y += t.capsuleTop * 0.5;
      const proj = _lgTo.dot(_lgD);
      if (proj < 0 || proj > hitT) continue;
      const r = (t.hitRadius ?? t.radius) + 0.45; // beam is thin but not needle-thin
      const perp2 = _lgTo.lengthSq() - proj * proj;
      if (perp2 < r * r) {
        const entry = proj - Math.sqrt(r * r - perp2); // surface, not center
        if (entry < hitT) { hitT = Math.max(entry, 0); hitTarget = t; }
      }
    }

    // Remote players: same ray test, slightly fat capsule
    let hitPlayerId: string | null = null;
    for (const [pid, rp] of deps.world.remotePlayers) {
      if (rp.isDead) continue;
      _lgTo.copy(rp.position).sub(_lgO);
      _lgTo.y += 0.9; // capsule center is ~chest, not feet
      const proj = _lgTo.dot(_lgD);
      if (proj < 0 || proj > hitT) continue;
      const r = 1.0;
      if (_lgTo.lengthSq() - proj * proj < r * r) { hitT = proj; hitPlayerId = pid; }
    }

    _lgHit.copy(_lgO).addScaledVector(_lgD, hitT);
    return { hitT, hitTarget, hitPlayerId };
  }

  // Per-frame beam visual refresh — called from gameLoop AFTER
  // viewModel.update so the muzzle node's swayed transform is THIS frame's,
  // not one stale. Beam start = the viewmodel emitter's real position
  // rotated into world space (vmScene shares the camera quaternion about
  // the eye) — the bolt is welded to the rendered gun, sway and all.
  function updateBeamVisual(): void {
    if (!lgBeam || lgLastFire <= 0 || performance.now() - lgLastFire > 90) return;
    const cam = deps.lazyCamera();
    lgAnchorLive(cam, _lgMuzzle);
    // Re-trace EVERY FRAME — the 44ms tick tip goes ~1.7m stale during a
    // strafe, and a live trace tracks the enemy's surface as it moves.
    // Damage stays per-tick; this is purely welding the visual.
    const { hitT, hitTarget } = lgTrace(cam); // refreshes _lgHit at the live camera
    lgBeamTo.copy(_lgHit);
    if (hitTarget) {
      const chain = pickChain(_lgHit, hitTarget);
      if (chain) lgBeam.fireChain(_lgHit, chain.pos); else lgBeam.clearChain();
    } else {
      lgBeam.clearChain();
    }
    lgBeam.fire(_lgMuzzle, lgBeamTo, cam.position, hitT < LG_RANGE);
  }

  // Beam fades ~80ms after the last tick — driven from updateProjectiles.
  function tickBeam(dt: number): void {
    if (!lgBeam) return;
    lgBeam.update(dt);
    const lgAge = performance.now() - lgLastFire;
    if (lgLastFire > 0 && lgAge > 90) {
      sfx.beamLoopStop(); // trigger dropped — ramp the hum out
      lgLastFire = 0;
      lgBeam.clearChain();
    }
    // NOTE: beam weld lives in updateBeamVisual, called post-viewModel
    // update from gameLoop — the muzzle node is stale here.
  }

  function lightning(_e: FireArgs): void {
    const cam = deps.lazyCamera();
    const player = deps.lazyPlayer();
    const stats = getWeaponStats(WeaponType.Lightning);
    if (!lgBeam) lgBeam = new LightningBeam(deps.lazyScene());

    const { hitT, hitTarget, hitPlayerId } = lgTrace(cam);

    lgBeamTo.copy(_lgHit); // tip = exact aim point on the surface, no snap
    const lgNow = performance.now();
    lgLastFire = lgNow;
    sfx.beamLoop(); // continuous drone — keepalive per tick
    // Connect sizzle — beam frying SOMETHING sounds different than beaming
    // air: positional crackle at the contact, throttled so 22t/s doesn't smear
    if ((hitTarget || hitPlayerId) && lgNow - lgSizzleAt > 160) {
      lgSizzleAt = lgNow;
      sfx.lgSizzle(_lgHit);
    }

    // Same anchor as the per-frame refresh — one function, no drift.
    lgAnchorLive(cam, _lgMuzzle);
    lgBeam.fire(_lgMuzzle, _lgHit, _lgO, hitT < LG_RANGE);

    deps.lazyViewModel()?.kick(0.22); // per-tick hum — stacks into a buzz
    // Contact sparks only when the bolt actually lands on something —
    // a max-range miss is arcing into empty air, no impact to show
    if (hitT < LG_RANGE) deps.lazyEffects().spawnImpact(_lgHit, _lgD);
    sfx.shoot(WeaponType.Lightning);

    if (hitTarget) {
      hitTarget.applyKnockback(player.pos, stats.knockbackForce); // the pin
      deps.lazyDamageNumbers().spawn(hitTarget.pos, stats.directDamage, '#8fdcff', cam);
      // Charge: every tick pumped into this target banks toward its pop
      const acc = (lgAcc.get(hitTarget.id) ?? 0) + stats.directDamage;
      lgAcc.set(hitTarget.id, acc);
      deps.reportTargetDamage?.(hitTarget, stats.directDamage);
      if (hitTarget.takeDamage(stats.directDamage)) {
        hooks.onTargetDestroyed(hitTarget, hitTarget.vel, WeaponType.Lightning);
        lgPop(hitTarget.pos, acc);
        lgAcc.delete(hitTarget.id);
      } else if (!hitTarget.hideHealthBar) {
        deps.lazyHealthBarSystem().spawnBall(hitTarget, stats.directDamage, hitTarget.health);
      }
      deps.lazyHud().showHitMarker();

      // Chain fork: arc from the CONTACT POINT to the nearest OTHER enemy
      // in range — half damage, but it banks its own pop charge too
      const chainT = pickChain(_lgHit, hitTarget);
      if (chainT) {
        lgBeam.fireChain(_lgHit, chainT.pos);
        const cdmg = stats.directDamage * LG_CHAIN_DMG_SCALE;
        chainT.applyKnockback(hitTarget.pos, stats.knockbackForce * 0.6);
        deps.lazyDamageNumbers().spawn(chainT.pos, cdmg, '#8fdcff', cam);
        const cAcc = (lgAcc.get(chainT.id) ?? 0) + cdmg;
        lgAcc.set(chainT.id, cAcc);
        deps.reportTargetDamage?.(chainT, cdmg);
        if (chainT.takeDamage(cdmg)) {
          hooks.onTargetDestroyed(chainT, chainT.vel, WeaponType.Lightning);
          lgPop(chainT.pos, cAcc);
          lgAcc.delete(chainT.id);
        } else if (!chainT.hideHealthBar) {
          deps.lazyHealthBarSystem().spawnBall(chainT, cdmg, chainT.health);
        }
      }
    }

    if (hitPlayerId) {
      // Server-authoritative damage claim at the point the beam lands on them;
      // applyForceToRemotes mirrors knockback+damage through the RTT gap.
      const networkManager = deps.lazyNetworkManager();
      if (networkManager?.isConnected()) {
        networkManager.sendAOEShot(
          { x: _lgHit.x, y: _lgHit.y, z: _lgHit.z },
          WeaponType.Lightning, hitPlayerId,
        );
      }
      hooks.applyForceToRemotes(_lgHit, stats.aoeRadius, stats.knockbackForce, 'push', stats.aoeDamage, null);
    }
  }

  return { lightning, updateBeamVisual, tickBeam };
}
