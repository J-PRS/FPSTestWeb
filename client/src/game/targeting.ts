// Multi-player target selection for creatures — the "retarget brain".
// Research basis: never pick raw nearest (targets ping-pong when two
// players cross paths — the enemy rotates instead of committing). The fix
// that ships in every shipped threat system is a weighted score with a
// STICKY bonus for the current target (hysteresis) plus damage threat that
// decays, so a burst pulls aggro now and stops mattering in ~10s.
//
// Today there is one candidate (the local player) so a brain always picks
// it — but every enemy already holds a brain, keeps a chosen target, and
// evaluates switches on a timer. When shared PvE lands, remote players
// become extra candidates and the logic Just Works — including host-auth
// where OTHER clients' hits report damage through the same funnel.

import * as THREE from 'three';

export interface TargetCandidate {
  /** 'local' = this client's player; future: remote playerIds. */
  id: string;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  alive: boolean;
}

export interface TargetProfile {
  /** Pull toward the CLOSEST candidate (per ~40m of distance). */
  wDist: number;
  /** Weight of decaying damage aggro — who shot me most recently. */
  wDmg: number;
  /** Hysteresis bonus for the current target — the anti-flicker knob. */
  sticky: number;
  /** Seconds between re-evaluations (per-tick eval is jitter + waste). */
  evalEvery: number;
  /** Damage threat decay per second (multiplicative). */
  decay: number;
  /** Beyond this range a target is dropped outright (0 = no leash). */
  leash: number;
}

// Per-archetype personalities — the same score function with different
// weights reads as completely different behavior.
export const PROFILES = {
  /** Mindless swarm — chase whatever's closest, barely care who shoots. */
  fodder:    { wDist: 1.0, wDmg: 0.15, sticky: 1.2,  evalEvery: 2.0, decay: 0.15, leash: 300 },
  /** Pack hunters — nearest, but a real damage-dealer pulls aggro. */
  hunter:    { wDist: 1.0, wDmg: 0.5,  sticky: 1.35, evalEvery: 1.0, decay: 0.12, leash: 300 },
  /** Committed ram — momentum IS the personality, almost never re-picks. */
  rammer:    { wDist: 1.0, wDmg: 0.2,  sticky: 2.5,  evalEvery: 3.0, decay: 0.10, leash: 350 },
  /** Airborne harasser — opportunist: nearest with strong damage aggro. */
  flyer:     { wDist: 1.0, wDmg: 0.8,  sticky: 1.4,  evalEvery: 1.5, decay: 0.18, leash: 350 },
  /** Artillery — punishes whoever's shooting it; distance barely matters. */
  artillery: { wDist: 0.3, wDmg: 1.0,  sticky: 1.6,  evalEvery: 2.0, decay: 0.08, leash: 400 },
  /** Sniper/beam — locks a lane and holds it unless someone else hurts it. */
  sniper:    { wDist: 0.25, wDmg: 1.2, sticky: 2.0,  evalEvery: 2.5, decay: 0.08, leash: 450 },
  /** Siege dropper — orbits whoever's convenient, loathes to re-orbit. */
  siege:     { wDist: 0.6, wDmg: 0.3,  sticky: 1.8,  evalEvery: 2.5, decay: 0.10, leash: 350 },
} satisfies Record<string, TargetProfile>;

export type ProfileName = keyof typeof PROFILES;

/** One creature's targeting state. Owns: who it currently hates, how much
 *  it hates each candidate, and when it next reconsiders. */
export class ThreatTable {
  /** Currently committed target — persists between evaluations. */
  target: TargetCandidate | null = null;
  /** Where the brain THINKS its target is — refreshed only on eval ticks
   *  (Omicron's aim_delay: enemies chase your last-seen spot, not your live
   *  position, so fast movers genuinely juke pursuit). */
  readonly lastSeen = new THREE.Vector3();
  readonly lastSeenVel = new THREE.Vector3();
  /** Seconds since this brain committed to its current target — the
   *  "always miss first" window rides on it. */
  engagedT = 0;
  /** Leash-dropped but not forgotten — the target went far while still
   *  alive, so the creature keeps drifting toward the last-seen spot
   *  instead of milling in place. Deaggro is a fade, not a switch. */
  stalking = false;
  /** Flinch: counts down after taking damage — while >0 the creature
   *  recoils from the attacker's last position instead of chasing. */
  flinchT = 0;
  readonly flinchFrom = new THREE.Vector3();
  /** Frenzy: hurt by an attacker it can't see (cloak). Frantic waypoints —
   *  pounce at the last-known position, scatter, sometimes get lucky.
   *  Only drives behavior while no live target is committed. */
  frenzyT = 0;
  readonly frenzyFrom = new THREE.Vector3();
  private threat = new Map<string, number>();
  private evalT = Math.random() * 0.5; // desync evals so a pack doesn't all snap at once

