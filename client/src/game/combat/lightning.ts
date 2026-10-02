import * as THREE from 'three';

import * as sfx from '../../core/sfx.js';
import { LightningBeam } from '../../effects/lightningBeam.js';
import { lgMuzzleAnchor } from '../lgAnchor.js';
import {
  LG_RANGE, LG_POP_DMG_CAP, LG_POP_RADIUS_MAX, LG_POP_RADIUS_MIN,
  LG_CHAIN_DMG_SCALE, LG_POP_CHARGE_MULT, LG_CHARGE_DECAY_S,
} from '../../core/config.js';
import { getWeaponStats, WeaponType } from '../../../../shared/weapons.js';
import { lgTickDamage, LG_TICK_BASE, LG_RAMP_WINDOW_S } from '../../../../shared/combat.js';
import { lgTrace, pickChain, _lgHit, _lgO, _lgD } from './lightningTrace.js';
import type { CombatDeps, FireArgs, ExplosionArgs } from '../combat.js';
import type { BlastArgs } from '../blastForce.js';
import type { Targetable } from '../../entities/balls.js';

// Lightning beam scratch — rebuilt per trace, never retained
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
  tipAt: number;         // last visual-frame timestamp for the tip spring
  tipSettled: boolean;   // first frame after spawn pins the tip — no 0→hit whip
  ramp: Map<number, { t: number; n: number }>;
  rampP: Map<string, { t: number; n: number }>; // remote-player victims, same stepped decay
  shroud: Map<number, { sprite: THREE.Sprite; seenAt: number }>;
}
const _traceT = { t: 0 };

// Charged-enemy shroud: one shared radial texture; per-target sprites
// scale and flicker with banked pop charge so a loaded victim reads
// "about to detonate" to anyone looking, not just the beamer.
// Charge bank: per-target accumulated pop charge. Module-level so the
// generic projectile impact path can detonate it — ANY weapon's direct
// hit pops min(banked, hitDamage) off the charge, remainder keeps
// smoldering. The beam itself still pays full on its own kills.
const chargeBank = new Map<number, number>();
let dischargeFx: ((pos: THREE.Vector3, amount: number) => void) | null = null;

/** Pop `damage` worth of banked charge on target `id` at `at`. Returns
 *  the amount detonated (0 = nothing banked). Lightning's own ticks
 *  skip this — they charge, not detonate. */
