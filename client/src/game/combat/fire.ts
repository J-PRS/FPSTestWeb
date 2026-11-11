import * as THREE from 'three';

import * as sfx from '../../core/sfx.js';
import { Explosion } from '../../effects/explosion.js';
import { screenShake } from '../../effects/screenShake.js';
import { Projectile } from '../../projectiles/Projectile.js';
import {
  GRENADE_CONFIG, BELT_DISC_CONFIG, BELT_DISC_PUSH_CONFIG, BELT_STICKY_CONFIG,
  CLUSTER_CONFIG, JAVELIN_CONFIG, IMPACT_CONFIG, REMOTE_RAILGUN_CONFIG,
  ARMORNADE_CONFIG, PROXY_CONFIG, SATCHEL_CONFIG, HEALNADE_CONFIG,
  CONC_CONFIG, HOOK_CONFIG, EMP_CONFIG,
} from '../../projectiles/index.js';
import { simRand } from '../../../../shared/simRand.js';
import type { WeaponDef } from '../../weapons.js';
import { BELT_THROW_TIME, type BeltItem } from '../../entities/Player.js';
import type { ProjectileConfig } from '../../projectiles/types.js';
import { THROW_RELEASE, SWING_CONTACT_T, SWING_STRIKE_T } from '../../entities/ViewModel.js';
import { spawnDrift } from '../../debug/netProbe.js';
import {
  EXPLOSION_VFX_RADIUS, MELEE_RANGE, MELEE_ARC_DOT, MELEE_DAMAGE, SCORCH_MAX,
} from '../../core/config.js';
import { ScorchDecal } from '../../effects/scorch.js';
import { fxPuff } from '../../effects/vfx.js';
import { swingArcView } from '../../effects/swingTrails.js';
import { getWeaponStats, WeaponType, beltThrowCost, serverSimmed, payShotCost, spendAmmo, jitter01, coneDir } from '../../../../shared/weapons.js';
import { classCanFire } from '../../../../shared/botClasses.js';
import { idSeed } from '../../../../shared/weaponTable.js';
import type { CombatDeps, FireArgs } from '../combat.js';
import type { WorldState } from '../worldState.js';
import type { BlastArgs } from '../blastForce.js';
import type { Targetable } from '../../entities/balls.js';
import { nextShotId } from '../projectileRegistry.js';

// Flak/shotgun spread basis — rebuilt per shot, never retained
const _flakRight = new THREE.Vector3();
const _flakUp = new THREE.Vector3();
const _flakUp0 = new THREE.Vector3(0, 1, 0);
const _flakDir = new THREE.Vector3();
const _meleeHitPos = new THREE.Vector3();
const _meleeToT = new THREE.Vector3();
const _meleeProbe = new THREE.Vector3();

export interface FireHooks {
  onTargetDestroyed: (t: Targetable, impulse?: THREE.Vector3, weaponType?: number) => void;
  applyForceToRemotes: (a: BlastArgs) => void;
}

// Weapon trigger handlers: every onX translates a FireArgs into spawned
// projectiles (or a melee sweep), kicks the viewmodel, and reports the shot
// to the server. The explosion/impact side lives in combat.ts.
// Muzzle lead: shells spawn at the EYE (FireEvent origin = player.pos)
// so every shot's glow envelope materializes wrapped around the camera —
// a half-meter push down the aim line clears the near plane. The CLAIMED
// spawn moves too (same origin in the shot message), keeping server
// tracking and remote replicas consistent with what the shooter sees.
const MUZZLE_LEAD = 1;
// Shoulder drop (third person only): the eye-point origin reads as
// forehead-fired on the chase cam — a small parallel offset puts the
// launch at chest/gun height. First person keeps the Quake rule:
// spawn exactly on the aim line from the eye/crosshair. The offset
// rides the claimed origin, so what the 3P shooter sees is what
// remote replicas render.
const SHOULDER_DROP = 0.35;
const _spawnOrigin = new THREE.Vector3();


/** Latest sample at-or-before (now - backMs); older than the whole ring
 *  clamps to the oldest entry. Exported for ghost-epoch reads that need
 *  a caller-chosen back-off (remote-shell body sweeps). */
export function histAt(hist: WorldState['localPosHistory'], backMs: number): WorldState['localPosHistory'][number] | undefined {
  if (hist.length === 0) {return undefined;}
  const tAt = performance.now() - backMs;
  let s = hist[0]!;
  for (const h of hist) {if (h.t <= tAt) {s = h;}}
  return s;
}



