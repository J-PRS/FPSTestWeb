import * as THREE from 'three';

import * as sfx from '../../core/sfx.js';
import { LightningBeam } from '../../effects/lightningBeam.js';
import { lgMuzzleAnchor } from '../lgAnchor.js';
import {
  LG_RANGE, LG_POP_DMG_CAP, LG_POP_RADIUS_MAX, LG_POP_RADIUS_MIN,
  LG_CHAIN_DMG_SCALE, LG_POP_CHARGE_MULT, LG_CHARGE_DECAY_S, lgBounceDmgScale,
} from '../../core/config.js';
import { getWeaponStats, WeaponType } from '../../../../shared/weapons.js';
import { lgTickDamage, LG_TICK_BASE, LG_RAMP_WINDOW_S } from '../../../../shared/combat.js';
import { lgTrace, pickChain, _lgHit, _lgO, _lgD } from './lightningTrace.js';
import type { CombatDeps, FireArgs, ExplosionArgs } from '../combat.js';
import type { BlastArgs } from '../blastForce.js';
import type { Targetable } from '../../entities/balls.js';

// Lightning beam scratch - rebuilt per trace, never retained
const _lgMuzzle = new THREE.Vector3(); // visual start — bottom-right of view
const _lgBallC = new THREE.Vector3();  // emitter ball world center (anchor path)

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
  ramp: Map<number, { t: number; n: number }>;
  rampP: Map<string, { t: number; n: number }>; // remote-player victims, same stepped decay
  shroud: Map<number, { sprite: THREE.Sprite; seenAt: number }>;
}
const _traceT = { t: 0 };

/** Connect sizzle — beam frying SOMETHING sounds different than beaming
 *  air: positional crackle at the contact, throttled so 22t/s doesn't smear. */
function lgSizzleTick(lg: LgState, lgNow: number, hitTarget: unknown, hitPlayerId: unknown): void {
  if (!(hitTarget || hitPlayerId) || lgNow - lg.sizzleAt <= 160) {return;}
  lg.sizzleAt = lgNow;
  sfx.lgSizzle(_lgHit);
}

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
  if (pop <= 0) {return 0;}
  if (acc - pop <= 0) {chargeBank.delete(id);} else {chargeBank.set(id, acc - pop);}
  dischargeFx?.(at, pop);
  return pop;
}

let _shroudTex: THREE.Texture | null = null;
function shroudTexture(): THREE.Texture {
  if (_shroudTex) {return _shroudTex;}
  const c = document.createElement('canvas');
  c.height = 64;
  c.width = c.height;
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

// Emitter ball: the bolt is drawn from the ball's CENTER, not a fixed
// marker — the new model carries a real energy sphere at the prong tips
// and the beam must visibly issue from inside it. Resolved once by
// largest SphereGeometry in the weapon group (the ball dwarfs the prong
// tip spheres); bakes/procedural share the search. undefined = searched
// and missed; null = not yet attempted (bake swap lands async).
function isDescendant(node: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = node; p; p = p.parent) {if (p === root) {return true;}}
  return false;
}
let lgBall: { mesh: THREE.Mesh; mat: THREE.MeshLambertMaterial } | null | undefined = undefined;
function lgBallNode(deps: CombatDeps): { mesh: THREE.Mesh; mat: THREE.MeshLambertMaterial } | null {
  const g = deps.lazyViewModel()?.weapons.get(WeaponType.Lightning);
  if (lgBall !== undefined) {
    // The baked-model swap replaces the group's children wholesale —
    // a cached mesh can be left detached with a frozen matrixWorld,
    // which reads as the beam firing from world origin. Re-search
    // whenever the ball is no longer inside the live group.
    if (lgBall && g && isDescendant(lgBall.mesh, g)) {return lgBall;}
    lgBall = undefined;
  }
  lgBall = null;
  let best: THREE.Mesh | null = null, bestR = 0;
  g?.traverse((o): void => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m.geometry as THREE.BufferGeometry).type !== 'SphereGeometry') {return;}
    m.geometry.computeBoundingSphere();
    const r = m.geometry.boundingSphere?.radius ?? 0;
    if (r > bestR) { bestR = r; best = m; }
  });
  if (best) {
    // Own material so the charge glow doesn't repaint shared bakedMat.
    const mat = ((best as THREE.Mesh).material as THREE.MeshLambertMaterial).clone();
    (best as THREE.Mesh).material = mat;
    lgBall = { mesh: best as THREE.Mesh, mat };
    // The authored muzzle marker only approximates the ball — re-park it
    // on the ball's real center once so every beam/flash consumer lands
    // exactly on the emitter, whatever model variant is loaded.
    const b = best as THREE.Mesh;
    b.updateWorldMatrix(true, false);
    const c = b.geometry.boundingSphere!.center.clone().applyMatrix4(b.matrixWorld);
    deps.lazyViewModel()?.parkMuzzleAt(WeaponType.Lightning, c);
  }
  return lgBall;
}

