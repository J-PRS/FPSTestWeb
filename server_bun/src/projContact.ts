import type { Vec3 } from './types.ts';
import { getWeaponStats } from '../../shared/weapons.ts';
import { PLAYER_RADIUS } from '../../shared/constants.ts';
import { classCapsule } from '../../shared/botClasses.ts';
import { hitRadiusAt } from '../../shared/combat.ts';
import { segFieldHit, segPointDist, segPointT } from '../../shared/projSim.ts';
import { segSolidHit } from '../../shared/solidWorld.ts';
import type { RoomProjectiles, LiveProj } from './RoomProjectiles.ts';

type ContactHost = RoomProjectiles;

/** The body sweep tests distance to the capsule's axis MIDPOINT, so the
 *  reach must cover the cylinder half-height or a heavy's helmet/knees
 *  slip past a legal body shot. */
function capsuleCenter(t: { position: Vec3; armorClass: string }): Vec3 {
  const cap = classCapsule(t.armorClass);
  return { x: t.position.x, y: t.position.y + cap.centerOff, z: t.position.z };
}
function capsuleReach(t: { armorClass: string }, reach: number): number {
  return reach + classCapsule(t.armorClass).half;
}

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
    // Fuse-only carriers (MRV) phase through bodies — contact pops would
    // make a timed airburst into a strictly-better mortar. Terrain, walls,
    // and domes above already stopped it; skip the body sweeps entirely.
    if (stats.fuseOnly) return false;
    // Arming fuse (T2 mortar): bodies phase through until the shell is
    // armed — terrain, walls, and domes above already stopped it. Client
    // prediction gates the same sweeps on config.armTime.
    if (stats.armTime !== undefined && p.age < stats.armTime) return false;
    // Player sweep — same legal radius the hit-claim validator allows:
    // capsule radius + the larger of body/wake radius at this airtime.
    const reach = PLAYER_RADIUS + Math.max(stats.bodyRadius, hitRadiusAt(proj.weaponType, p.age));
    return bodySweep(r, proj, stats, from, reach, dt) || creatureSweep(r, proj, stats, from, reach);
  }

/** Player sweep — a cheap midpoint-sphere reject (server |vel|·dt bound
 *  plus teleport slack) skips anyone who cannot displace into reach this
 *  tick before the per-candidate segment solve runs. */
function bodySweep(r: ContactHost, proj: LiveProj, stats: ReturnType<typeof getWeaponStats>, from: Vec3, reach: number, dt: number): boolean {
    const p = proj.p;
    const midX = (from.x + p.pos.x) / 2, midY = (from.y + p.pos.y) / 2, midZ = (from.z + p.pos.z) / 2;
    const halfLen = Math.hypot(p.pos.x - from.x, p.pos.y - from.y, p.pos.z - from.z) / 2;
    for (const [pid, target] of r.room.players.getAllPlayers()) {
      if (pid === proj.ownerId || target.isDead) continue;
      const margin = capsuleReach(target, reach) + halfLen + (Math.hypot(target.velocity.x, target.velocity.y, target.velocity.z) + 25) * dt;
      const center = capsuleCenter(target);
      const dx = center.x - midX, dy = center.y - midY, dz = center.z - midZ;
      if (dx * dx + dy * dy + dz * dz > margin * margin) continue;
      const pd = segPointDist(from, p.pos, center);
      if (pd <= capsuleReach(target, reach)) {
        // Wake contact counts as a hit but earns no airtime ramp — the
        // skillshot bonus is body-contact only, like the claim path.
        r.detonate(proj, { ...p.pos }, pid, undefined, pd <= PLAYER_RADIUS + stats.bodyRadius);
        return true;
      }
    }
    return false;
  }

/** Creature sweep — server shells connect with the swarm the same way a
 *  client's creatureHit claim does: earliest ball contact along the leg. */
function creatureSweep(r: ContactHost, proj: LiveProj, stats: ReturnType<typeof getWeaponStats>, from: Vec3, reach: number): boolean {
    const p = proj.p;
    const bc = r.room.ballSim?.sweepHit(from, p.pos, reach - PLAYER_RADIUS);
    // Species pops contest the same lane — earliest of ball/crawler
    // contact eats the shell, so a crawler body-blocks a shot meant
    // for a ball behind it (and vice versa).
    const cc = r.room.creatureSim?.sweepHit(from, p.pos, reach - PLAYER_RADIUS);
    const best = bc && (!cc || bc.t <= cc.t) ? bc : cc;
    if (!best) return false;
    const at: Vec3 = {
      x: from.x + (p.pos.x - from.x) * best.t,
      y: from.y + (p.pos.y - from.y) * best.t,
      z: from.z + (p.pos.z - from.z) * best.t,
    };
    const bodyDirect = best === bc
      ? (() => { const ball = r.room.ballSim?.ballAt(bc!.id); return !!ball && bc!.d <= ball.radius + stats.bodyRadius; })()
      : best.d <= stats.bodyRadius + 1;
    r.detonate(proj, at, null, best === bc ? best.id : undefined, bodyDirect, best === cc ? best.id : undefined);
    return true;
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
    // +0.6: the reject is off the capsule MIDPOINT — a heavy's cylinder
    // half-height (0.55) would let head/foot hits fall outside the bound.
    const margin = reach + range / 2 + 0.6;
    for (const [pid, target] of r.room.players.getAllPlayers()) {
      if (pid === proj.ownerId || target.isDead) continue;
      const center = capsuleCenter(target);
      const dx = center.x - midX, dy = center.y - midY, dz = center.z - midZ;
      if (dx * dx + dy * dy + dz * dz > margin * margin) continue;
      const t = segPointT(p.pos, end, center);
      if (t <= bestT && segPointDist(p.pos, end, center) <= capsuleReach(target, reach)) { bestT = t; hitId = pid; }
    }
    const at: Vec3 = {
      x: p.pos.x + (end.x - p.pos.x) * bestT,
      y: p.pos.y + (end.y - p.pos.y) * bestT,
      z: p.pos.z + (end.z - p.pos.z) * bestT,
    };
    // Ray reach is bodyRadius-only — any hitId here is a true body hit.
    r.detonate(proj, at, hitId, undefined, true);
  }

