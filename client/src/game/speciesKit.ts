import * as THREE from 'three';

import * as sfx from '../core/sfx.js';
import { Explosion } from '../effects/explosion.js';
import { screenShake } from '../effects/screenShake.js';
import { EMERGE_DUR, UBER_CHANCE } from '../core/config.js';
import { urlParams } from '../core/params.js';
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
/** Structural slice of game/deployables.ts — the Deployables manager.
 *  Passed lazily because deployables is constructed after this kit. */
export interface DeployableRef {
  /** Live deployable candidates for creature brains (id `dep:N`). */
  candidates(): TargetCandidate[];
  /** Contact damage from a creature chewing on this deployable. */
  hurt(candId: string, dmg: number): void;
}

// Contact DPS a committed creature deals to a deployable it's standing on.
// Generic funnel — per-species bite damage lives in each entity's onHit,
// which only reaches the player; gnaw is the deployable-specific path.
const DEP_GNAW_DPS = 10;

// Rare uber roll — ambient (no-pos) spawns only. Event/demo/director
// spawns pass an explicit pos and never surprise-upgrade unless asked.
const rollUber = (): boolean => Math.random() < UBER_CHANCE;

// Living-population check — every species spawn gate filters out dead
// members; counting in-place avoids a temp array per spawn attempt.
function atCap<T extends { dead: boolean }>(list: T[], max: number): boolean {
  let n = 0;
  for (const e of list) {
    if (!e.dead && ++n >= max) return true;
  }
  return false;
}

class SpeciesKitImpl {
  constructor(
    private deps: EntitiesDeps,
    private targets: Targetable[],
    private deployables: () => DeployableRef | null = () => null,
  ) {}

  readonly rollUber = rollUber;
  readonly atCap = atCap;


  // Remove a dead/disposed entity from its registry AND the shared targets
  // surface — the targets array is what projectiles and blasts iterate.
  removeTarget = <T extends Targetable>(list: T[], i: number, e: T): void  => {
    list.splice(i, 1);
    const ti = this.targets.indexOf(e);
    if (ti >= 0) this.targets.splice(ti, 1);
  }

  // Spawn position on a ring around the player — every ambient spawn uses it.
  ringPos = (min: number, max: number): THREE.Vector3  => {
    const ang = Math.random() * Math.PI * 2;
    const dist = min + Math.random() * (max - min);
    const player = this.deps.lazyPlayer();
    return new THREE.Vector3(
      player.pos.x + Math.cos(ang) * dist, 0, player.pos.z + Math.sin(ang) * dist,
    );
  }