// Ball drives its own tell from beam state — swells + brightens while
// the bolt runs, flares harder on a biting tip. Idle ball stays dormant;
// the lerp keeps pull/release from popping.
function updateBall(deps: CombatDeps, firing: boolean, damaging: boolean, dt: number): void {
  const ball = lgBallNode(deps);
  if (!ball) {return;}
  const { mesh, mat } = ball;
  let target = 0;
  if (firing) {target = damaging ? 1 : 0.55;}
  const cur = mesh.userData.__flare ?? 0;
  const flare = cur + (target - cur) * Math.min(dt * 10, 1);
  mesh.userData.__flare = flare;
  const jitter = flare * (Math.random() - 0.5) * 0.12;
  mesh.scale.setScalar(1 + flare * 0.35 + jitter);
  // Lambert emissive on the baked ball, plain color on the procedural
  // Basic core — either way a firing ball reads charged.
  mat.emissive?.setRGB(0.25 * flare, 0.75 * flare, Number(flare));
  if (mat.emissive) {mat.emissiveIntensity = 1.5 * flare;}
}

// Beam start: the emitter ball's rendered pixel, unprojected into world
// space through the main camera — the viewmodel pass (FOV 55) and world
// pass (FOV 90) disagree, so a raw view-space offset lands on the wrong
// ray, which read as the bolt lagging the gun.
function lgAnchorLive(deps: CombatDeps, cam: THREE.Camera, out: THREE.Vector3): void {
  const player = deps.lazyPlayer();
  // Third person: the viewmodel is hidden — its muzzle node still resolves
  // to the first-person screen spot, so the beam visibly springs from mid-
  // air under the crosshair. Anchor at the body model's barrel tip instead.
  if (player.thirdPerson && player.muzzleWorld(out)) {return;}
  const vm = deps.lazyViewModel();
  // Anchor on the emitter ball's RENDERED pixel — end-to-end it rides the
  // live mesh (re-searched when a bake swap orphans the cache) so sway,
  // kick and dips all track. Muzzle node then fixed offset are fallbacks.
  const ball = lgBallNode(deps);
  if (vm && ball && vm.anchorNodeWorld(ball.mesh, cam, out)) {
    // anchorNodeWorld lands the beam on the ball's CENTER pixel — nudge
    // half a radius back toward the camera so the bolt starts at the
    // ball's near face, not inside it.
    _lgBallC.copy(out).sub(cam.position).normalize();
    out.addScaledVector(_lgBallC, -ball.mesh.geometry.boundingSphere!.radius * 0.5);
    return;
  }
  if (!vm?.muzzleAnchorWorld(WeaponType.Lightning, cam, out)) {
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
    forceMultiplier: 1,
    // Offline the pop still claims its blast; connected (dedicated OR
    // p2p host — both run beamSweep→beamPay), the authority's beam kill
    // detonates the banked charge itself.
    sendAOE: deps.lazyNetworkManager()?.authorityShells()
      ? undefined
      : (p, targetId): void => deps.lazyNetworkManager()?.sendAOEShot({ position: p, weaponType: WeaponType.Lightning, excludeTargetId: targetId }),
    explosionTint: 0x8F_DC_FF, vfxRadius: radius * 0.8, weaponType: WeaponType.Lightning,
  });
}

