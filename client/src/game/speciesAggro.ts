/**
 * AggroKit — creature targeting + waypoint senses, split out of
 * speciesKit. Everything below operates on the shared `targets` surface
 * and the deps slice handed in; no state of its own beyond the WeakMap
 * brains/waypoint registries (entries die with their entity).
 */
import * as THREE from 'three';

import { TargetRegistry, type TargetCandidate, type TargetProfile } from './targeting.js';
import type { Targetable } from '../entities/balls.js';
import type { EntitiesDeps } from './entities.js';
import type { DeployableRef } from './speciesKit.js';

export class AggroKit {
  constructor(
    private deps: EntitiesDeps,
    private targets: Targetable[],
    private deployables: () => DeployableRef | null,
  ) {}

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
      // localDriven remotes (offline GameBots) update their position every
      // frame but never stamp lastUpdateTime — they're always fresh.
      rc.alive = !r.isDead
        && ((r as { localDriven?: boolean }).localDriven || (now - r.lastUpdateTime < 2000));
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
}
