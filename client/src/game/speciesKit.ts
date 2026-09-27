import * as THREE from 'three';

import * as sfx from '../core/sfx.js';
import { Explosion } from '../effects/explosion.js';
import { screenShake } from '../effects/screenShake.js';
import { EMERGE_DUR, UBER_CHANCE } from '../core/config.js';
import { TargetRegistry, type TargetCandidate, type TargetProfile } from './targeting.js';
import type { Targetable } from '../entities/balls.js';
import type { EntitiesDeps } from './entities.js';

// One ambient species: a live-count cap, a spawn cadence timer, and a
// per-frame update + disposal pass over its registry. The per-species
// blocks in entities.ts are all this shape — the table kills the copy-paste.
export interface Species<T extends Targetable & { dispose(): void }> {
  list: T[];
  interval: number;
  t: number;
  spawn: () => void;
  tick: (e: T, dt: number) => void;
}

// Shared machinery every species block in entities.ts drives: the
// threat-table funnel (candidates/aggro/wander), the player-damage funnel,
// spawn-ring placement, the LOD-ticking species loop, and the small dust/
// bolt fx emitters. Nothing here owns state of its own — it operates on
// deps + the shared `targets` surface passed in.
export function createSpeciesKit(deps: EntitiesDeps, targets: Targetable[]) {
  const { scene, logger } = deps;

  // Remove a dead/disposed entity from its registry AND the shared targets
  // surface — the targets array is what projectiles and blasts iterate.
  function removeTarget<T extends Targetable>(list: T[], i: number, e: T): void {
    list.splice(i, 1);
    const ti = targets.indexOf(e);
    if (ti >= 0) targets.splice(ti, 1);
  }

  // Spawn position on a ring around the player — every ambient spawn uses it.
  function ringPos(min: number, max: number): THREE.Vector3 {
    const ang = Math.random() * Math.PI * 2;
    const dist = min + Math.random() * (max - min);
    const player = deps.lazyPlayer();
    return new THREE.Vector3(
      player.pos.x + Math.cos(ang) * dist, 0, player.pos.z + Math.sin(ang) * dist,
    );
  }

  // Enemy-contact damage funnel: knockback + server env-damage + hit flash.
  // Identical at every onHit/onSting/onClaw/onBoltHit site. `deathText` is
  // the kill-feed attribution ("devoured by a crawler") recorded in case
  // this damage is the killing blow — the server only reports 'environment'.
  function hurtPlayer(fromPos: THREE.Vector3, force: number, damage: number, deathText: string, reach?: number, attacker?: object): boolean {
    const p = deps.lazyPlayer();
    if (p.isDead) return false; // corpse shouldn't get knocked around or re-hurt
    // Victim check — a creature's bite fires for whomever ITS threat table
    // committed to. Only an EXPLICIT local commitment hurts this client: a
    // remote target means their sim claims it, and a NULL target means the
    // creature is wandering a waypoint and bit empty air — not you.
    // (Was: every bite anywhere on the map drained the local player — the
    // 300m-away phantom hits in the logs.)
    if (attacker) {
      const t = targetReg.for(attacker).target;
      if (!t || t.id !== 'local') return false;
    }
    // Reach audit — melee callers pass their contact reach. A hit landing
    // from beyond it means the trigger measured the wrong distance (the
    // old XZ-only checks tagged airborne players). WARN ships to the file
    // log so the next phantom-hit report has data attached.
    if (reach !== undefined) {
      const d = fromPos.distanceTo(p.pos);
      if (d > reach) {
        logger.warn(`melee hit beyond reach: ${deathText}`, {
          dist: +d.toFixed(2), reach: +reach.toFixed(2),
          from: { x: +fromPos.x.toFixed(1), y: +fromPos.y.toFixed(1), z: +fromPos.z.toFixed(1) },
          player: { x: +p.pos.x.toFixed(1), y: +p.pos.y.toFixed(1), z: +p.pos.z.toFixed(1) },
        });
      }
    }
    p.lastDamageSource = deathText;
    p.applyKnockback(fromPos, force);
    deps.lazyNetworkManager()?.sendEnvironmentDamage(damage);
    deps.lazyHud().showDamage(fromPos, damage); // vignette + directional arc
    sfx.playerHurt();
    return true;
  }

  // ---- Multi-player targeting -----------------------------------------
  // Every enemy owns a ThreatTable (WeakMap — no fields added to entity
  // classes). Candidates = the local player + every remote player. Solo,
  // a brain always picks 'local' and behavior is identical to before; in
  // shared PvE each species picks by its profile (see targeting.ts), and
  // damage reports from OTHER clients' hits feed the same aggro funnel.
  const targetReg = new TargetRegistry();
  const _candMap = new Map<string, TargetCandidate>();
  const _candList: TargetCandidate[] = [];
  const _zeroVel = new THREE.Vector3();

  function candidates(): TargetCandidate[] {
    const p = deps.lazyPlayer();
    let c = _candMap.get('local');
    if (!c) {
      c = { id: 'local', pos: p.pos, vel: p.vel, alive: true };
      _candMap.set('local', c);
    }
    c.alive = !p.isDead;
    const now = Date.now();
    for (const [id, r] of deps.world.remotePlayers) {
      let rc = _candMap.get(id);
      if (!rc) {
        rc = { id, pos: r.pos, vel: r.vel, alive: true };
        _candMap.set(id, rc);
      }
      // Freshness gate — a remote whose position stream froze (lost packets,
      // a stall, server hiccup) becomes a statue magnet: every hunter in
      // leash range converges on the last-seen spot and stands there biting
      // air, which reads as "all enemies deaggroed me". 2s without a
      // position update = not a valid target; the AI wanders instead.
      rc.alive = !r.isDead && (now - r.lastUpdateTime < 2000);
    }
    if (_candMap.size > deps.world.remotePlayers.size + 1) {
      for (const id of _candMap.keys()) {
        if (id !== 'local' && !deps.world.remotePlayers.has(id)) _candMap.delete(id);
      }
    }
    _candList.length = 0;
    for (const c of _candMap.values()) _candList.push(c);
    return _candList;
  }

  // Post-kill wander: with nobody alive to hate, a shared phantom made every
  // enemy converge on ONE point and freeze on it. Per-entity waypoints keep
  // each critter milling around ITS OWN position — they skitter about after
  // a kill instead of stopping dead. WeakMap — entries die with the entity.
  const wanderReg = new WeakMap<object, { wp: THREE.Vector3; t: number }>();
  function wanderFor(owner: object, selfPos: THREE.Vector3, dt: number): THREE.Vector3 {
    let w = wanderReg.get(owner);
    if (!w) {
      w = { wp: selfPos.clone(), t: 0 };
      wanderReg.set(owner, w);
    }
    w.t -= dt;
    if (w.t <= 0 || w.wp.distanceToSquared(selfPos) < 4) {
      w.t = 2 + Math.random() * 4;
      const a = Math.random() * Math.PI * 2;
      const d = 8 + Math.random() * 22;
      w.wp.set(selfPos.x + Math.cos(a) * d, 0, selfPos.z + Math.sin(a) * d);
      w.wp.y = deps.lazyTerrain().getHeight(w.wp.x, w.wp.z) + 2;
    }
    return w.wp;
  }

  // The chase position for an enemy this frame: its committed threat-table
  // target, or a personal wander waypoint when nobody's alive to hate.
  // `owner` is any object — the brain lives in WeakMaps keyed by identity.
  function aggroFor(owner: object, selfPos: THREE.Vector3, dt: number, profile: TargetProfile): THREE.Vector3 {
    const t = targetReg.for(owner).update(dt, selfPos, candidates(), profile);
    return t ? t.pos : wanderFor(owner, selfPos, dt);
  }

  // Target VELOCITY for predictive species (totem lead, seeker aim) — the
  // committed target's vel, not always the local player's.
  function aggroVelFor(e: object): THREE.Vector3 {
    return targetReg.for(e).target?.vel ?? _zeroVel;
  }

  // Combat reports damage here — the aggro hook. 'local' today; shared
  // PvE delivers remote playerIds through the same funnel.
  function reportTargetDamage(e: object, amount: number, attackerId = 'local'): void {
    targetReg.reportDamage(e, attackerId, amount);
  }

  // Compact orange pop shared by turret shells, totem bolts, mines — reads
  // as a small explosion, not a rocket.
  function boltPop(pos: THREE.Vector3, scale: number, color: number, shake: number): void {
    deps.world.explosions.push(new Explosion(scene, pos, false, 0, deps.lazyTerrain(), scale, color));
    screenShake.blast(pos, shake, deps.lazyPlayer().pos);
    sfx.explosionAt(pos, false);
  }

  // ?spawns=random — waveDirector's flat random mode suppresses ambient
  // per-species spawn timers so the total budget isn't double-spent.
  const RANDOM_SPAWNS = new URLSearchParams(location.search).get('spawns') === 'random';

  // AI LOD — distant enemies tick at reduced rate so swarm counts don't
  // scale the CPU linearly. Accumulated dt keeps AI math time-correct;
  // 20Hz mid / 5Hz far is invisible at those distances.
  const AI_LOD_MID_SQ = 120 * 120;
  const AI_LOD_FAR_SQ = 300 * 300;
  const AI_LOD_MID_DT = 1 / 20;
  const AI_LOD_FAR_DT = 1 / 5;
  const lodAcc = new WeakMap<Targetable, number>();

  function updateSpecies<T extends Targetable & { dispose(): void }>(s: Species<T>, dt: number): void {
    s.t += dt;
    if (s.t >= s.interval) {
      s.t = 0;
      // Ambient spawning is owned by this one path — director spawns are
      // gated in gameLoop. (Per-species spawn fns that guard on isPlaying
      // anyway are harmless defense — director events call them directly.)
      // ?spawns=random: ambient timers stay off — the random director
      // owns population so the total budget isn't double-spent.
      if (!RANDOM_SPAWNS && !deps.lazyDemoManager()?.isPlaying) s.spawn();
    }
    const playerPos = deps.lazyPlayer().pos;
    for (let i = s.list.length - 1; i >= 0; i--) {
      const e = s.list[i]!;
      const dSq = e.pos.distanceToSquared(playerPos);
      if (dSq > AI_LOD_FAR_SQ) {
        const acc = (lodAcc.get(e) ?? 0) + dt;
        if (acc >= AI_LOD_FAR_DT) { lodAcc.set(e, 0); s.tick(e, acc); } else lodAcc.set(e, acc);
      } else if (dSq > AI_LOD_MID_SQ) {
        const acc = (lodAcc.get(e) ?? 0) + dt;
        if (acc >= AI_LOD_MID_DT) { lodAcc.set(e, 0); s.tick(e, acc); } else lodAcc.set(e, acc);
      } else {
        s.tick(e, dt);
      }
      if (e.dead) {
        lodAcc.delete(e);
        e.dispose();
        removeTarget(s.list, i, e);
      }
    }
  }

  // Ground species slide up out of the dirt instead of popping into existence.
  // emergeT counts down inside each class's update; emergeRestY is the resting
  // surface height the spawn constructor already resolved.
  function burrow(e: { emergeT: number; emergeDepth: number; emergeRestY: number; radius: number; pos: THREE.Vector3 }): void {
    e.emergeT = EMERGE_DUR;
    e.emergeDepth = e.radius * 2.2;
    e.emergeRestY = e.pos.y;
    deps.lazyEffects().spawnJumpDust(e.pos);
  }

  // Rare uber roll — ambient (no-pos) spawns only. Event/demo/director
  // spawns pass an explicit pos and never surprise-upgrade unless asked.
  const rollUber = (): boolean => Math.random() < UBER_CHANCE;

  // Ground dust: distance-based emission, so faster movers naturally puff
  // more and a standing creature puffs nothing. SpawnMoveDust scales the
  // puff itself by speed + body radius — rollers roostertail, grubs barely
  // stir the dirt. Per-entity accumulator dies with the entity.
  const dustAcc = new WeakMap<Targetable, number>();
  function kickDust(e: { dead: boolean; pos: THREE.Vector3; vel: THREE.Vector3; radius: number } & Targetable, dt: number): void {
    if (e.dead) return;
    const sp = Math.hypot(e.vel.x, e.vel.z);
    if (sp < 2) return; // creepers don't raise dust
    const gy = deps.lazyTerrain().getHeight(e.pos.x, e.pos.z);
    if (e.pos.y - gy > e.radius * 2.5) return; // airborne — no ground contact
    const acc = (dustAcc.get(e) ?? 0) + sp * dt;
    const spacing = e.radius * 1.5 + 0.4;
    if (acc >= spacing) {
      dustAcc.set(e, acc - spacing);
      deps.lazyEffects().spawnMoveDust(e.pos, e.vel, sp, e.radius);
    }
  }

  // Flyer slipstream — same distance-accumulator pattern as kickDust but
  // sparser, higher speed floor, and subtle by design: singular fliers
  // only (rakks, seekers, overlords). NOT for boid clouds or buzzards —
  // a hundred faint motes is a hundred draw-submit worth of noise.
  const trailAcc = new WeakMap<Targetable, number>();
  function kickTrail(e: { dead: boolean; pos: THREE.Vector3; vel: THREE.Vector3 } & Targetable, dt: number): void {
    if (e.dead) return;
    const sp = Math.hypot(e.vel.x, e.vel.z);
    if (sp < 6) return; // hovering/circling slow = no trail
    const acc = (trailAcc.get(e) ?? 0) + sp * dt;
    const spacing = 2.5 + Math.random() * 1.5; // irregular — no dotted-line uniformity
    if (acc >= spacing) {
      trailAcc.set(e, acc - spacing);
      deps.lazyEffects().spawnFlyTrail(e.pos, e.vel, sp);
    }
  }

  return {
    removeTarget, ringPos, hurtPlayer,
    aggroFor, aggroVelFor, reportTargetDamage,
    boltPop, updateSpecies, burrow, rollUber, kickDust, kickTrail,
  };
}
