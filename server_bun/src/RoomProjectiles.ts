/**
 * Server-side ballistic sim — bots-as-legal-players phase 2.
 *
 * A bot fire no longer means "broadcast a tracer, roll damage". It spawns
 * a real projectile the room integrates through shared/projSim.ts: swept
 * segment vs the heightfield and every live player's capsule, then damage
 * through the same CombatHandler funnels a client's validated claim uses
 * (applyHit → kill credit, weapon attribution, friendly gate, respawn).
 *
 * Clients render the replica off the existing projectileCreated /
 * projectileDestroyed pair — remote projectiles already fly
 * deterministically client-side, so nothing new is needed there.
 *
 * Deliberate simplifications vs the client Projectile: no terrain bounce
 * (a server shell pops on contact — bounces are cosmetic anyway since
 * clients resolve their own arcs). Stickies DO chain: a blast ages every
 * sibling in its radius to fuse, so server pops match the client's
 * visible cook-off. Ray-burst IS modeled:
 * crossing stats.rayDelay discharges a hitscan beam along the velocity
 * line (dischargeRay) so remote railgun blasts land where the beam hit.
 */
import { projStep, type SimProjectile } from '../../shared/projSim.ts';
import { ColliderIndex } from '../../shared/solidWorld.ts';
import { structureColliders, type StructureCollider } from '../../shared/ballSim.ts';
import type { StructureSpec } from '../../shared/mapSpec.ts';
import { HM_DIVISOR, HM_HEIGHT_SCALE, type Heightfield } from '../../shared/heightfield.ts';
import { getWeaponStats, WeaponType, idSeed, jitteredTtl, scaledDirectDamage } from '../../shared/weapons.ts';
import { GRAVITY } from '../../shared/movement.ts';
import type { Vec3 } from './types.ts';
import type { Room } from './Room.ts';
import { stepContact, dischargeRay } from './projContact.ts';
import { weaponStats } from './weaponStats.ts';

export interface LiveProj {
  id: string;
  ownerId: string;
  weaponType: number;
  /** Stats are weapon-table constants — resolved once at spawn instead of
   *  re-looked-up every tick/discharge per projectile. */
  stats: NonNullable<ReturnType<typeof getWeaponStats>>;
  p: SimProjectile;
  /** Age at which the parabola could first reach the terrain ceiling.
   *  Before it, segFieldHit is skipped — provably nothing below. */
  terrainAt: number;
  /** This shell's fuse — maxLifetime jittered per id so burst weapons
   *  (flak) pop raggedly. Client replicas derive the same value from the
   *  projectileId, so both ends' pops line up. */
  ttl: number;
}

// Player aim height — matches where the client sweeps the capsule center.
// Failsafe TTL for weapons that forgot a fuse — nothing should orbit forever.
const HARD_TTL_S = 8;
// Below this altitude the shell is irrecoverably underground / off-map.
const FLOOR_Y = -220;

/** Earliest future time (from now, seconds) at which the parabola
 *  y(t) = y0 + vy·t + ½g·t² can descend to `ceiling`. Infinity when the
 *  shell is rising or gravity-free and never returns there. The result is
 *  a floor for skipping terrain sweeps: no heightfield texel exceeds the
 *  precomputed max, so a miss before this time is impossible. */
function timeToCeiling(y0: number, vy: number, g: number, ceiling: number): number {
  if (y0 <= ceiling) return 0;                       // already inside — check now
  const target = ceiling - y0;                        // negative drop needed
  if (g === 0) {
    if (vy >= 0) return Infinity;                    // flat/rising forever
    return (target / vy);                            // vy<0: linear descent
  }
  // ½g·t² + vy·t + (y0−ceiling) = 0 → smaller root is first descent to it.
  const a = 0.5 * g, c = y0 - ceiling;
  const disc = vy * vy - 4 * a * c;
  if (disc < 0) return Infinity;                     // apex never reaches it
  const sq = Math.sqrt(disc);
  const t1 = (-vy - sq) / (2 * a);
  const t0 = (-vy + sq) / (2 * a);
  // First descent = smallest positive root; taking min() picks the
  // negative root whenever vy≈0 and the sweep gets scheduled at Infinity.
  if (t0 > 0) return Math.min(t0, t1 > 0 ? t1 : t0);
  return t1 > 0 ? t1 : Infinity;
}