function spawnProjectile(deps: CombatDeps, config: ProjectileConfig, e: FireArgs, quiet = false): Projectile | undefined {
  // Same law as combat.ts's onWeaponFire gate: a weapon the authority
  // calls class-locked must not spawn a predicted shell or send an
  // intent - every pull otherwise spam-rejects for the life (belt
  // throws reach this without passing fireWeapon).
  if (!deps.lazyPlayer().armory.kitLocked && !classCanFire(deps.lazyPlayer().appliedClass, config.weaponType)) {return undefined;}
  // One-shot TTS (time-to-shoot) marker - invisible, no debug overlays.
  // Records the first fired shot's performance.now() (ms since navigation
  // start) on dev hosts or when ?tts=1 is present. Production https builds
  // without the param never record it.
  const _w = window as any;
  if (_w.__ttsShot === undefined
      && (import.meta.env.DEV || window.location.protocol !== 'https:'
          || new URLSearchParams(window.location.search).has('tts'))) {
    _w.__ttsShot = performance.now();
    try { performance.mark('tts:shot'); } catch { /* ignore */ }
  }
  if (deps.inputTracking.isTabHidden()) {return undefined;}
  if (deps.lazyDemoManager()?.isPlaying) {return undefined;}

  if (!quiet) {sfx.shoot(config.weaponType);}
  // Decloak-on-fire: bot senses mask this player's cloak for the reveal
  // window, same rule the server applies to its own bots.
  deps.lazyPlayer().lastFireAt = performance.now();
  _spawnOrigin.copy(e.origin).addScaledVector(e.dir, MUZZLE_LEAD);
  if (deps.lazyPlayer().thirdPerson) {_spawnOrigin.y -= SHOULDER_DROP;}
  // INSTANT SHOOTING: pure client spawn — the predicted shell leaves
  // the live muzzle, always. (Rewind-mirroring the server's birth epoch
  // made the spawn point ping-dependent — shells visibly spawned ~1m
  // behind a fast skier and blended forward over ~150ms. The server
  // still rewinds its own authoritative shell; any arc divergence is
  // an echo-bind problem, not a feel problem — trajDiv watches it.)
  // Every spawn below claims a wire identity — the nonce is what binds
  // the projectileCreated echo back to this shell. Minting only for
  // needsServerTracking left untracked shells (bomblets, MRV children)
  // registering server-side with no id to link: 'no local shell' warns.
  // needsServerTracking keeps governing the damage-claim path; the nonce
  // costs a map entry, pruned on death.
  const shotId = nextShotId(deps.world.projectileRegistry);
  // Bloom weapons: the CLAIM ships the raw aim dir - the server seeds
  // the cone itself off this shotId. The predicted shell draws the same
  // jitter so prediction lands inside the server's scatter, not its own.
  let spawnDir = e.dir;
  if (e.bloomRadius !== undefined) {
    // Counter-seeded cone - the server draws idSeed(playerId) ^ seq; the
    // local player id mirrors the counter per pull (lockstep off rejects).
    const [u1, u2] = jitter01(idSeed(deps.lazyNetworkManager().getLocalPlayerId()) ^ (e.bloomSeq ?? 0));
    const jd = coneDir(e.dir, u1 * Math.PI * 2, Math.sqrt(u2) * e.bloomRadius);
    spawnDir = _flakDir.set(jd.x, jd.y, jd.z).clone();
  }
  // Momentum perk: cap the launch speed, pay the excess back as a
  // direct-hit bonus stamped on the shell (orig/cap, capped at 1.5x).
  // cfg2 drives BOTH the local sim and the wire claim below - the
  // server's arc replay must see the capped flight or it diverges.
  const cap = deps.lazyPlayer().mods.projSpeedCap;
  // maxLifetime scales by the same cut ratio so the capped shell keeps
  // its original flight RANGE (slower = longer alive, not shorter reach).
  const cfg2 = cap > 0 && config.speed > cap
    ? Object.assign({}, config, { speed: cap, maxLifetime: (config.maxLifetime ?? 12) * (config.speed / cap) })
    : config;
  const bonus = cap > 0 && config.speed > cap ? Math.min(1.5, config.speed / cap) : 1;
  const p = new Projectile(deps.lazyScene(), _spawnOrigin, spawnDir, e.playerVel, cfg2);
  p.directBonus = bonus;
  deps.world.projectiles.push(p);
  p.shooterTeam = deps.world.localTeam ?? null;
  p.shotId = shotId;
  deps.world.projectileRegistry.byShotId.set(p.shotId, p);

  // Record projectile fired event for demo
  const demoManager = deps.lazyDemoManager();
  if (demoManager?.isRecording) {
    const velocity = e.dir.clone().normalize().multiplyScalar(cfg2.speed).addScaledVector(e.playerVel, config.inherit ?? 0.5);
    p.demoProjectileId = demoManager.recordProjectileFired(
      { x: _spawnOrigin.x, y: _spawnOrigin.y, z: _spawnOrigin.z },
      { x: velocity.x, y: velocity.y, z: velocity.z },
      config.weaponType
    );
    p.onDemoBounce = (pos, vel, normal): void => {
      if (p.demoProjectileId) {demoManager.recordProjectileBounce(p.demoProjectileId, pos, vel, normal);}
    };
  }

  // Ray-burst discharge (remote railgun): beam flash along the slug's
  // velocity line + capacitor zap at the discharge point. The damage is
  // the normal explosion claim at the resolved endpoint — this is pure FX.
  if (config.rayBurst) {
    const beamColor = config.glowColor;
    p.onRayBurst = (from, to): void => {
      deps.lazyEffects().spawnBeam(from, to, beamColor);
      sfx.at(from, 'shot_energy', 0.9, 1.3);
    };
  }

  // Send shot to server with projectile position/velocity so remote clients
  // see the shot (all weapons, weaponType selects their visual config).
  // The claim MUST carry the same inherited-velocity flight the
  // Projectile sim runs — omitting playerVel*0.5 makes the server's
  // arcBlockedAt replay a slower, undeflected arc that clips walls the
  // real shell cleared ("flight blocked" rejects on honest hits).
  const velocity = e.dir.clone().normalize().multiplyScalar(cfg2.speed).addScaledVector(e.playerVel, 0.5);
  // NetProbe: claimed-vs-flown drift - must stay ~0 or the server's
  // arc replay diverges (the 'flight blocked' phantom-reject class).
  // Jittered shells (bloom/spread cones) SKIP this: their claim is the
  // RAW aim dir by design - the server re-derives the identical seeded
  // jitter off shotId, so |claimVel - p.vel| measures the cone angle,
  // not a bug (chaingun spray read as a 24 m/s "drift" storm).
  if (e.bloomRadius === undefined) {spawnDrift(velocity.distanceTo(p.vel));}
  if (serverSimmed(config.weaponType)) {
    // Claimless path: the intent is all we send — the server spawns its
    // own authoritative shell and echoes shotId on projectileCreated,
    // which linkOwnProjectile binds to this predicted shell. Contact
    // and blast outcomes arrive as broadcasts; nothing is claimed here.
    // quiet = one pellet of a burst fan: the pull sends ONE intent and
    // the server fans the whole spread itself, echoing a pellet index.
    if (!quiet) {
      deps.lazyNetworkManager().sendShotFired({
        weaponType: config.weaponType,
        dir: { x: e.dir.x, y: e.dir.y, z: e.dir.z },
        pos: { x: _spawnOrigin.x, y: _spawnOrigin.y, z: _spawnOrigin.z },
        // The claim carries our live velocity so the server spawns with
        // the SAME inherited flight — the echo then matches prediction
        // and reanchorTo converges to ~zero instead of a mid-air jink.
        vel: { x: e.playerVel.x, y: e.playerVel.y, z: e.playerVel.z },
        shotId: p.shotId ?? undefined,
      });
    }
    return p;
  }
  // Non-simmed shells (bomblets, cookoff scatter) are prediction-only —
  // the server's own carrier/body sim owns every authoritative spawn,
  // so nothing claims a spawn over the wire anymore.
  return p;
}

