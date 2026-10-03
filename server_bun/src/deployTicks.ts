import type { Vec3 } from './types.ts';
import { segSolidHit } from '../../shared/solidWorld.ts';
import { FORCE_SEND_MS } from './combatBlast.ts';
import type { Deployed, RoomDeployables } from './RoomDeployables.ts';
import {
  TURRET_RANGE, TURRET_FIRE_INTERVAL, TURRET_DAMAGE,
  MINE_TRIGGER_DIST, MINE_DAMAGE, MINE_BLAST_RADIUS, MINE_KNOCKBACK,
  STATION_RANGE, STATION_HEAL_CD, STATION_HP_RATE,
  DRONE_HOVER_UP, DRONE_RANGE, DRONE_DAMAGE, DRONE_FIRE_INTERVAL,
} from './RoomDeployables.ts';
import { healPool } from './healPool.ts';
import { simNow } from './simClock.ts';
import { wallNow } from './wallClock.ts';

// Per-kind deployable ticks — drone escort scan, proximity-mine fuse,
// resupply-pad pulse, structure LOS, sentry fire. RoomDeployables owns
// the item table + lifecycle; the behavior half lives here.

  /** Escort drone: shadow follows the owner's hover anchor, and the same
   *  nearest-hostile scan as the sentry plinks whoever's in range. */
export function tickDrone(r: RoomDeployables, d: Deployed, dt: number): void {
    const owner = r.room.players.getPlayer(d.owner);
    if (!owner || owner.isDead) { r.remove(d.id); return; }
    d.pos.x = owner.position.x;
    d.pos.y = owner.position.y + DRONE_HOVER_UP;
    d.pos.z = owner.position.z;
    d.fireCd -= dt;
    if (d.fireCd > 0) return;
    let target: string | null = null;
    let bestD2 = DRONE_RANGE * DRONE_RANGE;
    for (const [pid, p] of r.room.players.getAllPlayers()) {
      if (p.isDead || pid === d.owner) continue;
      if (owner.team && p.team === owner.team) continue;
      if (p.protectedUntil > simNow()) continue;
      const dx = p.position.x - d.pos.x, dy = p.position.y - d.pos.y, dz = p.position.z - d.pos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= bestD2) continue;
      if (!losClear(r, d.pos, p.position)) continue;
      bestD2 = d2; target = pid;
    }
    if (!target) { d.fireCd = 0.15; return; }
    d.fireCd = DRONE_FIRE_INTERVAL;
    r.room.broadcast({ type: 'turretShot', id: d.id, owner: d.owner, targetId: target });
    r.room.messages.turretAttack(d.owner, target, DRONE_DAMAGE);
  }

  /** Proximity mine: after the arm delay, a hostile stepping inside the
   *  fuse radius detonates it — blast applies through the shared AOE
   *  funnel (falloff + knockback + friendly gate), clients paint the boom
   *  off the mineBoom broadcast. */
export function tickMine(r: RoomDeployables, d: Deployed, _dt: number): void {
    d.fireCd -= _dt; // doubles as the arm timer
    if (d.fireCd > 0) return;
    const owner = r.room.players.getPlayer(d.owner);
    for (const [pid, p] of r.room.players.getAllPlayers()) {
      if (p.isDead || pid === d.owner) continue;
      if (owner?.team && p.team === owner.team) continue;
      // Spawn grace exempts like the sentry scan — a fresh spawn standing
      // on a fuse shouldn't eat it before control hands over.
      if (p.protectedUntil > simNow()) continue;
      const dx = p.position.x - d.pos.x, dy = p.position.y - d.pos.y, dz = p.position.z - d.pos.z;
      if (dx * dx + dy * dy + dz * dz < MINE_TRIGGER_DIST * MINE_TRIGGER_DIST) {
        r.room.broadcast({ type: 'mineBoom', id: d.id, owner: d.owner, pos: { ...d.pos } });
        r.remove(d.id);
        r.room.messages.mineBlast(d.owner, d.pos, MINE_DAMAGE, MINE_BLAST_RADIUS, MINE_KNOCKBACK);
        return;
      }
    }
  }

  /** Resupply pad: friendlies in the envelope get a slow health refill.
   *  Energy stays client-side (the move shadow doesn't model the tank
   *  top-off) — health is the server-owned half of the pad's job. */
export function tickStation(r: RoomDeployables, d: Deployed, dt: number): void {
    d.fireCd -= dt;
    if (d.fireCd > 0) return;
    d.fireCd = STATION_HEAL_CD;
    const owner = r.room.players.getPlayer(d.owner);
    for (const [pid, p] of r.room.players.getAllPlayers()) {
      if (p.isDead) continue;
      if (owner?.team && p.team !== owner.team) continue;
      const dx = p.position.x - d.pos.x, dy = p.position.y - d.pos.y, dz = p.position.z - d.pos.z;
      if (dx * dx + dy * dy + dz * dz > STATION_RANGE * STATION_RANGE) continue;
      if (p.health >= p.maxHealth) continue;
      healPool(p, p.maxHealth * STATION_HP_RATE * STATION_HEAL_CD);
      p.forceSendUntil = wallNow() + FORCE_SEND_MS;
      void pid;
    }
  }

  /** Structure LOS for the gun scan — a sentry indoors shouldn't plink
   *  players outside through the wall. Target at chest height. */
export function losClear(r: RoomDeployables, from: Vec3, to: Vec3): boolean {
    const cols = r.room.ballSim.colliders;
    if (!cols.length) return true;
    return !segSolidHit(
      { x: from.x, y: from.y + 0.5, z: from.z },
      { x: to.x, y: to.y + 1.0, z: to.z },
      cols, r.room.ballSim.colliderIndex ?? undefined,
    );
  }

  /** Server-side sentry fire: nearest hostile player in the envelope gets
   *  a bolt every TURRET_FIRE_INTERVAL. Damage rides the shared funnel so
   *  kill credit, spawn protection and respawn all behave — the client
   *  visual layer shows the matching rocket via the turretShot broadcast. */
export function tickTurret(r: RoomDeployables, d: Deployed, dt: number): void {
    d.fireCd -= dt;
    if (d.fireCd > 0) return;
    const owner = r.room.players.getPlayer(d.owner);
    let target: string | null = null;
    let bestD2 = TURRET_RANGE * TURRET_RANGE;
    for (const [pid, p] of r.room.players.getAllPlayers()) {
      if (p.isDead || pid === d.owner) continue;
      if (owner?.team && p.team === owner.team) continue;
      if (p.protectedUntil > simNow()) continue;
      const dx = p.position.x - d.pos.x, dy = p.position.y - d.pos.y, dz = p.position.z - d.pos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= bestD2) continue;
      if (!losClear(r, d.pos, p.position)) continue;
      bestD2 = d2; target = pid;
    }
    if (!target) { d.fireCd = Math.min(d.fireCd + 0.15, 0.15); return; } // idle scan: cheap re-check
    d.fireCd = TURRET_FIRE_INTERVAL;
    r.room.broadcast({ type: 'turretShot', id: d.id, owner: d.owner, targetId: target });
    r.room.messages.turretAttack(d.owner, target, TURRET_DAMAGE);}