// Per-frame beam visual refresh — called from gameLoop AFTER
// viewModel.update so the muzzle node's swayed transform is THIS frame's,
// not one stale. Beam start = the viewmodel emitter's real position
// rotated into world space (vmScene shares the camera quaternion about
// the eye) — the bolt is welded to the rendered gun, sway and all.
function updateBeamVisual(deps: CombatDeps, lg: LgState): void {
  if (!lg.beam || !lg.beam.visible) {return;}
  const live = lg.lastFire > 0 && performance.now() - lg.lastFire <= 90;
  const cam = deps.lazyCamera();
  lgAnchorLive(deps, cam, _lgMuzzle);
  // Re-trace EVERY FRAME — the 44ms tick tip goes ~1.7m stale during a
  // strafe, and a live trace tracks the enemy's surface as it moves.
  // Damage stays per-tick; this is purely welding the visual.
  const { hitT, hitTarget, hitPlayerId, bend } = lgTrace(deps, cam, _traceT); // refreshes _lgHit at the live camera
  // Tip is welded to the trace every frame — the trace is exact, and a
  // settling spring only ever read as a broken stub whipping onto the
  // crosshair after the shaft lagged behind.
  lg.beamTo.copy(_lgHit);
  const nowV = performance.now();
  const dtV = Math.min((nowV - lg.tipAt) / 1000, 0.1);
  lg.tipAt = nowV;
  updateBall(deps, live, live && (hitTarget !== null || hitPlayerId !== null), dtV);
  if (!live) {
    // Fading bolt — keep both ends welded so it dies in place instead of
    // hanging frozen mid-air while the camera keeps moving.
    lg.beam.clearChain();
    lg.beam.weld(_lgMuzzle, lg.beamTo, cam.position, bend);
    return;
  }
  if (hitTarget) {
    const chain = pickChain(deps, _lgHit, hitTarget);
    if (chain) {lg.beam.fireChain(_lgHit, chain.pos);} else {lg.beam.clearChain();}
  } else {
    lg.beam.clearChain();
  }
  lg.beam.fire(_lgMuzzle, lg.beamTo, cam.position, hitT < LG_RANGE, hitTarget !== null || hitPlayerId !== null, bend);
}

