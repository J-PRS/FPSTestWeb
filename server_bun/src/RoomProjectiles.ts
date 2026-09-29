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
 * clients resolve their own arcs) and no stickies. Ray-burst IS modeled:
 * crossing stats.rayDelay discharges a hitscan beam along the velocity
 * line (dischargeRay) so remote railgun blasts land where the beam hit.
 */
import { projStep, segFieldHit, segPointDist, segPointT, type SimProjectile } from '../../shared/projSim.ts';
import { segSolidHit } from '../../shared/solidWorld.ts';
import { structureColliders, type StructureCollider } from '../../shared/ballSim.ts';
import type { StructureSpec } from '../../shared/mapSpec.ts';
import { HM_DIVISOR, HM_HEIGHT_SCALE, type Heightfield } from '../../shared/heightfield.ts';
import { PLAYER_RADIUS } from '../../shared/constants.ts';
import { getWeaponStats } from '../../shared/weapons.ts';
import { GRAVITY } from '../../shared/movement.ts';
import { hitRadiusAt } from '../../shared/combat.ts';
import type { Vec3 } from './types.ts';
import type { Room } from './Room.ts';

interface LiveProj {
  id: string;
  ownerId: string;
  weaponType: number;
  p: SimProjectile;
  /** Age at which the parabola could first reach the terrain ceiling.
   *  Before it, segFieldHit is skipped — provably nothing below. */
  terrainAt: number;
}

// Player aim height — matches where the client sweeps the capsule center.
const CHEST_Y = 1.0;
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
  const t = Math.min(t0, t1);
  return t > 0 ? t : Infinity;
}