export function lgDischarge(id: number, damage: number, at: THREE.Vector3): number {
  const acc = chargeBank.get(id) ?? 0;
  const pop = Math.min(acc, damage);
  if (pop <= 0) return 0;
  if (acc - pop <= 0) chargeBank.delete(id); else chargeBank.set(id, acc - pop);
  dischargeFx?.(at, pop);
  return pop;
}

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
  const player = deps.lazyPlayer();
  // Third person: the viewmodel is hidden — its muzzle node still resolves
  // to the first-person screen spot, so the beam visibly springs from mid-
  // air under the crosshair. Anchor at the body model's barrel tip instead.
  if (player.thirdPerson && player.muzzleWorld(out)) return;
  if (!deps.lazyViewModel()?.muzzleAnchorWorld(WeaponType.Lightning, cam, out)) {
    lgMuzzleAnchor(cam, out); // fixed-offset fallback until the node exists
  }
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
  const { hitT, hitTarget, hitPlayerId } = lgTrace(deps, cam, _traceT); // refreshes _lgHit at the live camera
  // Tip spring: the trace is exact, but snapping the DISPLAYED tip to a
  // new depth every frame reads as a rigid rod pivoting on the crosshair
  // (55m instant jumps on sky↔wall sweeps). A fast exp approach keeps the
  // beam welded to aim while a real sweep whips instead of teleporting.
  const nowV = performance.now();
  if (!lg.tipSettled) { lg.beamTo.copy(_lgHit); lg.tipSettled = true; }
  else {
    const dtV = Math.min((nowV - lg.tipAt) / 1000, 0.1);
    lg.beamTo.lerp(_lgHit, 1 - Math.exp(-dtV * 28)); // ~150ms to settle
  }
  lg.tipAt = nowV;
  if (hitTarget) {
    const chain = pickChain(deps, _lgHit, hitTarget);
    if (chain) lg.beam.fireChain(_lgHit, chain.pos); else lg.beam.clearChain();
  } else {
    lg.beam.clearChain();
  }
  lg.beam.fire(_lgMuzzle, lg.beamTo, cam.position, hitT < LG_RANGE, hitTarget !== null || hitPlayerId !== null);
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
    lg.tipSettled = false; // next pull re-pins the tip, no stale whip
  }
  // Charge shrouds: banked charge decays smoothly once the beam leaves a
  // victim (5x fill rate) — the glow fades as the bomb bleeds off.
  const now = performance.now() / 1000;
  for (const [id, sh] of lg.shroud) {
    const age = now - sh.seenAt;
    if (age > LG_RAMP_WINDOW_S) {
      const acc = (chargeBank.get(id) ?? 0) - LG_CHARGE_DECAY_S * dt;
      if (acc <= 0) {
        chargeBank.delete(id);
        sh.sprite.removeFromParent();
        lg.shroud.delete(id);
        continue;
      }
      chargeBank.set(id, acc);
    }
    const charge = Math.min((chargeBank.get(id) ?? 0) / LG_POP_DMG_CAP, 1);
    const flicker = 0.75 + Math.random() * 0.25 + charge * 0.5 * (Math.random() < 0.3 ? 1 : 0);
    (sh.sprite.material as THREE.SpriteMaterial).opacity = Math.min(1, (0.15 + charge * 0.8) * flicker);
    sh.sprite.scale.setScalar(1.5 + charge * 4);
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
  const acc = (chargeBank.get(t.id) ?? 0) + (LG_TICK_BASE - lgTickDamage(n)) * dmgScale * LG_POP_CHARGE_MULT;
  chargeBank.set(t.id, acc);
  // Shroud grows + hardens with charge — a readable countdown to the pop.
  const charge = Math.min(acc / LG_POP_DMG_CAP, 1);
  lg.beam?.setCharge(charge); // the bolt itself thickens as the bomb loads
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
    chargeBank.delete(t.id);
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
    beamTo: new THREE.Vector3(), // displayed tip — updateBeamVisual springs it
    tipAt: 0,
    tipSettled: false,
    ramp: new Map(), // consecutive-tick count per target — steps damage down
    rampP: new Map(),
    shroud: new Map(), // charged-enemy glow — telegraphs the banked pop
  };
  dischargeFx = (pos, amount) => lgPop(deps, hooks, pos, amount);

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

    // beamTo is display state owned by updateBeamVisual — the tick still
    // fires from the raw _lgHit so damage/explosions stay exact.
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
    lg.beam.fire(_lgMuzzle, _lgHit, _lgO, hitT < LG_RANGE, hitTarget !== null || hitPlayerId !== null);

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
    } else {
      lg.beam?.setCharge(0); // arcing air — nothing banked, nothing to show
    }

    if (hitPlayerId) zapPlayer(hitPlayerId, stats);
  }

  // One beam tick on a remote player: the victim can't ride the generic
  // splash (aoeDamage(5, ~1m, 1.6r) ≈ 2-3/tick — a sixth of the enemy-side
  // ramp), so they take the stepped tick directly. Bots resolve through
  // local authority, peers get the prediction until the server's aoeBeam
  // lands the identical tick.
  function zapPlayer(hitPlayerId: string, stats: ReturnType<typeof getWeaponStats>): void {
    const nowV = performance.now() / 1000;
    const stV = lg.rampP.get(hitPlayerId);
    const nV = stV && nowV - stV.t <= LG_RAMP_WINDOW_S ? stV.n + 1 : 1;
    lg.rampP.set(hitPlayerId, { t: nowV, n: nV });
    if (lg.rampP.size > 32) {
      for (const [id, s] of lg.rampP) if (nowV - s.t > LG_RAMP_WINDOW_S) lg.rampP.delete(id);
    }
    const tick = lgTickDamage(nV);
    // Same per-tick number creatures get (zapTarget) — the beam on a
    // player was hitmarker-only, which read as "beam does no damage".
    if (tick >= 1) deps.lazyDamageNumbers().spawn(_lgHit, tick, '#8fdcff', deps.lazyCamera());
    if (!deps.botHit?.(hitPlayerId, tick, _lgHit, 'local')) {
      deps.lazyHealthBarSystem().predictDamage(hitPlayerId, tick);
    }
    deps.lazyHud().showHitMarker();
    const networkManager = deps.lazyNetworkManager();
    if (networkManager?.isConnected()) {
      networkManager.sendAOEShot({
        position: { x: _lgHit.x, y: _lgHit.y, z: _lgHit.z },
        weaponType: WeaponType.Lightning, excludeTargetId: hitPlayerId,
      });
    }
    // Splash sweep still runs for bystander knockback; the named victim is
    // skipped so the pin + predict above isn't double-applied.
    hooks.applyForceToRemotes({ pos: _lgHit, radius: stats.aoeRadius, force: stats.knockbackForce, forceMode: 'push', aoeDamage: stats.aoeDamage, directHitTargetId: hitPlayerId, falloffMultiplier: 1, collisionMultiplier: 1, forceMultiplier: 1 });
  }


  return { lightning, updateBeamVisual: () => updateBeamVisual(deps, lg), tickBeam: (dt: number) => tickBeam(lg, dt) };
}