export class RoomProjectiles {
  readonly room: Room;
  field: Heightfield | null;
  /** Highest terrain height anywhere on the map — a shell above it
   *  cannot touch ground this step, so segFieldHit can be skipped. */
  fieldMax = -Infinity;
  /** Solid map geometry — shells pop on walls like they do on terrain,
   *  so a mortar can't splash through the base roof. */
  solids: readonly StructureCollider[] = [];
  /** Structure occluders — the beam contact check reads the same set the
   *  flight sweep detonates against. */
  get solidColliders(): readonly StructureCollider[] { return this.solids; }
  solidIndex: ColliderIndex | null = null;
  private projs = new Map<string, LiveProj>();
  private nextId = 1;

  constructor(room: Room, field: Heightfield | null) {
    this.room = room;
    this.field = null;
    this.attachField(field);
  }

  /** Map rotation / admin reload can swap the terrain under a live
   *  room — shells must sweep the field players actually stand on. */
  attachField(field: Heightfield | null): void {
    this.field = field;
    // One full scan per field swap; ticks then solve vs this bound.
    let maxByte = 0;
    if (field) {
      const d = field.data, s = field.stride;
      for (let i = 0; i < d.length; i += s) if (d[i]! > maxByte) maxByte = d[i]!;
    }
    this.fieldMax = (maxByte / HM_DIVISOR) * HM_HEIGHT_SCALE;
    // Schedules were solved against the old ceiling — resweep until each
    // arc re-earns its skip against the new field.
    for (const proj of this.projs.values()) proj.terrainAt = 0;
  }

  /** Structures ride the same lifecycle as the field — spec load and
   *  admin reload both refresh them. */
  attachStructures(list: readonly StructureSpec[] | undefined): void {
    this.solids = structureColliders(list);
    this.solidIndex = this.solids.length ? new ColliderIndex(this.solids) : null;
  }

  /** Fire a real projectile. `dir` is normalized; muzzle velocity = dir*speed
   *  + 50% of the shooter's velocity (same inheritance the client applies). */
  spawn(ownerId: string, weaponType: number, origin: Vec3, dir: Vec3, ownerVel: Vec3): string | null {
    const stats = getWeaponStats(weaponType);
    if (!stats || stats.speed <= 0) return null; // hitscan-class — no body
    const owner = this.room.players.getPlayer(ownerId);
    if (!owner) return null;
    const id = `sp-${this.nextId++}`;
    const vel: Vec3 = {
      x: dir.x * stats.speed + ownerVel.x * 0.5,
      y: dir.y * stats.speed + ownerVel.y * 0.5,
      z: dir.z * stats.speed + ownerVel.z * 0.5,
    };
    const g = stats.gravity ? GRAVITY : 0;
    // Schedule the first age at which this arc could reach the terrain
    // ceiling; spawned inside it → sweep every tick as before.
    const terrainAt = this.field ? timeToCeiling(origin.y, vel.y, g, this.fieldMax + stats.bodyRadius) : 0;
    this.projs.set(id, {
      id, ownerId, weaponType, stats, p: { pos: { ...origin }, vel, age: 0 }, terrainAt,
      ttl: jitteredTtl(stats, idSeed(id)) ?? HARD_TTL_S,
    });
    this.room.broadcast({
      type: 'projectileCreated', projectileId: id, ownerId,
      position: { ...origin }, velocity: vel, weaponType,
    });
    return id;
  }

  tick(dt: number): void {
    // Map iterators tolerate mid-loop delete (detonate) — no snapshot.
    for (const proj of this.projs.values()) {
      const stats = proj.stats;
      const p = proj.p;
      const prevAge = p.age;
      const from = projStep(p, dt, stats.gravity ? GRAVITY : 0);
      if (p.age >= proj.ttl || p.pos.y < FLOOR_Y) { this.detonate(proj, { ...p.pos }); continue; }

      // Ray-burst discharge (remote railgun): crossing rayDelay turns the
      // shell's velocity line into a hitscan beam — the earliest contact
      // along it is where the payload detonates.
      if (stats.rayDelay && prevAge < stats.rayDelay && p.age >= stats.rayDelay) {
        this.dischargeRay(proj, stats.rayRange ?? 160);
        continue;
      }

      if (this.stepContact(proj, stats, from, dt)) continue;
      // No contact — still flying; survives to the next tick.
    }
  }

  /** Swept terrain + player contact for one flight step; detonates on
   *  first touch and reports whether the shell is gone. */
  private stepContact(proj: LiveProj, stats: ReturnType<typeof getWeaponStats>, from: Vec3, dt: number): boolean {
    return stepContact(this, proj, stats, from, dt);
  }