// Belt items release mid-throw-anim; compute fresh aim at release time
// (player may be skiing fast — stale origin would be meters off)
function freshFireArgs(deps: CombatDeps): FireArgs {
  const player = deps.lazyPlayer();
  return {
    origin: player.pos.clone(),
    dir: new THREE.Vector3(
      Math.cos(player.pitch) * Math.sin(player.yaw),
      Math.sin(player.pitch),
      Math.cos(player.pitch) * Math.cos(player.yaw)
    ).normalize(),
    playerVel: player.vel.clone(),
  };
}

// Belt loadout → the projectile it throws. Belt sticky reuses the
// launcher's glue bomb — same fuse, same chain rule, hand-thrown arc.
const BELT_THROWS: Record<BeltItem, ProjectileConfig> = {
  disc: BELT_DISC_CONFIG,
  pushdisc: BELT_DISC_PUSH_CONFIG,
  grenade: GRENADE_CONFIG,
  cluster: CLUSTER_CONFIG,
  javelin: JAVELIN_CONFIG,
  sticky: BELT_STICKY_CONFIG,
  impact: IMPACT_CONFIG,
  conc: CONC_CONFIG,
  remoterailgun: REMOTE_RAILGUN_CONFIG,
  armornade: ARMORNADE_CONFIG,
  proxy: PROXY_CONFIG,
  satchel: SATCHEL_CONFIG,
  heal: HEALNADE_CONFIG,
  hook: HOOK_CONFIG,
  emp: EMP_CONFIG,
};

