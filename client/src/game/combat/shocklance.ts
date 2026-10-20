import * as THREE from 'three';

import * as sfx from '../../core/sfx.js';
import { LightningBeam } from '../../effects/lightningBeam.js';
import { Explosion } from '../../effects/explosion.js';
import { screenShake } from '../../effects/screenShake.js';
import { fxPuff } from '../../effects/vfx.js';
import { lgMuzzleAnchor } from '../lgAnchor.js';
import { EXPLOSION_VFX_RADIUS } from '../../core/config.js';
import { getWeaponStats, WeaponType, LANCE_RANGE } from '../../../../shared/weapons.js';
import { lgTrace, _lgHit, _lgD } from './lightningTrace.js';
import type { CombatDeps, FireArgs } from '../combat.js';
import type { LightningHooks } from './lightning.js';

// Shocklance — the melee-key pull-out zap. One shot per cycle: the honest
// lgTrace ray at LANCE_RANGE, then THREE jagged strands converging on the
// hitpoint (fat violet main + blue whip + gold arc), a layered discharge
// burst at the contact ONLY when the bolt lands — a max-range miss arcs
// into air and shows nothing (the LG rule).
const _lanceMuzzle = new THREE.Vector3();
const _tip = new THREE.Vector3();
const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
const _traceT = { t: 0 };

// The strand table — each fires its own jagged path with its own palette:
// stacked violet/blue/gold is the overloaded-plasma read, and each beam
// rolls its own jag so the three never run the same route.
const STRANDS = [
  // Main bolt — fat violet corona, gold-hot core, wild but still a spine.
  { girth: 2.2, jag: 1.5, tipR: 0, tipU: 0,
    tint: { glow: 0x7A_30_FF, core: 0xFF_E8_9A, chain: 0xB0_80_FF, hit: 0xFF_C0_40, sparkTop: 0x8F_60_FF } },
  // Blue whip — thin, wildest jag, tip fans off the contact like a stray arc.
  { girth: 0.85, jag: 2.4, tipR: 0.4, tipU: 0.18,
    tint: { glow: 0x30_60_FF, core: 0xD8_EC_FF, chain: 0xB0_80_FF, hit: 0xAA_DD_FF, sparkTop: 0x80_C0_FF } },
  // Gold arc — mid strand fanning low, the hot second hit.
  { girth: 1.25, jag: 1.9, tipR: -0.4, tipU: -0.12,
    tint: { glow: 0xB0_40_FF, core: 0xFF_D8_66, chain: 0xB0_80_FF, hit: 0xFF_C0_40, sparkTop: 0xFF_AA_33 } },
] as const;
const LANCE_BURN = 0.34; // discharge crackles ~1/3s — the LG's 90ms tick-fade reads as a flick

export function createShocklance(deps: CombatDeps, hooks: LightningHooks): { lance: (e: FireArgs) => void; tickBeam: (dt: number) => void } {
  let strands: LightningBeam[] | null = null;

  // Layered discharge at the contact: the beams' own glow+fountains,
  // a jagged 'arc' blast for the big arcs, plus the spark puff —
  // stacked so the hitpoint reads as a small lightning storm.
  function hitBurst(): void {
    deps.lazyEffects().spawnImpact(_lgHit, _lgD);
    deps.world.explosions.push(new Explosion(
      deps.lazyScene(), _lgHit, true, 0, deps.lazyTerrain(),
      5.5 / EXPLOSION_VFX_RADIUS, 0xB0_60_FF, 'arc',
    ));
    fxPuff(_lgHit, {
      count: 20, pos: [0.25, 0.25, 0.25],
      velMin: [-9, -2, -9], velMax: [9, 9, 9],
      lifeMin: 0.12, lifeMax: 0.4, sizeScale: 1.4,
      colA: [0.55, 0.35, 1], colB: [1, 0.85, 0.4], additive: true,
    });
    sfx.at(_lgHit, 'impact', 1);
    screenShake.add(0.22);
  }

  function ensureStrands(): LightningBeam[] {
    strands ??= STRANDS.map((s): LightningBeam => {
      const b = new LightningBeam(deps.lazyScene(), s.tint);
      b.girth = s.girth;
      b.jagMul = s.jag;
      b.fadeTime = LANCE_BURN;
      return b;
    });
    return strands;
  }

  function lance(_e: FireArgs): void {
    const cam = deps.lazyCamera();
    const player = deps.lazyPlayer();
    const stats = getWeaponStats(WeaponType.Shocklance);
    const strs = ensureStrands();

    const { hitT, hitTarget, hitPlayerId } = lgTrace(deps, cam, _traceT, LANCE_RANGE, false);
    const landed = hitT < LANCE_RANGE;
    const biting = hitTarget !== null || hitPlayerId !== null;

    player.lastFireAt = performance.now(); // decloak-on-fire — same rule as every shot
    sfx.shoot(WeaponType.Shocklance);

    // Beam start: the lance's OWN emitter node — the plasma ball between
    // the tines — resolved through the same vmCam→NDC→world round-trip
    // the LG uses, so the bolt issues from the rendered tip pixel, sway
    // included. Third person anchors at the body prop's barrel instead.
    if (!(player.thirdPerson && player.muzzleWorld(_lanceMuzzle))
        && !deps.lazyViewModel()?.muzzleAnchorWorld(WeaponType.Shocklance, cam, _lanceMuzzle)) {
      lgMuzzleAnchor(cam, _lanceMuzzle); // fixed-offset fallback until the node exists
    }

    // Strand tips fan around the contact — the storm converges on the
    // hitpoint, not a laser-straight line.
    cam.updateMatrixWorld();
    _r.setFromMatrixColumn(cam.matrixWorld, 0);
    _u.setFromMatrixColumn(cam.matrixWorld, 1);
    for (let i = 0; i < strs.length; i += 1) {
      const s = STRANDS[i]!;
      _tip.copy(_lgHit).addScaledVector(_r, s.tipR).addScaledVector(_u, s.tipU);
      strs[i]!.fire(_lanceMuzzle, _tip, cam.position, landed, biting, null);
    }
    deps.lazyViewModel()?.thrust(); // the jab — bolt rides the stab apex
    if (landed) {hitBurst();}

    const serverPaid = deps.lazyNetworkManager()?.authoritySims() === true;
    if (hitTarget) {
      hitTarget.applyKnockback(player.pos, stats.knockbackForce, true);
      const dmg = stats.directDamage;
      deps.lazyDamageNumbers().spawn(hitTarget.pos, dmg, '#c080ff', cam);
      deps.reportTargetDamage?.(hitTarget, dmg);
      if (hitTarget.takeDamage(dmg, { serverPaid })) {hooks.onTargetDestroyed(hitTarget, hitTarget.vel, WeaponType.Shocklance);}
      else if (!hitTarget.hideHealthBar) {deps.lazyHealthBarSystem().spawnBall(hitTarget, dmg, hitTarget.health);}
      deps.lazyHud().showHitMarker();
      sfx.hitMarker(true);
    }
    // Remote players: the shotFired intent resolves on the server's
    // beamSweep — the local hit marker still confirms the honest ray.
    if (hitPlayerId) {deps.lazyHud().showHitMarker();}
  }

  // The storm burns ~0.34s (fadeTime) — tick alongside the LG's beam.
  function tickBeam(dt: number): void {
    if (!strands) {return;}
    for (const b of strands) {b.update(dt);}
  }

  return { lance, tickBeam };
}