  // Enemy-contact damage funnel: knockback + server env-damage + hit flash.
  // Identical at every onHit/onSting/onClaw/onBoltHit site. `deathText` is
  // the kill-feed attribution ("devoured by a crawler") recorded in case
  // this damage is the killing blow — the server only reports 'environment'.
  hurtPlayer = (fromPos: THREE.Vector3, force: number, damage: number, deathText: string, reach?: number, attacker?: object): boolean  => {
    const p = this.deps.lazyPlayer();
    if (p.isDead) return false; // corpse shouldn't get knocked around or re-hurt
    // Victim check — a creature's bite fires for whomever ITS threat table
    // committed to. Only an EXPLICIT local commitment hurts this client: a
    // remote target means their sim claims it, and a NULL target means the
    // creature is wandering a waypoint and bit empty air — not you.
    // (Was: every bite anywhere on the map drained the local player — the
    // 300m-away phantom hits in the logs.)
    if (attacker) {
      const brain = this.targetReg.for(attacker);
      const t = brain.target;
      // Committed to someone else — their sim claims it, not yours.
      if (t && t.id !== 'local') return false;
      // No commitment: a waypoint bite is biting air — UNLESS the creature
      // is frenzied, where its thrash lunges at your last-known position
      // are real contact and landing one is legit. This is what keeps
      // point-blank cloak sniping dangerous.
      if (!t && brain.frenzyT <= 0) return false;
      // "Always miss the first time" — a creature that JUST committed to you
      // whiffs its opening strike instead of arriving pre-warmed. Reads as a
      // warning shot: you get a beat to react before contact damage starts.
      if (brain.engagedT < this.ENGAGE_GRACE) return false;
    }
    // Reach gate — melee callers pass their contact reach. A hit landing
    // from beyond it is a phantom: triggers fire against the brain's
    // lastSeen snapshot (refreshed on eval ticks, up to ~2.5s stale), so a
    // fast-skating player takes damage where they WERE, not where they
    // ARE. The creature still bites — it just bites your ghost. Whiff it:
    // "oh shit I dodged that" moments are earned by being somewhere else.
    if (reach !== undefined) {
      const d = fromPos.distanceTo(p.pos);
      if (d > reach) {
        // Ski-speed whiffs are earned dodges, not bugs — the strike fired on
        // a lastSeen snapshot and a fast mover is already gone. Only a whiff
        // against a slow/stationary player means the reach math lied.
        const moving = p.vel.lengthSq() > 30 * 30;
        const log = moving ? this.deps.logger.debug : this.deps.logger.warn;
        log.call(this.deps.logger, `melee whiff beyond reach: ${deathText}`, {
          dist: +d.toFixed(2), reach: +reach.toFixed(2),
          from: { x: +fromPos.x.toFixed(1), y: +fromPos.y.toFixed(1), z: +fromPos.z.toFixed(1) },
          player: { x: +p.pos.x.toFixed(1), y: +p.pos.y.toFixed(1), z: +p.pos.z.toFixed(1) },
        });
        return false;
      }
    }
    p.lastDamageSource = deathText;
    p.applyKnockback(fromPos, force);
    this.deps.lazyNetworkManager()?.sendEnvironmentDamage(damage);
    this.deps.lazyHud().showDamage(fromPos, damage); // vignette + directional arc
    sfx.playerHurt();
    return true;
  }

  // Melee/bite call-site shorthand — every species' onBite/onSting/onClaw
  // was the same uber-scaled funnel: force×k, dmg×k, uber death text, reach
  // = radius + gap. One entry point keeps the variants consistent.
  bite = (
    attacker: { pos: THREE.Vector3; radius: number; uber: boolean },
    force: number, dmg: number, text: string,
    uber?: { force?: number; dmg?: number; text?: string },
    reachGap?: number,
  ): boolean  => {
    const u = attacker.uber;
    return this.hurtPlayer(attacker.pos,
      force * (u ? (uber?.force ?? 2) : 1),
      dmg * (u ? (uber?.dmg ?? 2) : 1),
      u && uber?.text ? uber.text : text,
      reachGap !== undefined ? attacker.radius + reachGap : undefined,
      attacker);
  }

  // Radial blast → player damage, the block every mine/baneling detonation
  // re-implemented: distance falloff from maxDmg at zero to 0 at radius,
  // then the standard env-damage funnel. Returns the damage dealt (0 = the
  // player was outside the envelope).
  blastAtPlayer = (origin: THREE.Vector3, radius: number, maxDmg: number, knockback: number, deathText: string, mult = 1): number  => {
    const p = this.deps.lazyPlayer();
    if (p.isDead) return 0;
    const dist = origin.distanceTo(p.pos);
    if (dist >= radius) return 0;
    const dmg = Math.round(maxDmg * (1 - dist / radius) * mult);
    if (dmg <= 0) return 0;
    p.lastDamageSource = deathText;
    p.applyKnockback(origin, knockback);
    this.deps.lazyNetworkManager()?.sendEnvironmentDamage(dmg);
    this.deps.lazyHud().showDamage(origin, dmg);
    return dmg;
  }