function onBelt(deps: CombatDeps, _e: FireArgs, item: BeltItem): void {
  const p = deps.lazyPlayer();
  // Ordnance economy: a dry belt can't throw — server enforces the same
  // rule on the spawn claim, this gate just saves the animation/no-op.
  const config = BELT_THROWS[item] ?? BELT_DISC_CONFIG;
  const cost = beltThrowCost(config.weaponType);
  if (p.beltCharges < cost) {return;}
  // Some throws are a deliberate plant, not a flick — the anim stretch and
  // the release delay must agree or the bomb leaves the hand early.
  const timeScale = BELT_THROW_TIME[item] ?? 1;
  deps.lazyViewModel()?.startThrow(timeScale);
  // Dying mid wind-up must not release — the server rejects dead-player
  // claims, leaving a local ghost projectile.
  setTimeout((): void => {
    const pl = deps.lazyPlayer();
    if (pl.isDead || pl.beltCharges < cost) {return;}
    pl.beltCharges -= cost;
    // The javelin's juice is the THROW — a speedline whip on release so a
    // spear leaving the hand reads as force, not a lob.
    if (item === 'javelin') {deps.lazySpeedLines?.().burst();}
    spawnProjectile(deps, config, freshFireArgs(deps));
  }, THROW_RELEASE * timeScale * 1000);
}

// Pellet fan (flak/shotgun): one trigger = a poisson-disc spread of
// projectiles — even coverage without clumping, rotated per shot so the
// pattern isn't visually memorized. One shot sfx for the whole burst.
function spawnFan(deps: CombatDeps, config: ProjectileConfig, e: FireArgs, count: number, spread: number): void {
  sfx.shoot(config.weaponType);
  const simmed = serverSimmed(config.weaponType);
  // Authority fans are a deterministic Vogel spiral (RoomProjectiles.spawn)
  // - predicting a different point set guarantees every pellet re-anchors
  // onto a foreign arc and ghosts hits the server can't make. Same basis,
  // same index order; shared stats override the def's cosmetic values.
  const st = getWeaponStats(config.weaponType);
  const n = simmed && st?.burst ? st.burst : count;
  const sp = simmed && st?.pelletSpread !== undefined ? st.pelletSpread : spread;
  let rx = -e.dir.z, rz = e.dir.x; const ry = 0;
  const rl = Math.hypot(rx, rz);
  if (rl < 1e-8) {rx = 1; rz = 0;} else {rx /= rl; rz /= rl;}
  const ux = ry * e.dir.z - rz * e.dir.y, uy = rz * e.dir.x - rx * e.dir.z, uz = rx * e.dir.y - ry * e.dir.x;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const registry = deps.world.projectileRegistry;
  // Simmed fans ride ONE intent per pull — the server fans the spread
  // itself and echoes pellet indices, so each predicted pellet registers
  // under its own `${pullId}#${idx}` slot for the echo bind.
  const pullId = simmed ? nextShotId(registry) : '';
  for (let i = 0; i < n; i += 1) {
    const r = Math.sqrt((i + 0.5) / n) * sp;
    const a = i * golden;
    const ox = Math.cos(a) * r, oy = Math.sin(a) * r;
    _flakDir.set(
      e.dir.x + rx * ox + ux * oy,
      e.dir.y + ry * ox + uy * oy,
      e.dir.z + rz * ox + uz * oy).normalize();
    const p = spawnProjectile(deps, config, { origin: e.origin, dir: _flakDir.clone(), playerVel: e.playerVel }, true);
    if (p && simmed) {
      p.fanSlot = `${pullId}#${i}`;
      p.pullShotId = pullId;
      registry.byFanSlot.set(p.fanSlot, p);
    }
  }
  if (simmed) {
    deps.lazyNetworkManager().sendShotFired({
      weaponType: config.weaponType,
      dir: { x: e.dir.x, y: e.dir.y, z: e.dir.z },
      pos: { x: e.origin.x, y: e.origin.y, z: e.origin.z },
      vel: { x: e.playerVel.x, y: e.playerVel.y, z: e.playerVel.z },
      shotId: pullId,
    });
  }
}