// Beam fades ~80ms after the last tick — driven from updateProjectiles.
function tickBeam(deps: CombatDeps, lg: LgState, dt: number): void {
  if (!lg.beam) {return;}
  lg.beam.update(dt);
  const lgAge = performance.now() - lg.lastFire;
  if (lg.lastFire > 0 && lgAge > 90) {
    sfx.beamLoopStop(); // trigger dropped — ramp the hum out
    lg.lastFire = 0;
    lg.beam.clearChain();
  }
  // Ball relaxes when the bolt stops — firing path drives it per-frame
  // in updateBeamVisual; this keeps the decay alive between the last
  // tick and the 90ms visual cutoff.
  updateBall(deps, lg.lastFire > 0 && lgAge <= 90, false, dt);
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
    for (const [id, s] of lg.ramp) {if (now - s.t > LG_RAMP_WINDOW_S) {lg.ramp.delete(id);}}
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
      depthWrite: false, color: 0x9F_D8_FF,
    }));
    deps.lazyScene().add(sprite);
    sh = { sprite, seenAt: 0 };
    lg.shroud.set(t.id, sh);
  }
  sh.seenAt = now;
  sh.sprite.position.copy(t.pos);
  sh.sprite.scale.setScalar(1.5 + charge * 4);
  deps.reportTargetDamage?.(t, dmg);
  if (t.takeDamage(dmg, { serverPaid: deps.lazyNetworkManager()?.authoritySims() === true })) {
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
    ramp: new Map(), // consecutive-tick count per target — steps damage down
    rampP: new Map(),
    shroud: new Map(), // charged-enemy glow — telegraphs the banked pop
  };
  dischargeFx = (pos, amount): void => lgPop(deps, hooks, pos, amount);

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
    if (!lg.beam) {lg.beam = new LightningBeam(deps.lazyScene());}

    const { hitT, hitTarget, hitPlayerId, bend } = lgTrace(deps, cam, _traceT);

    // beamTo is display state owned by updateBeamVisual — the tick still
    // fires from the raw _lgHit so damage/explosions stay exact.
    const lgNow = performance.now();
    lg.lastFire = lgNow;
    player.lastFireAt = lgNow; // decloak-on-fire: a held beam keeps the reveal window open
    sfx.beamLoop(); // continuous drone — keepalive per tick
    // Connect sizzle — beam frying SOMETHING sounds different than beaming
    // air: positional crackle at the contact, throttled so 22t/s doesn't smear
    lgSizzleTick(lg, lgNow, hitTarget, hitPlayerId);

    // Same anchor as the per-frame refresh — one function, no drift.
    lgAnchorLive(deps, cam, _lgMuzzle);
    lg.beam.fire(_lgMuzzle, _lgHit, _lgO, hitT < LG_RANGE, hitTarget !== null || hitPlayerId !== null, bend);

    deps.lazyViewModel()?.kick(0.22); // per-tick hum — stacks into a buzz
    // Contact sparks only when the bolt actually lands on something —
    // a max-range miss is arcing into empty air, no impact to show
    if (hitT < LG_RANGE) {deps.lazyEffects().spawnImpact(_lgHit, _lgD);}
    sfx.shoot(WeaponType.Lightning);

    if (hitTarget) {
      // The drag follows the beam — a bounced bolt arrives from the
      // ground contact, so it drags toward the SKID point (not you),
      // and the pull softens in the same bands the damage does.
      const pullScale = bend ? lgBounceDmgScale(bend.distanceTo(_lgHit)) : 1;
      hitTarget.applyPull(bend ?? player.pos, stats.knockbackForce * pullScale, true);
      zapTarget(deps, hooks, lg, hitTarget, bend ? lgBounceDmgScale(bend.distanceTo(_lgHit)) : 1, cam);
      deps.lazyHud().showHitMarker();

      // Chain fork: arc from the CONTACT POINT to the nearest OTHER enemy
      // in range — half damage, but it banks its own pop charge too
      const chainT = pickChain(deps, _lgHit, hitTarget);
      if (chainT) {
        lg.beam.fireChain(_lgHit, chainT.pos);
        chainT.applyPull(hitTarget.pos, stats.knockbackForce * 0.6, true);
        zapTarget(deps, hooks, lg, chainT, LG_CHAIN_DMG_SCALE, cam);
      }
    } else {
      lg.beam?.setCharge(0); // arcing air — nothing banked, nothing to show
    }

    if (hitPlayerId) {zapPlayer(hitPlayerId, stats, bend ? lgBounceDmgScale(bend.distanceTo(_lgHit)) : 1);}
  }

  // One beam tick on a remote player: the victim can't ride the generic
  // splash (aoeDamage(5, ~1m, 1.6r) ≈ 2-3/tick — a sixth of the enemy-side
  // ramp), so they take the stepped tick directly. Bots resolve through
  // local authority, peers get the prediction until the server's aoeBeam
  // lands the identical tick.
  function zapPlayer(hitPlayerId: string, stats: ReturnType<typeof getWeaponStats>, dmgScale = 1): void {
    const nowV = performance.now() / 1000;
    const stV = lg.rampP.get(hitPlayerId);
    const nV = stV && nowV - stV.t <= LG_RAMP_WINDOW_S ? stV.n + 1 : 1;
    lg.rampP.set(hitPlayerId, { t: nowV, n: nV });
    if (lg.rampP.size > 32) {
      for (const [id, s] of lg.rampP) {if (nowV - s.t > LG_RAMP_WINDOW_S) {lg.rampP.delete(id);}}
    }
    const tick = lgTickDamage(nV) * dmgScale;
    // Same per-tick number creatures get (zapTarget) — the beam on a
    // player was hitmarker-only, which read as "beam does no damage".
    if (tick >= 1) {deps.lazyDamageNumbers().spawn(_lgHit, tick, '#8fdcff', deps.lazyCamera());}
    if (!deps.botHit?.(hitPlayerId, tick, _lgHit, 'local')) {
      deps.lazyHealthBarSystem().predictDamage(hitPlayerId, tick);
    }
    deps.lazyHud().showHitMarker();
    // No per-tick aoeShot claim — the shotFired beam intent already
    // pays the victim server-side through the same ramp/bank economy.
    // Splash sweep still runs for bystander knockback; the named victim is
    // skipped so the pin + predict above isn't double-applied.
    hooks.applyForceToRemotes({ pos: _lgHit, radius: stats.aoeRadius, force: stats.knockbackForce, forceMode: 'push', aoeDamage: stats.aoeDamage, directHitTargetId: hitPlayerId, forceMultiplier: 1 });
  }


  return { lightning, updateBeamVisual: (): void => updateBeamVisual(deps, lg), tickBeam: (dt: number): void => tickBeam(deps, lg, dt) };
}