export class RoomProjectiles {
  private readonly room: Room;
  private field: Heightfield | null;
  /** Highest terrain height anywhere on the map — a shell above it
   *  cannot touch ground this step, so segFieldHit can be skipped. */
  private fieldMax = -Infinity;
  /** Solid map geometry — shells pop on walls like they do on terrain,
   *  so a mortar can't splash through the base roof. */
  private solids: readonly StructureCollider[] = [];
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
    this.projs.set(id, { id, ownerId, weaponType, p: { pos: { ...origin }, vel, age: 0 }, terrainAt });
    this.room.broadcast({
      type: 'projectileCreated', projectileId: id, ownerId,
      position: { ...origin }, velocity: vel, weaponType,
    });
    return id;
  }

  tick(dt: number): void {
    // Map iterators tolerate mid-loop delete (detonate) — no snapshot.
    for (const proj of this.projs.values()) {
      const stats = getWeaponStats(proj.weaponType);
      const p = proj.p;
      const prevAge = p.age;
      const from = projStep(p, dt, stats.gravity ? GRAVITY : 0);
      const ttl = stats.maxLifetime ?? HARD_TTL_S;
      if (p.age >= ttl || p.pos.y < FLOOR_Y) { this.detonate(proj, { ...p.pos }); continue; }

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
    const p = proj.p;
    // Server shells pop on first contact; the client's own bounce arc
    // diverges cosmetically, never in damage outcome.
    if (this.field && p.age >= proj.terrainAt) {
      const hit = segFieldHit(from, p.pos, this.field);
      if (hit) { this.detonate(proj, hit); return true; }
      // Still flying below the ceiling — sweep every tick from here on.
      proj.terrainAt = 0;
    }
    // Wall sweep before the player check — a shell that clips a face
    // detonates there instead of phasing through to someone inside.
    if (this.solids.length) {
      const hit = segSolidHit(from, p.pos, this.solids);
      if (hit) { this.detonate(proj, hit); return true; }
    }
    // Player sweep — same legal radius the hit-claim validator allows:
    // capsule radius + the larger of body/wake radius at this airtime.
    const reach = PLAYER_RADIUS + Math.max(stats.bodyRadius, hitRadiusAt(proj.weaponType, p.age));
    // Cheap sphere reject before the segment solve: a player who cannot
    // displace into reach this tick is skipped — provably, because the
    // bound is the server's own tracked |vel|·dt plus a teleport/impulse
    // slack that dwarfs any same-tick position delta.
    const midX = (from.x + p.pos.x) / 2, midY = (from.y + p.pos.y) / 2, midZ = (from.z + p.pos.z) / 2;
    const halfLen = Math.hypot(p.pos.x - from.x, p.pos.y - from.y, p.pos.z - from.z) / 2;
    for (const [pid, target] of this.room.players.getAllPlayers()) {
      if (pid === proj.ownerId || target.isDead) continue;
      const margin = reach + halfLen + (Math.hypot(target.velocity.x, target.velocity.y, target.velocity.z) + 25) * dt;
      const dx = target.position.x - midX, dy = target.position.y + CHEST_Y - midY, dz = target.position.z - midZ;
      if (dx * dx + dy * dy + dz * dz > margin * margin) continue;
      const center = { x: target.position.x, y: target.position.y + CHEST_Y, z: target.position.z };
      if (segPointDist(from, p.pos, center) <= reach) {
        this.detonate(proj, { ...p.pos }, pid);
        return true;
      }
    }
    return false;
  }

  /** Fire the shell's hitscan beam along its velocity line. Order of
   *  contacts decides the blast point: nearest wins between terrain and
   *  players, so a beam that clips a ridge never splashes past it. */
  private dischargeRay(proj: LiveProj, range: number): void {
    const p = proj.p;
    const speed = Math.hypot(p.vel.x, p.vel.y, p.vel.z) || 1;
    const end: Vec3 = {
      x: p.pos.x + (p.vel.x / speed) * range,
      y: p.pos.y + (p.vel.y / speed) * range,
      z: p.pos.z + (p.vel.z / speed) * range,
    };
    const reach = PLAYER_RADIUS + getWeaponStats(proj.weaponType).bodyRadius;
    // Track the earliest contact as a segment parameter [0..1].
    let bestT = 1, hitId: string | null = null;
    if (this.field) {
      const th = segFieldHit(p.pos, end, this.field);
      if (th) bestT = segPointT(p.pos, end, th);
    }
    if (this.solids.length) {
      const sh = segSolidHit(p.pos, end, this.solids);
      if (sh) bestT = Math.min(bestT, segPointT(p.pos, end, sh));
    }
    const midX = (p.pos.x + end.x) / 2, midY = (p.pos.y + end.y) / 2, midZ = (p.pos.z + end.z) / 2;
    const margin = reach + range / 2;
    for (const [pid, target] of this.room.players.getAllPlayers()) {
      if (pid === proj.ownerId || target.isDead) continue;
      const dx = target.position.x - midX, dy = target.position.y + CHEST_Y - midY, dz = target.position.z - midZ;
      if (dx * dx + dy * dy + dz * dz > margin * margin) continue;
      const center = { x: target.position.x, y: target.position.y + CHEST_Y, z: target.position.z };
      const t = segPointT(p.pos, end, center);
      if (t <= bestT && segPointDist(p.pos, end, center) <= reach) { bestT = t; hitId = pid; }
    }
    const at: Vec3 = {
      x: p.pos.x + (end.x - p.pos.x) * bestT,
      y: p.pos.y + (end.y - p.pos.y) * bestT,
      z: p.pos.z + (end.z - p.pos.z) * bestT,
    };
    this.detonate(proj, at, hitId);
  }

  private detonate(proj: LiveProj, at: Vec3, directHitId?: string | null): void {
    this.projs.delete(proj.id);
    this.room.broadcast({ type: 'projectileDestroyed', projectileId: proj.id });
    if (directHitId) this.room.messages.botAttack(proj.ownerId, directHitId, proj.weaponType);
    this.room.pushNoise(at); // a blast is louder than the muzzle that launched it
    this.room.messages.serverBlast(proj.ownerId, at, proj.weaponType, directHitId ?? null);
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