// Trigger dispatch: kick + spawn shape come from the def. 'beam' never
// reaches here — combat.ts routes it to the lightning module, which owns
// its own tick/raycast loop.
function fireWeapon(deps: CombatDeps, def: WeaponDef, e: FireArgs): void {
  // Class lock ahead of every spend — a refused pull must not charge
  // energy or ammo, and must not spawn the ghost shell prediction.
  if (!deps.lazyPlayer().armory.kitLocked && !classCanFire(deps.lazyPlayer().appliedClass, def.config.weaponType)) {return;}
  // Energy-paid weapons (Blaster): the jet tank IS the magazine — the
  // shared payShotCost gate keeps client prediction, server intent and
  // bot fire on one formula; a dry tank can't draw a ghost bolt.
  if (!payShotCost(def.config.weaponType, '', (): number => deps.lazyPlayer().energy,
    (_id, n): void => { const pl = deps.lazyPlayer(); pl.energy = Math.max(0, pl.energy - n); })) {return;}
  // Pool ammo (PlasmaGun pilot): the predicted debit mirrors the server's
  // intent gate - a desync reject just closes the ledger, no ghost bolt.
  if (!spendAmmo(deps.lazyPlayer().ammoPool, def.config.weaponType, performance.now() / 1000)) {return;}
  // Deploy weapons (howitzer): feet on dirt and not skiing, or the pull
  // is dead. Ahead of the recoil arm so a refused shot can't arm it.
  if (getWeaponStats(def.config.weaponType).groundedOnly
    && (!deps.lazyPlayer().onGround || deps.lazyPlayer().getInputState().skiHeld)) {return;}
  // Launcher recoil (howitzer): momentum opposite the shot. Aimed up off
  // dirt the kick is the fall damage; airborne it's propulsion.
  const recoil = getWeaponStats(def.config.weaponType).recoilImpulse ?? 0;
  if (recoil > 0) {
    deps.lazyPlayer().movement.impulse({ x: -e.dir.x * recoil, y: -e.dir.y * recoil, z: -e.dir.z * recoil });
    // The kick alone under-measures as a fall - arm the sim's fall
    // multiplier so the next landing reads the impact it felt like.
    deps.lazyPlayer().movement.armFallBoost(3);
  }
  deps.lazyViewModel()?.kick(def.kick);
  if (def.pellets) { spawnFan(deps, def.config, e, def.pellets.count, def.pellets.spread); return; }
  if (def.bloom) {
    // Bloom: claim the RAW aim dir - the server owns the cone. The
    // predicted shell jitters inside spawnProjectile off the same
    // shotId seed. player.bloom drives both the jitter radius here and
    // the HUD arms; it grows after the shot lands, like the server's.
    const pl = deps.lazyPlayer();
    spawnProjectile(deps, def.config, { origin: e.origin, dir: e.dir, playerVel: e.playerVel,
      bloomRadius: def.bloom.base + pl.bloom, bloomSeq: pl.bloomSeq++ });
    pl.bloom = Math.min(def.bloom.max, (pl.bloom + def.bloom.rate) * def.bloom.exp);
    pl.bloomDecay = def.bloom.decay; // residue drains at the growing weapon's rate (swap-safe)
    return;
  }
  if (def.spread) {
    // Stream jitter: a random cone offset per bolt — same basis math as
    // the fan but a single drifting shot, so the volley reads as a hose.
    _flakRight.crossVectors(e.dir, _flakUp0);
    if (_flakRight.lengthSq() < 1e-8) {_flakRight.set(1, 0, 0);} else {_flakRight.normalize();}
    _flakUp.crossVectors(_flakRight, e.dir);
    const a = simRand() * Math.PI * 2, r = Math.sqrt(simRand()) * def.spread;
    _flakDir.copy(e.dir)
      .addScaledVector(_flakRight, Math.cos(a) * r)
      .addScaledVector(_flakUp, Math.sin(a) * r)
      .normalize();
    spawnProjectile(deps, def.config, { origin: e.origin, dir: _flakDir.clone(), playerVel: e.playerVel });
    return;
  }
  spawnProjectile(deps, def.config, e);
}