  // ---- Multi-player targeting -----------------------------------------
  // Every enemy owns a ThreatTable (WeakMap — no fields added to entity
  // classes). Candidates = the local player + every remote player. Solo,
  // a brain always picks 'local' and behavior is identical to before; in
  // shared PvE each species picks by its profile (see targeting.ts), and
  // damage reports from OTHER clients' hits feed the same aggro funnel.
  readonly targetReg = new TargetRegistry();
  readonly _candMap = new Map<string, TargetCandidate>();
  readonly _candList: TargetCandidate[] = [];
  readonly _zeroVel = new THREE.Vector3();
  // The roster only changes between frames, never mid-frame — rebuilding
  // it per entity multiplied a full map scan by entity count.
  _candFrame = -1;

  candidates = (): TargetCandidate[]  => {
    const frame = Math.floor(performance.now() / 16);
    if (frame === this._candFrame) return this._candList;
    this._candFrame = frame;
    this.syncLocalCandidate();
    this.syncRemoteCandidates();
    this.pruneCandidates();
    this._candList.length = 0;
    for (const cand of this._candMap.values()) this._candList.push(cand);
    // Deployables are chewable scenery — a planted turret draws aggro like
    // a player, which is what makes base defense matter.
    for (const cand of this.deployables?.()?.candidates() ?? []) this._candList.push(cand);
    return this._candList;
  }

  syncLocalCandidate = (): void  => {
    const p = this.deps.lazyPlayer();
    let c = this._candMap.get('local');
    if (!c) {
      c = { id: 'local', pos: p.pos, vel: p.vel, alive: true };
      this._candMap.set('local', c);
    }
    // Spectating = dev observer noclip — you're not prey, you're a camera.
    c.alive = !p.isDead && !p.isCloaked && !p.isSpectating;
  }

  syncRemoteCandidates = (): void  => {
    const now = Date.now();
    for (const [id, r] of this.deps.world.remotePlayers) {
      let rc = this._candMap.get(id);
      if (!rc) {
        rc = { id, pos: r.pos, vel: r.vel, alive: true };
        this._candMap.set(id, rc);
      }
      // Freshness gate — a remote whose position stream froze (lost packets,
      // a stall, server hiccup) becomes a statue magnet: every hunter in
      // leash range converges on the last-seen spot and stands there biting
      // air, which reads as "all enemies deaggroed me". 2s without a
      // position update = not a valid target; the AI wanders instead.
      rc.alive = !r.isDead && (now - r.lastUpdateTime < 2000);
    }
  }

  pruneCandidates = (): void  => {
    if (this._candMap.size <= this.deps.world.remotePlayers.size + 1) return;
    for (const id of this._candMap.keys()) {
      if (id !== 'local' && !this.deps.world.remotePlayers.has(id)) this._candMap.delete(id);
    }
  }

  // Post-kill wander: with nobody alive to hate, a shared phantom made every
  // enemy converge on ONE point and freeze on it. Per-entity waypoints keep
  // each critter milling around ITS OWN position — they skitter about after
  // a kill instead of stopping dead. WeakMap — entries die with the entity.
  readonly wanderReg = new WeakMap<object, { wp: THREE.Vector3; t: number }>();
  wanderFor = (owner: object, selfPos: THREE.Vector3, dt: number): THREE.Vector3  => {
    let w = this.wanderReg.get(owner);
    if (!w) {
      w = { wp: selfPos.clone(), t: 0 };
      this.wanderReg.set(owner, w);
    }
    w.t -= dt;
    if (w.t <= 0 || w.wp.distanceToSquared(selfPos) < 4) {
      w.t = 2 + Math.random() * 4;
      const a = Math.random() * Math.PI * 2;
      const d = 8 + Math.random() * 22;
      w.wp.set(selfPos.x + Math.cos(a) * d, 0, selfPos.z + Math.sin(a) * d);
      w.wp.y = this.deps.lazyTerrain().getHeight(w.wp.x, w.wp.z) + 2;
    }
    return w.wp;
  }

