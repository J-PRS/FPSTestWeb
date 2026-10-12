import * as THREE from 'three';

import * as sfx from '../core/sfx.js';
import { Explosion } from '../effects/explosion.js';
import { screenShake } from '../effects/screenShake.js';
import { EMERGE_DUR, UBER_CHANCE } from '../core/config.js';
import { urlParams } from '../core/params.js';
import { AggroKit } from './speciesAggro.js';
import type { TargetCandidate } from './targeting.js';
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
  /** Ambient dressing, not creature population — ?nocreatures leaves it
   *  alone (the server gate only empties the combat-species pops too). */
  decor?: boolean;
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
    if (!e.dead && (n += 1) >= max) {return true;}
  }
  return false;
}

class SpeciesKitImpl {
  // Aggro delegate: assigned in the ctor because field initializers run
  // before param-prop bodies.
  private readonly aggro: AggroKit;
  readonly targetReg: AggroKit['targetReg'];
  readonly candidates: AggroKit['candidates'];
  readonly wanderFor: AggroKit['wanderFor'];
  readonly stalkFor: AggroKit['stalkFor'];
  readonly frenzyFor: AggroKit['frenzyFor'];
  readonly aggroFor: AggroKit['aggroFor'];
  readonly aggroVelFor: AggroKit['aggroVelFor'];
  readonly reportTargetDamage: AggroKit['reportTargetDamage'];
  readonly ENGAGE_GRACE: number;
  readonly FRENZY_SCENT: number;
  readonly FRENZY_RADIUS: number;
  // Whiff-warn folding: deathText → last warn + suppressed count.
  private readonly whiffFold = new Map<string, { at: number; count: number }>();
  readonly WHIFF_FOLD_MS = 3000;

  constructor(
    private deps: EntitiesDeps,
    private targets: Targetable[],
    private deployables: () => DeployableRef | null = (): null => null,
  ) {
    this.aggro = new AggroKit(deps, targets, this.deployables);
    this.targetReg = this.aggro.targetReg;
    this.candidates = this.aggro.candidates;
    this.wanderFor = this.aggro.wanderFor;
    this.stalkFor = this.aggro.stalkFor;
    this.frenzyFor = this.aggro.frenzyFor;
    this.aggroFor = this.aggro.aggroFor;
    this.aggroVelFor = this.aggro.aggroVelFor;
    this.reportTargetDamage = this.aggro.reportTargetDamage;
    this.ENGAGE_GRACE = this.aggro.ENGAGE_GRACE;
    this.FRENZY_SCENT = this.aggro.FRENZY_SCENT;
    this.FRENZY_RADIUS = this.aggro.FRENZY_RADIUS;
  }

  readonly rollUber = rollUber;
  readonly atCap = atCap;