  /** A candidate hurt this creature — the aggro hook. Callers pass the
   *  attacker's id ('local' today, playerId in shared mode). */
  reportDamage(id: string, amount: number): void {
    this.threat.set(id, (this.threat.get(id) ?? 0) + amount);
  }

  /** Took damage from `from` — flinch: brief recoil away before resuming
   *  the hunt. Long hits (one per ~0.5s under sustained fire) don't stack
   *  to a permadebuff; each just re-arms the flinch. */
  flinch(from: THREE.Vector3): void {
    this.flinchT = 0.45;
    this.flinchFrom.copy(from);
  }

  /** Hurt by something invisible — panic. Repeated hits re-arm with
   *  jittered duration so sustained fire keeps the pack riled without
   *  ratcheting to a permanent frenzy. */
  frenzy(from: THREE.Vector3): void {
    this.frenzyT = Math.max(this.frenzyT, 6 + Math.random() * 5);
    this.frenzyFrom.copy(from);
  }

  /** Forget a candidate entirely (disconnect/leave). */
  forget(id: string): void {
    this.threat.delete(id);
    if (this.target?.id === id) this.target = null;
    this.stalking = false; // left the world — not "far away"
  }

  /**
   * Re-evaluate on a timer; returns the committed candidate (or null when
   * nobody's worth chasing — caller falls back to wandering).
   * `candidates` may be rebuilt every call; dead candidates are ignored.
   */
  update(dt: number, selfPos: THREE.Vector3, candidates: TargetCandidate[], profile: TargetProfile): TargetCandidate | null {
    this.frenzyT = Math.max(0, this.frenzyT - dt);
    // Damage threat decays — a burst pulls aggro NOW, not forever.
    const d = 1 - Math.min(1, profile.decay * dt * 10);
    if (d > 0) {
      for (const [id, v] of this.threat) {
        const nv = v * d;
        if (nv < 0.5) this.threat.delete(id); else this.threat.set(id, nv);
      }
    }

    // Current target died/left/leashed → force an immediate re-pick.
    // Death = true deaggro; leash-out = stalking — keep lastSeen and
    // wander TOWARD it so distant hunters drift your way, erratically.
    if (this.target && (!this.target.alive || (profile.leash > 0 &&
        selfPos.distanceToSquared(this.target.pos) > profile.leash * profile.leash))) {
      this.stalking = this.target.alive;
      this.target = null;
      this.engagedT = 0;
    }

    this.evalT -= dt;
    if (this.evalT > 0) { if (this.target) this.engagedT += dt; return this.target; }
    this.evalT = profile.evalEvery * (0.8 + Math.random() * 0.4); // jitter — packs don't move in lockstep

    let best: TargetCandidate | null = null, bestScore = -Infinity;
    for (const c of candidates) {
      if (!c.alive) continue;
      const dist = selfPos.distanceTo(c.pos);
      if (profile.leash > 0 && dist > profile.leash) continue;
      // Score: proximity (per ~40m) + decaying damage aggro + commit bonus.
      const s =
        profile.wDist / (1 + dist / 40) +
        profile.wDmg * Math.min(1, (this.threat.get(c.id) ?? 0) / 60) +
        (c === this.target || c.id === this.target?.id ? profile.sticky : 0);
      if (s > bestScore) { bestScore = s; best = c; }
    }
    const switched = best !== this.target && best?.id !== this.target?.id;
    this.target = best;
    if (best) this.stalking = false;
    if (switched) this.engagedT = 0;
    if (best) this.engagedT += dt;
    // Perception snapshot — only refreshes on eval ticks, and eval ticks
    // come slower for distant profiles. The pursuit point is where the
    // target *was*, so juking works.
    if (this.target) {
      this.lastSeen.copy(this.target.pos);
      this.lastSeenVel.copy(this.target.vel);
    }
    return best;
  }
}

/** WeakMap by enemy instance — zero fields added to entity classes, brains
 *  garbage-collect with their owners. */
export class TargetRegistry {
  private brains = new WeakMap<object, ThreatTable>();
  for(owner: object): ThreatTable {
    let b = this.brains.get(owner);
    if (!b) { b = new ThreatTable(); this.brains.set(owner, b); }
    return b;
  }
  /** Route a damage report to this creature's brain. */
  reportDamage(owner: object, attackerId: string, amount: number): void {
    this.for(owner).reportDamage(attackerId, amount);
  }
}