// Terrain contact: march the fist ray against the heightfield. A swing
// that reaches dirt relocates the whole punch FX to the contact point —
// punching the ground should read as punching the ground, not air near it.
function meleeGroundContact(playerPos: THREE.Vector3, dir: THREE.Vector3, terrain: ReturnType<CombatDeps['lazyTerrain']>): THREE.Vector3 | null {
  for (let d = 0.4; d <= MELEE_RANGE; d += 0.4) {
    _meleeProbe.copy(playerPos).addScaledVector(dir, d);
    if (_meleeProbe.y - terrain.getHeight(_meleeProbe.x, _meleeProbe.z) < 0.4) {
      return _meleeProbe.clone();
    }
  }
  return null;
}

// Swing presentation: the swipe that sells the arc, the punch puff at
// the resolved contact point, a scorch + dirt spray + thud on terrain
// hits, and the camera kick. All visuals — the damage/force side stays
// in melee() below.
//
// The FX are TIMED TO THE ANIMATION, not to the keypress: the whoosh
// goes with the strike and the impact lands on the contact frame ~130ms
// later. Feedback that arrives before the hammer does reads as lag
// rather than weight, and the hit number popping a beat after the press
// is what sells the connect.
function meleeSwingFx(deps: CombatDeps, e: FireArgs, fxPos: THREE.Vector3, groundHit: THREE.Vector3 | null, hitAt: THREE.Vector3[]): void {
  const player = deps.lazyPlayer();
  const stats = getWeaponStats(WeaponType.Melee);
  const landed = hitAt.length > 0;
  deps.lazyViewModel()?.swing(landed); // landed = connect dwell — the hammer stops on them
  // The whoosh and the slash arc belong to the STRIKE, not to the press:
  // the smear appearing a frame after the keypress read as a white flash
  // that landed before the hammer did.
  window.setTimeout((): void => {
    sfx.shoot(WeaponType.Melee);
    // The slash arc — the actual "swing" read. One smear along the chop
    // (the hammer smacks sideways), pinned to the camera so it can't lag
    // behind at speed. It peaks with the contact and fades after it.
    swingArcView(deps.lazyScene(), deps.lazyCamera());
  }, SWING_STRIKE_T * 1000);
  window.setTimeout((): void => {
    const at = landed ? hitAt[0]! : (groundHit ?? fxPos);
    deps.world.explosions.push(new Explosion(
      deps.lazyScene(), at, true, 0, deps.lazyTerrain(),
      (stats.aoeRadius * 0.7) / EXPLOSION_VFX_RADIUS, 0xAA_DD_FF, 'punch',
    ));
    screenShake.blast(at, stats.aoeRadius, player.pos);
    if (landed) {
      // The number pops WITH the hit, not with the press.
      for (const h of hitAt) {deps.lazyDamageNumbers().spawn(h, MELEE_DAMAGE, '#aaddff', deps.lazyCamera());}
      deps.lazyHud().showHitMarker();
      // The crack that sells it — positional impact on a confirmed hit.
      sfx.at(at, 'impact', 1);
      sfx.hitMarker(true);
      // Contact sparks + a shake bump — feedback that says HOW HARD.
      fxPuff(at, {
        count: 10, pos: [0.3, 0.3, 0.3],
        velMin: [-5, 1, -5], velMax: [5, 6, 5],
        lifeMin: 0.12, lifeMax: 0.35, sizeScale: 1,
        colA: [0.6, 0.85, 1], colB: [0.3, 0.5, 0.9], additive: true,
      });
      screenShake.add(0.22);
    }
    if (groundHit) {
      if (deps.world.scorches.length >= SCORCH_MAX) {deps.world.scorches.shift()!.dispose();}
      deps.world.scorches.push(new ScorchDecal(deps.lazyScene(), deps.lazyTerrain(), groundHit, 1.4));
      // Dirt spray kicked up off the fist — brown, gravity-bound, short.
      fxPuff(groundHit, {
        count: 14, pos: [0.4, 0.1, 0.4],
        velMin: [-3.5, 2.5, -3.5], velMax: [3.5, 8, 3.5],
        lifeMin: 0.25, lifeMax: 0.7, sizeScale: 1.6,
        colA: [0.32, 0.26, 0.18], colB: [0.5, 0.42, 0.3],
      });
      sfx.at(groundHit, 'slam_thud', 0.9);
      screenShake.add(0.28);
    }
    deps.lazySpeedLines?.().surge(player.pos, at, 0xAA_DD_FF, 8);
    screenShake.swingKick(1, landed);
  }, SWING_CONTACT_T * 1000);
}