  /** Fire the shell's hitscan beam along its velocity line. */
  private dischargeRay(proj: LiveProj, range: number): void {
    dischargeRay(this, proj, range);
  }

  detonate(proj: LiveProj, at: Vec3, directHitId?: string | null, ballId?: number, bodyDirect?: boolean, crawlerId?: number): void {
    this.projs.delete(proj.id);
    this.room.broadcast({ type: 'projectileDestroyed', projectileId: proj.id });
    // Skillshot ramp: sim shells carry their real flight age — a bot's
    // 2s disc lead pays the same multiplier a player's claim would. Wake
    // contacts still pay flat directDamage; only body hits earn it.
    const rampAge = bodyDirect ? proj.p.age : undefined;
    if (directHitId) this.room.messages.botAttack(proj.ownerId, directHitId, proj.weaponType, rampAge);
    // A shell that lands on a creature deals its direct line, then the
    // blast splashes the rest of the swarm — same outcome a player-caused
    // hit + aoeShot pair produces, minus the claims.
    if (ballId !== undefined) {
      const dmg = scaledDirectDamage(proj.weaponType, rampAge) || proj.stats.aoeDamage;
      const killed = this.room.ballSim?.handleHit(proj.ownerId, ballId, dmg) ?? false;
      weaponStats.record(this.room.mode, `w${proj.weaponType}:prey`, dmg, killed, proj.ownerId.startsWith('BOT-'));
    }
    if (crawlerId !== undefined) {
      const dmg = scaledDirectDamage(proj.weaponType, rampAge) || proj.stats.aoeDamage;
      const killed = this.room.creatureSim?.handleHit(proj.ownerId, crawlerId, dmg) ?? false;
      weaponStats.record(this.room.mode, `w${proj.weaponType}:prey`, dmg, killed, proj.ownerId.startsWith('BOT-'));
    }
    this.room.pushNoise(at); // a blast is louder than the muzzle that launched it
    this.room.messages.serverBlast(proj.ownerId, at, proj.weaponType, directHitId ?? null);
    if (proj.stats.aoeRadius > 0) {
      this.room.ballSim?.splashDamage(proj.ownerId, at, proj.stats.aoeRadius, proj.stats.aoeDamage, ballId);
      this.room.creatureSim?.splashDamage(proj.ownerId, at, proj.stats.aoeRadius, proj.stats.aoeDamage, crawlerId);
    }

    // Sticky chain: a blast cooks every sibling bomb in its radius — the
    // client already rips the chain visually; aging siblings to fuse lets
    // the same cascade happen server-side so blasts land when shown.
    if (proj.weaponType === WeaponType.Sticky) {
      const r2 = proj.stats.aoeRadius * proj.stats.aoeRadius;
      for (const sib of this.projs.values()) {
        if (sib.weaponType !== WeaponType.Sticky) continue;
        const dx = sib.p.pos.x - at.x, dy = sib.p.pos.y - at.y, dz = sib.p.pos.z - at.z;
        if (dx * dx + dy * dy + dz * dz <= r2) {
          sib.p.age = sib.stats.maxLifetime ?? HARD_TTL_S;
        }
      }
    }
  }

  /** Shells inside `radius` that are closing on `pos` — feeds bot threat
   *  sense so brains can sidestep incoming fire like a human reading a
   *  rocket's approach. A shell flying away is no threat regardless of
   *  distance. */
  incomingNear(pos: Vec3, radius: number): Vec3[] {
    const out: Vec3[] = [];
    for (const proj of this.projs.values()) {
      const dx = pos.x - proj.p.pos.x, dy = pos.y - proj.p.pos.y, dz = pos.z - proj.p.pos.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > radius) continue;
      const closing = proj.p.vel.x * dx + proj.p.vel.y * dy + proj.p.vel.z * dz;
      if (closing <= 0) continue; // moving away — ignore
      out.push(proj.p.pos);
    }
    return out;
  }

  /** Drop an owner's live shells — disconnect/reap cleanup like the
   *  client-side destroy path. */
  clearOwner(ownerId: string): void {
    for (const [id, proj] of this.projs) {
      if (proj.ownerId === ownerId) {
        this.projs.delete(id);
        this.room.broadcast({ type: 'projectileDestroyed', projectileId: id });
      }
    }
  }
}