  // Stalking: the committed target slipped past leash range but is still
  // alive — the brain keeps lastSeen and drifts toward it. Waypoints step
  // ~35m inward with wide lateral jitter: from a distance it reads as an
  // erratic hunter working the terrain, not a bee-line or a statue.
  // Gives up past ~1.6× leash (target truly gone) and reverts to milling.
  stalkFor = (owner: object, selfPos: THREE.Vector3, dt: number, brain: { lastSeen: THREE.Vector3; stalking: boolean }, leash: number): THREE.Vector3  => {
    if (selfPos.distanceToSquared(brain.lastSeen) > leash * leash * 2.56) {
      brain.stalking = false;
      return this.wanderFor(owner, selfPos, dt);
    }
    let w = this.wanderReg.get(owner);
    if (!w) {
      w = { wp: selfPos.clone(), t: 0 };
      this.wanderReg.set(owner, w);
    }
    w.t -= dt;
    if (w.t <= 0 || w.wp.distanceToSquared(selfPos) < 16) {
      w.t = 3 + Math.random() * 3;
      this._stalkDir.subVectors(brain.lastSeen, selfPos);
      this._stalkDir.y = 0;
      const l = this._stalkDir.length() || 1;
      this._stalkDir.multiplyScalar(1 / l);
      const step = 25 + Math.random() * 20;
      const side = (Math.random() - 0.5) * 50; // wide jitter — erratic drift, not a homing run
      w.wp.set(
        selfPos.x + this._stalkDir.x * step - this._stalkDir.z * side, 0,
        selfPos.z + this._stalkDir.z * step + this._stalkDir.x * side);
      w.wp.y = this.deps.lazyTerrain().getHeight(w.wp.x, w.wp.z) + 2;
    }
    return w.wp;
  }
  readonly _stalkDir = new THREE.Vector3();

  // Frenzy: hurt by an invisible attacker. The pack has no target — only
  // where the damage came FROM — so it thrashes: pounce at the remembered
  // spot, scatter in panic, repeat on a frantic cadence. A close creature
  // also gets a "scent" chance to lunge at the real position — standing
  // still inside a frenzied pack is how you get clipped by accident.
  readonly FRENZY_SCENT = 15;    // metres — inside this they can smell you
  readonly FRENZY_RADIUS = 70;   // packmates within this of the victim panic too
  frenzyFor = (owner: object, selfPos: THREE.Vector3, dt: number, brain: { frenzyFrom: THREE.Vector3 }): THREE.Vector3  => {
    let w = this.wanderReg.get(owner);
    if (!w) {
      w = { wp: selfPos.clone(), t: 0 };
      this.wanderReg.set(owner, w);
    }
    w.t -= dt;
    if (w.t <= 0 || w.wp.distanceToSquared(selfPos) < 4) {
      w.t = 0.6 + Math.random() * 1.0; // frantic re-pick, not the lazy wander cadence
      const p = this.deps.lazyPlayer().pos;
      if (selfPos.distanceToSquared(p) < this.FRENZY_SCENT * this.FRENZY_SCENT && Math.random() < 0.45) {
        // Close enough to smell the invisible threat — lunge at it
        w.wp.set(p.x + (Math.random() - 0.5) * 6, 0, p.z + (Math.random() - 0.5) * 6);
      } else if (Math.random() < 0.55) {
        // Pounce at where the attack came from — they remember the pain
        const a = Math.random() * Math.PI * 2, d = 4 + Math.random() * 18;
        w.wp.set(brain.frenzyFrom.x + Math.cos(a) * d, 0, brain.frenzyFrom.z + Math.sin(a) * d);
      } else {
        // Bolt somewhere — pure panic scatter
        const a = Math.random() * Math.PI * 2, d = 10 + Math.random() * 30;
        w.wp.set(selfPos.x + Math.cos(a) * d, 0, selfPos.z + Math.sin(a) * d);
      }
      w.wp.y = this.deps.lazyTerrain().getHeight(w.wp.x, w.wp.z) + 2;
    }
    return w.wp;
  }

  // Grace period between a brain committing to a target and its attacks
  // landing — the first-strike mercy window.
  readonly ENGAGE_GRACE = 1.25;