// Melee sweep — the arc check happens around a point pushed forward
// centered ahead of the fist so the puncher is outside its own radius.
function melee(deps: CombatDeps, hooks: FireHooks, e: FireArgs): void {
  const player = deps.lazyPlayer();
  const stats = getWeaponStats(WeaponType.Melee);
  player.lastFireAt = performance.now(); // decloak-on-fire — see spawnProjectile
  _meleeHitPos.copy(player.pos).addScaledVector(e.dir, MELEE_RANGE * 0.7);

  const groundHit = meleeGroundContact(player.pos, e.dir, deps.lazyTerrain());

  // Connected rooms pay the creature cone from the swing intent itself
  // (server derives pos/dir) — claiming the contact too would double-pay.
  const serverPaid = deps.lazyNetworkManager()?.authoritySims() === true;

  // Hit positions are banked; the FEEDBACK fires on the animation's
  // contact frame (see meleeSwingFx). The damage itself resolves now —
  // the server adjudicates the swing intent, and a late damage apply
  // would desync the predicted health.
  const hitAt: THREE.Vector3[] = [];
  for (const t of deps.targets) {
    if (t.dead) {continue;}
    _meleeToT.copy(t.pos).sub(player.pos);
    const dist = _meleeToT.length();
    if (dist > MELEE_RANGE + (t.hitRadius ?? t.radius)) {continue;}
    _meleeToT.divideScalar(dist || 1);
    if (_meleeToT.dot(e.dir) < MELEE_ARC_DOT) {continue;}
    t.applyKnockback(player.pos, stats.knockbackForce, true); // directed shove — server recomputes the same impulse in meleeSweep
    hitAt.push(t.pos.clone());
    deps.reportTargetDamage?.(t, MELEE_DAMAGE);
    if (t.takeDamage(MELEE_DAMAGE, { serverPaid })) {hooks.onTargetDestroyed(t, t.vel, WeaponType.Melee);}
    else if (!t.hideHealthBar) {deps.lazyHealthBarSystem().spawnBall(t, MELEE_DAMAGE, t.health);}
  }

  // Swing FX — the swing itself plus the contact-frame feedback.
  meleeSwingFx(deps, e, groundHit ?? _meleeHitPos, groundHit, hitAt);

  // The swing intent rides shotFired — the server derives the arc point
  // itself and relays the fire for observers. pos rides along so the
  // sweep anchors at the claimed eye, not an estimated rewind.
  const networkManager = deps.lazyNetworkManager();
  if (networkManager?.isConnected()) {
    networkManager.sendShotFired({
      weaponType: WeaponType.Melee, dir: { x: e.dir.x, y: e.dir.y, z: e.dir.z },
      pos: { x: e.origin.x, y: e.origin.y, z: e.origin.z },
    });
  }
  hooks.applyForceToRemotes({ pos: _meleeHitPos, radius: stats.aoeRadius, force: stats.knockbackForce, forceMode: 'push', aoeDamage: stats.aoeDamage, directHitTargetId: null, forceMultiplier: 1, weaponType: WeaponType.Melee });
}
export function createFire(deps: CombatDeps, hooks: FireHooks) {

  return {
    spawnProjectile: (c: ProjectileConfig, e: FireArgs, quiet = false): Projectile | undefined => spawnProjectile(deps, c, e, quiet),
    fireWeapon: (d: WeaponDef, e: FireArgs): void => fireWeapon(deps, d, e),
    onBelt: (e: FireArgs, item: BeltItem): void => onBelt(deps, e, item),
    onMelee: (e: FireArgs): void => melee(deps, hooks, e),
  };
}
