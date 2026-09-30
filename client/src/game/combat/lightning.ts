import * as THREE from 'three';

import * as sfx from '../../core/sfx.js';
import { LightningBeam } from '../../effects/lightningBeam.js';
import { lgMuzzleAnchor } from '../lgAnchor.js';
import {
  LG_RANGE, LG_POP_DMG_CAP, LG_POP_RADIUS_MAX, LG_POP_RADIUS_MIN,
  LG_CHAIN_RANGE, LG_CHAIN_DMG_SCALE, LG_POP_CHARGE_MULT, LG_CHARGE_DECAY_S,
} from '../../core/config.js';
import { getWeaponStats, WeaponType } from '../../../../shared/weapons.js';
import { lgTickDamage, LG_TICK_BASE, LG_RAMP_WINDOW_S } from '../../../../shared/combat.js';
import { PLAYER_RADIUS, PLAYER_HEIGHT, EYE_OFFSET } from '../../../../shared/constants.js';
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
    // Ray vs the SHARED player capsule (shared/constants — the same shape
    // the debug wireframe draws and the server validates). rp.position is
    // eye height; the capsule axis runs feet+R .. feet+HEIGHT−R below it.
    const entry = rayCapsuleEntry(rp.position, traceT.t);
    if (entry !== null) { traceT.t = entry; hitId = pid; }
  }
  return hitId;
}

const CAP_PAD = PLAYER_RADIUS + 0.2; // beam is thin but not needle-thin

/** Entry distance along _lgD for the player capsule at eyePos, or null.
 *  Closest-approach between the ray and the capsule's vertical axis
 *  segment, then back off the surface by sqrt(r²−d²) — the standard
 *  capsule-beam solve (exact for horizontal rays, ≤cm error for steep
 *  ones vs a true cylindrical cast). */
function rayCapsuleEntry(eyePos: THREE.Vector3, hitT: number): number | null {
  const yLo = eyePos.y - EYE_OFFSET + PLAYER_RADIUS;
  const axisH = (PLAYER_HEIGHT - 2 * PLAYER_RADIUS); // yLo .. yLo+axisH
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
  if (d2 >= CAP_PAD * CAP_PAD) return null;
  const entry = t - Math.sqrt(CAP_PAD * CAP_PAD - d2);
  return entry < hitT ? Math.max(entry, 0) : null;
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