  // Weave: approaches run a lateral sine around the beeline so pursuit
  // curves instead of homing on rails. Per-entity phase desyncs the pack;
  // amplitude fades near contact so bites still connect.
  readonly weaveReg = new WeakMap<object, number>();
  readonly _weaveDir = new THREE.Vector3();
  readonly _weaveOut = new THREE.Vector3();

  // The chase position for an enemy this frame: where its brain last SAW
  // the committed target (perception snapshot, not live position), offset
  // by the approach weave; or a personal wander waypoint when nobody's
  // alive to hate. `owner` is any object — brains live in WeakMaps.
  aggroFor = (owner: object, selfPos: THREE.Vector3, dt: number, profile: TargetProfile): THREE.Vector3  => {
    const brain = this.targetReg.for(owner);
    const t = brain.update(dt, selfPos, this.candidates(), profile);
    // No live target: frenzy outranks everything — an invisible attacker
    // whipped it into a panic. Then stalk (lost a far target) before
    // plain milling. Either way the creature keeps moving.
    if (!t) {
      if (brain.frenzyT > 0) return this.frenzyFor(owner, selfPos, dt, brain);
      return brain.stalking ? this.stalkFor(owner, selfPos, dt, brain, profile.leash || 400) : this.wanderFor(owner, selfPos, dt);
    }

    // Flinch: freshly damaged → recoil away from the attacker's position
    // instead of pressing in. Short window; reads as "it noticed the hit".
    if (brain.flinchT > 0) {
      brain.flinchT -= dt;
      this._weaveOut.subVectors(selfPos, brain.flinchFrom);
      this._weaveOut.y = 0;
      const l = this._weaveOut.length() || 1;
      this._weaveOut.multiplyScalar(6 / l).add(selfPos); // flee point ~6m away
      return this._weaveOut;
    }

    this._weaveOut.copy(brain.lastSeen);
    // Sinusoidal lateral offset perpendicular to the chase direction.
    let phase = this.weaveReg.get(owner);
    if (phase === undefined) { phase = Math.random() * Math.PI * 2; this.weaveReg.set(owner, phase); }
    this.weaveReg.set(owner, phase + dt * 2.2);
    const dist = selfPos.distanceTo(brain.lastSeen);
    // Beyond ~60m weave barely matters; inside ~10m it shuts off so the
    // strike zone isn't dodged by our own decoration.
    const amp = Math.min(8, dist * 0.25) * THREE.MathUtils.clamp((dist - 10) / 15, 0, 1);
    if (amp > 0.01 && dist > 1) {
      this._weaveDir.subVectors(brain.lastSeen, selfPos).normalize();
      const px = -this._weaveDir.z, pz = this._weaveDir.x; // horizontal perpendicular
      const s = Math.sin(phase) * amp;
      this._weaveOut.x += px * s;
      this._weaveOut.z += pz * s;
    }

    // Pack spacing — creatures shove the chase point away from crowded
    // neighbors so a pack surrounds instead of stacking on one spot.
    // Cheap O(n) over the shared targets surface, 8m influence radius.
    let sepX = 0, sepZ = 0;
    for (const o of this.targets) {
      if (o === owner) continue;
      const dx = selfPos.x - o.pos.x, dz = selfPos.z - o.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 64 || d2 < 0.01) continue;
      const d = Math.sqrt(d2);
      const w = (8 - d) / 8 / d;
      sepX += dx * w; sepZ += dz * w;
    }
    this._weaveOut.x += sepX * 1.5;
    this._weaveOut.z += sepZ * 1.5;
    return this._weaveOut;
  }

  // Target VELOCITY for predictive species (totem lead, seeker aim) — the
  // committed target's last-seen vel, matching the perception snapshot.
  aggroVelFor = (e: object): THREE.Vector3  => {
    const brain = this.targetReg.for(e);
    return brain.target ? brain.lastSeenVel : this._zeroVel;
  }

  // Combat reports damage here — the aggro hook. 'local' today; shared
  // PvE delivers remote playerIds through the same funnel. Also arms the
  // flinch: the creature recoils from the attacker's known position.
  reportTargetDamage = (e: object, amount: number, attackerId = 'local'): void  => {
    const brain = this.targetReg.for(e);
    brain.reportDamage(attackerId, amount);
    const p = this.deps.lazyPlayer();
    const from = attackerId === 'local' ? p.pos : this._candMap.get(attackerId)?.pos;
    if (from) brain.flinch(from);
    // Shot while cloaked — the pack can't see you, it PANICS: the victim
    // plus every creature nearby thrashes at your last-known position.
    // Cloak sniping stays possible but never safe at close range.
    if (attackerId === 'local' && p.isCloaked) {
      brain.frenzy(p.pos);
      const ep = (e as Targetable).pos;
      for (const o of this.targets) {
        if (o === e || o.dead) continue;
        if (o.pos.distanceToSquared(ep) < this.FRENZY_RADIUS * this.FRENZY_RADIUS) {
          this.targetReg.for(o).frenzy(p.pos);
        }
      }
    }
  }

  // Compact orange pop shared by turret shells, totem bolts, mines — reads
  // as a small explosion, not a rocket.
  boltPop = (pos: THREE.Vector3, scale: number, color: number, shake: number): void  => {
    this.deps.world.explosions.push(new Explosion(this.deps.scene, pos, false, 0, this.deps.lazyTerrain(), scale, color));
    screenShake.blast(pos, shake, this.deps.lazyPlayer().pos);
    sfx.explosionAt(pos, false);
  }

  // ?spawns=random — waveDirector's flat random mode suppresses ambient
  // per-species spawn timers so the total budget isn't double-spent.
  readonly RANDOM_SPAWNS = urlParams.randomSpawns;

  // AI LOD — distant enemies tick at reduced rate so swarm counts don't
  // scale the CPU linearly. Accumulated dt keeps AI math time-correct;
  // 20Hz mid / 5Hz far is invisible at those distances.
  readonly AI_LOD_MID_SQ = 120 * 120;
  readonly AI_LOD_FAR_SQ = 300 * 300;
  readonly AI_LOD_MID_DT = 1 / 20;
  readonly AI_LOD_FAR_DT = 1 / 5;
  // Bucket phase — accumulators start pre-charged by id%8 so a wave of
  // entities entering a band together doesn't all tick on the same frame
  // (the server sims stagger the same way).
  readonly LOD_BUCKETS = 8;
  readonly lodPhase = (e: Targetable, tier: number) => tier * (((e.id ?? 0) % this.LOD_BUCKETS) / this.LOD_BUCKETS);
  readonly lodAcc = new WeakMap<Targetable, number>();

  updateSpecies = <T extends Targetable & { dispose(): void }>(s: Species<T>, dt: number): void  => {
    s.t += dt;
    if (s.t >= s.interval) {
      s.t = 0;
      // Ambient spawning is owned by this one path — director spawns are
      // gated in gameLoop. (Per-species spawn fns that guard on isPlaying
      // anyway are harmless defense — director events call them directly.)
      // ?spawns=random: ambient timers stay off — the random director
      // owns population so the total budget isn't double-spent.
      if (!this.RANDOM_SPAWNS && !this.deps.lazyDemoManager()?.isPlaying) s.spawn();
    }
    const playerPos = this.deps.lazyPlayer().pos;
    for (let i = s.list.length - 1; i >= 0; i--) {
      const e = s.list[i]!;
      const tickDt = this.lodTick(e, e.pos.distanceToSquared(playerPos), dt);
      if (tickDt > 0) s.tick(e, tickDt);
      this.tickGnaw(e, tickDt);
      if (e.dead) {
        this.lodAcc.delete(e);
        e.dispose();
        this.removeTarget(s.list, i, e);
      }
    }
  }

  // Accumulated LOD dt for one entity this frame — 0 = skip the tick.
  lodTick = (e: Targetable, dSq: number, dt: number): number  => {
    const tier = dSq > this.AI_LOD_FAR_SQ ? this.AI_LOD_FAR_DT : dSq > this.AI_LOD_MID_SQ ? this.AI_LOD_MID_DT : 0;
    if (!tier) return dt;
    const acc = (this.lodAcc.get(e) ?? this.lodPhase(e, tier)) + dt;
    if (acc < tier) { this.lodAcc.set(e, acc); return 0; }
    this.lodAcc.set(e, 0);
    return acc;
  }

  // Gnaw: a creature committed to a deployable and standing on it chews
  // it down — reach envelope is generous since bite anim reach varies.
  tickGnaw = (e: Targetable & { radius: number }, tickDt: number): void  => {
    if (tickDt <= 0) return;
    const bt = this.targetReg.for(e).target;
    if (!bt || !bt.id.startsWith('dep:')) return;
    const rr = e.radius + 2.5;
    if (e.pos.distanceToSquared(bt.pos) < rr * rr) this.deployables?.()?.hurt(bt.id, DEP_GNAW_DPS * tickDt);
  }

  // Ground species slide up out of the dirt instead of popping into existence.
  // emergeT counts down inside each class's update; emergeRestY is the resting
  // surface height the spawn constructor already resolved.
  burrow = (e: { emergeT: number; emergeDepth: number; emergeRestY: number; radius: number; pos: THREE.Vector3 }): void  => {
    e.emergeT = EMERGE_DUR;
    e.emergeDepth = e.radius * 2.2;
    e.emergeRestY = e.pos.y;
    this.deps.lazyEffects().spawnJumpDust(e.pos);
  }

  // rollUber + atCap live at module scope — no closure state needed.

  // Ground dust: distance-based emission, so faster movers naturally puff
  // more and a standing creature puffs nothing. SpawnMoveDust scales the
  // puff itself by speed + body radius — rollers roostertail, grubs barely
  // stir the dirt. Per-entity accumulator dies with the entity.
  readonly dustAcc = new WeakMap<Targetable, number>();
  kickDust = (e: { dead: boolean; pos: THREE.Vector3; vel: THREE.Vector3; radius: number } & Targetable, dt: number): void  => {
    if (e.dead) return;
    const sp = Math.hypot(e.vel.x, e.vel.z);
    if (sp < 2) return; // creepers don't raise dust
    const gy = this.deps.lazyTerrain().getHeight(e.pos.x, e.pos.z);
    if (e.pos.y - gy > e.radius * 2.5) return; // airborne — no ground contact
    const acc = (this.dustAcc.get(e) ?? 0) + sp * dt;
    const spacing = e.radius * 1.5 + 0.4;
    if (acc >= spacing) {
      this.dustAcc.set(e, acc - spacing);
      this.deps.lazyEffects().spawnMoveDust(e.pos, e.vel, sp, e.radius);
    }
  }

  // Flyer slipstream — same distance-accumulator pattern as kickDust but
  // sparser, higher speed floor, and subtle by design: singular fliers
  // only (rakks, seekers, overlords). NOT for boid clouds or buzzards —
  // a hundred faint motes is a hundred draw-submit worth of noise.
  readonly trailAcc = new WeakMap<Targetable, number>();
  kickTrail = (e: { dead: boolean; pos: THREE.Vector3; vel: THREE.Vector3 } & Targetable, dt: number): void  => {
    if (e.dead) return;
    const sp = Math.hypot(e.vel.x, e.vel.z);
    if (sp < 6) return; // hovering/circling slow = no trail
    const acc = (this.trailAcc.get(e) ?? 0) + sp * dt;
    const spacing = 2.5 + Math.random() * 1.5; // irregular — no dotted-line uniformity
    if (acc >= spacing) {
      this.trailAcc.set(e, acc - spacing);
      this.deps.lazyEffects().spawnFlyTrail(e.pos, e.vel, sp);
    }
  }

}

export function createSpeciesKit(deps: EntitiesDeps, targets: Targetable[], deployables?: () => DeployableRef | null) {
  return new SpeciesKitImpl(deps, targets, deployables);
}

export type SpeciesKit = SpeciesKitImpl;
