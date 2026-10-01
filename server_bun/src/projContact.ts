import type { Vec3 } from './types.ts';
import { getWeaponStats } from '../../shared/weapons.ts';
import { PLAYER_RADIUS } from '../../shared/constants.ts';
import { hitRadiusAt } from '../../shared/combat.ts';
import { segFieldHit, segPointDist, segPointT } from '../../shared/projSim.ts';
import { segSolidHit } from '../../shared/solidWorld.ts';
import type { RoomProjectiles, LiveProj } from './RoomProjectiles.ts';

type ContactHost = RoomProjectiles;

const CHEST_Y = 1.0;

export function stepContact(r: ContactHost, proj: LiveProj, stats: ReturnType<typeof getWeaponStats>, from: Vec3, dt: number): boolean {
    const p = proj.p;
    // Server shells pop on first contact; the client's own bounce arc
    // diverges cosmetically, never in damage outcome.
    if (r.field && p.age >= proj.terrainAt) {
      const hit = segFieldHit(from, p.pos, r.field);
      if (hit) { r.detonate(proj, hit); return true; }
      // Still flying below the ceiling — sweep every tick from here on.
      proj.terrainAt = 0;
    }
    // Wall sweep before the player check — a shell that clips a face
    // detonates there instead of phasing through to someone inside.
    if (r.solids.length) {
      const hit = segSolidHit(from, p.pos, r.solids, r.solidIndex ?? undefined);
      if (hit) { r.detonate(proj, hit); return true; }
    }
    // Shield sweep — an enemy dome eats the shell at the field's edge,
    // before any body inside can be reached. Walls already won if they
    // hit earlier in the frame (sequential order like everything else).
    const st = r.room.deployables.shieldBlock(from, p.pos, proj.ownerId);
    if (st !== null) {
      r.detonate(proj, {
        x: from.x + (p.pos.x - from.x) * st,
        y: from.y + (p.pos.y - from.y) * st,
        z: from.z + (p.pos.z - from.z) * st,
      });
      return true;
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
    for (const [pid, target] of r.room.players.getAllPlayers()) {
      if (pid === proj.ownerId || target.isDead) continue;
      const margin = reach + halfLen + (Math.hypot(target.velocity.x, target.velocity.y, target.velocity.z) + 25) * dt;
      const dx = target.position.x - midX, dy = target.position.y + CHEST_Y - midY, dz = target.position.z - midZ;
      if (dx * dx + dy * dy + dz * dz > margin * margin) continue;
      const center = { x: target.position.x, y: target.position.y + CHEST_Y, z: target.position.z };
      if (segPointDist(from, p.pos, center) <= reach) {
        r.detonate(proj, { ...p.pos }, pid);
        return true;
      }
    }
    // Creature sweep — server shells connect with the swarm the same way a
    // client's creatureHit claim does: earliest ball contact along the leg.
    const bc = r.room.ballSim?.sweepHit(from, p.pos, reach - PLAYER_RADIUS);
    if (bc) {
      const at: Vec3 = {
        x: from.x + (p.pos.x - from.x) * bc.t,
        y: from.y + (p.pos.y - from.y) * bc.t,
        z: from.z + (p.pos.z - from.z) * bc.t,
      };
      r.detonate(proj, at, null, bc.id);
      return true;
    }
    return false;
  }

  /** Fire the shell's hitscan beam along its velocity line. Order of
   *  contacts decides the blast point: nearest wins between terrain and
   *  players, so a beam that clips a ridge never splashes past it. */
export function dischargeRay(r: ContactHost, proj: LiveProj, range: number): void {
    const p = proj.p;
    const speed = Math.hypot(p.vel.x, p.vel.y, p.vel.z) || 1;
    const end: Vec3 = {
      x: p.pos.x + (p.vel.x / speed) * range,
      y: p.pos.y + (p.vel.y / speed) * range,
      z: p.pos.z + (p.vel.z / speed) * range,
    };
    const reach = PLAYER_RADIUS + proj.stats.bodyRadius;
    // Track the earliest contact as a segment parameter [0..1].
    let bestT = 1, hitId: string | null = null;
    if (r.field) {
      const th = segFieldHit(p.pos, end, r.field);
      if (th) bestT = segPointT(p.pos, end, th);
    }
    if (r.solids.length) {
      const sh = segSolidHit(p.pos, end, r.solids, r.solidIndex ?? undefined);
      if (sh) bestT = Math.min(bestT, segPointT(p.pos, end, sh));
    }
    // A dome eats the discharged beam too — same rule as flight contact.
    const sht = r.room.deployables.shieldBlock(p.pos, end, proj.ownerId);
    if (sht !== null) bestT = Math.min(bestT, sht);
    const midX = (p.pos.x + end.x) / 2, midY = (p.pos.y + end.y) / 2, midZ = (p.pos.z + end.z) / 2;
    const margin = reach + range / 2;
    for (const [pid, target] of r.room.players.getAllPlayers()) {
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
    r.detonate(proj, at, hitId);
  }