  // Remove a dead/disposed entity from its registry AND the shared targets
  // surface — the targets array is what projectiles and blasts iterate.
  removeTarget = <T extends Targetable>(list: T[], i: number, e: T): void  => {
    list.splice(i, 1);
    const ti = this.targets.indexOf(e);
    if (ti !== -1) {this.targets.splice(ti, 1);}
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
  hurtPlayer = (fromPos: THREE.Vector3, force: number, damage: number, deathText: string, reach?: number, attacker?: { vel?: THREE.Vector3 } & object): boolean  => {
    const p = this.deps.lazyPlayer();
    if (p.isDead) {return false;} // corpse shouldn't get knocked around or re-hurt
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
      if (t && t.id !== 'local') {return false;}
      // No commitment: a waypoint bite is biting air — UNLESS the creature
      // is frenzied, where its thrash lunges at your last-known position
      // are real contact and landing one is legit. This is what keeps
      // point-blank cloak sniping dangerous.
      if (!t && brain.frenzyT <= 0) {return false;}
      // "Always miss the first time" — a creature that JUST committed to you
      // whiffs its opening strike instead of arriving pre-warmed. Reads as a
      // warning shot: you get a beat to react before contact damage starts.
      if (brain.engagedT < this.ENGAGE_GRACE) {return false;}
    }
    // Reach gate — melee callers pass their contact reach. A hit landing
    // from beyond it is a phantom: triggers fire against the brain's
    // lastSeen snapshot (refreshed on eval ticks, up to ~2.5s stale), so a
    // fast-skating player takes damage where they WERE, not where they
    // ARE. The creature still bites — it just bites your ghost. Whiff it:
    // "oh shit I dodged that" moments are earned by being somewhere else.
    if (reach !== undefined) {
      // netDriven attackers replay the authority's sim — the strike was
      // already adjudicated server-side, so the reach gate can only ever
      // false-positive on replica lag (the soak's ×33 scarab siege: a
      // stationary replica 10-20m behind truth reads as a reach lie, and
      // the whiff then DROPPED the damage claim entirely — server-valid
      // hits landing as damage-from-nowhere echoes instead).
      const netDriven = attacker !== undefined && (attacker as { sim?: unknown }).sim;
      const d = fromPos.distanceTo(p.pos);
      if (d > reach && !netDriven) {
        // Ski-speed whiffs are earned dodges, not bugs — the strike fired on
        // a lastSeen snapshot and a fast mover is already gone. Only a whiff
        // against a slow/stationary player means the reach math lied.
        // A swarm besieging a stationary player whiffs EVERY bite, so the
        // warn folds repeats per species into ×N — a siege reads as one
        // line, not a scroll.
        // Ski-speed whiffs are earned dodges, not bugs — the strike fired
        // on a lastSeen snapshot and a fast mover is already gone. Same
        // on the attacker side: a netDriven creature/ball replaying at
        // ~40 m/s legitimately reads ~20m off the snapshot it bit on, so
        // a fast attacker whiffing is replay staleness, not a reach lie.
        // Sub-meter overshoot is replay jitter: the attacker's client-side
        // replica trails its server truth by a tick or two, so a strike
        // that was in reach server-side measures slightly out here. Warn
        // only past an epsilon that jitter can't explain.
        const moving = p.vel.lengthSq() > 30 * 30 || (attacker?.vel?.lengthSq() ?? 0) > 15 * 15 || d - reach < 2;
        const now = performance.now();
        const fold = this.whiffFold.get(deathText);
        if (fold && now - fold.at < this.WHIFF_FOLD_MS) {
fold.count += 1;
        } else {
          const suppressed = fold ? fold.count : 0;
          this.whiffFold.set(deathText, { at: now, count: 0 });
          const log = moving ? this.deps.logger.debug : this.deps.logger.warn;
          log.call(this.deps.logger, `melee whiff beyond reach: ${deathText}${suppressed ? ` (×${suppressed + 1})` : ''}`, {
            dist: Number(d.toFixed(2)), reach: Number(reach.toFixed(2)),
            from: { x: Number(fromPos.x.toFixed(1)), y: Number(fromPos.y.toFixed(1)), z: Number(fromPos.z.toFixed(1)) },
            player: { x: Number(p.pos.x.toFixed(1)), y: Number(p.pos.y.toFixed(1)), z: Number(p.pos.z.toFixed(1)) },
          });
        }
        return false;
      }
    }
    p.lastDamageSource = deathText;
    p.applyKnockback(fromPos, force * p.mods.knockbackTaken);
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
      reachGap === undefined ? undefined : attacker.radius + reachGap,
      attacker);
  }

  // Radial blast → player damage, the block every mine/baneling detonation
  // re-implemented: distance falloff from maxDmg at zero to 0 at radius,
  // then the standard env-damage funnel. Returns the damage dealt (0 = the
  // player was outside the envelope).
  blastAtPlayer = (origin: THREE.Vector3, radius: number, maxDmg: number, knockback: number, deathText: string, mult = 1): number  => {
    const p = this.deps.lazyPlayer();
    if (p.isDead) {return 0;}
    const dist = origin.distanceTo(p.pos);
    if (dist >= radius) {return 0;}
    const dmg = Math.round(maxDmg * (1 - dist / radius) * mult);
    if (dmg <= 0) {return 0;}
    p.lastDamageSource = deathText;
    p.applyKnockback(origin, knockback * p.mods.knockbackTaken);
    this.deps.lazyNetworkManager()?.sendEnvironmentDamage(dmg);
    this.deps.lazyHud().showDamage(origin, dmg);
    return dmg;
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
  readonly lodPhase = (e: Targetable, tier: number): number => tier * (((e.id ?? 0) % this.LOD_BUCKETS) / this.LOD_BUCKETS);
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
      // ?nocreatures — the lobby sim-gate, applied to the local ambient
      // population (offline rooms have no server mint to carry it).
      if (!this.RANDOM_SPAWNS && !this.deps.lazyDemoManager()?.isPlaying && !(urlParams.noCreatures && !s.decor)) {s.spawn();}
    }
    const playerPos = this.deps.lazyPlayer().pos;
    for (let i = s.list.length - 1; i >= 0; i -= 1) {
      const e = s.list[i]!;
      const tickDt = this.lodTick(e, e.pos.distanceToSquared(playerPos), dt);
      if (tickDt > 0) {s.tick(e, tickDt);}
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
    let tier = 0;
    if (dSq > this.AI_LOD_FAR_SQ) {tier = this.AI_LOD_FAR_DT;}
    else if (dSq > this.AI_LOD_MID_SQ) {tier = this.AI_LOD_MID_DT;}
    if (!tier) {return dt;}
    const acc = (this.lodAcc.get(e) ?? this.lodPhase(e, tier)) + dt;
    if (acc < tier) { this.lodAcc.set(e, acc); return 0; }
    this.lodAcc.set(e, 0);
    return acc;
  }

  // Gnaw: a creature committed to a deployable and standing on it chews
  // it down — reach envelope is generous since bite anim reach varies.
  tickGnaw = (e: Targetable & { radius: number }, tickDt: number): void  => {
    if (tickDt <= 0) {return;}
    const bt = this.targetReg.for(e).target;
    if (!bt || !bt.id.startsWith('dep:')) {return;}
    const rr = e.radius + 2.5;
    if (e.pos.distanceToSquared(bt.pos) < rr * rr) {this.deployables?.()?.hurt(bt.id, DEP_GNAW_DPS * tickDt);}
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
    if (e.dead) {return;}
    const sp = Math.hypot(e.vel.x, e.vel.z);
    if (sp < 2) {return;} // creepers don't raise dust
    const gy = this.deps.lazyTerrain().getHeight(e.pos.x, e.pos.z);
    if (e.pos.y - gy > e.radius * 2.5) {return;} // airborne — no ground contact
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
    if (e.dead) {return;}
    const sp = Math.hypot(e.vel.x, e.vel.z);
    if (sp < 6) {return;} // hovering/circling slow = no trail
    const acc = (this.trailAcc.get(e) ?? 0) + sp * dt;
    const spacing = 2.5 + Math.random() * 1.5; // irregular — no dotted-line uniformity
    if (acc >= spacing) {
      this.trailAcc.set(e, acc - spacing);
      this.deps.lazyEffects().spawnFlyTrail(e.pos, e.vel, sp);
    }
  }

}

export function createSpeciesKit(deps: EntitiesDeps, targets: Targetable[], deployables?: () => DeployableRef | null): SpeciesKitImpl {
  return new SpeciesKitImpl(deps, targets, deployables);
}

export type SpeciesKit = SpeciesKitImpl;
