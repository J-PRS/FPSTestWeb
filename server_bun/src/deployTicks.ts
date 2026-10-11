import type { Vec3, ServerMessage } from './types.ts';
import { segSolidHit } from '../../shared/solidWorld.ts';
import { WORLD_MODEL, eventPayload } from '../../shared/worldModel.ts';
import { FORCE_SEND_MS } from './combatBlast.ts';
import type { Deployed, RoomDeployables } from './RoomDeployables.ts';
import {
  TURRET_RANGE, TURRET_FIRE_INTERVAL, TURRET_DAMAGE,
  MINE_TRIGGER_DIST, MINE_DAMAGE, MINE_BLAST_RADIUS, MINE_KNOCKBACK,
  STATION_RANGE, STATION_HEAL_CD, STATION_HP_RATE,
  DRONE_HOVER_UP, DRONE_RANGE, DRONE_DAMAGE, DRONE_FIRE_INTERVAL,
} from './RoomDeployables.ts';
import { healPool } from './healPool.ts';
import { DEPLOY_ITEMS } from '../../shared/deployItems.ts';
import { simNow } from './simClock.ts';
import { wallNow , wallMs} from './wallClock.ts';

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
    if (d.fireCd > 0) {return;}
    const dTeam = r.teamOf(d);
    let target: string | null = null;
    let bestD2 = DRONE_RANGE * DRONE_RANGE;
    for (const [pid, p] of r.room.players.getAllPlayers()) {
      if (p.isDead || pid === d.owner) {continue;}
      if (dTeam && p.team === dTeam) {continue;}
      if (p.protectedUntil > simNow()) {continue;}
      const dx = p.position.x - d.pos.x, dy = p.position.y - d.pos.y, dz = p.position.z - d.pos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= bestD2) {continue;}
      if (!losClear(r, d.pos, p.position, dTeam)) {continue;}
      bestD2 = d2; target = pid;
    }
    if (!target) { d.fireCd = 0.15; return; }
    d.fireCd = DRONE_FIRE_INTERVAL;
    r.room.broadcast(eventPayload(WORLD_MODEL.deploy!, 'turretShot', 'id', d.id, { owner: d.owner, targetId: target }) as ServerMessage);
    r.room.messages.turretAttack(d.owner, target, DRONE_DAMAGE);
  }

  /** Proximity mine: after the arm delay, a hostile stepping inside the
   *  fuse radius detonates it — blast applies through the shared AOE
   *  funnel (falloff + knockback + friendly gate), clients paint the boom
   *  off the mineBoom broadcast. */
export function tickMine(r: RoomDeployables, d: Deployed, _dt: number): void {
    d.fireCd -= _dt; // doubles as the arm timer
    if (d.fireCd > 0) {return;}
    const dTeam = r.teamOf(d);
    for (const [pid, p] of r.room.players.getAllPlayers()) {
      if (p.isDead || pid === d.owner) {continue;}
      if (dTeam && p.team === dTeam) {continue;}
      // Spawn grace exempts like the sentry scan — a fresh spawn standing
      // on a fuse shouldn't eat it before control hands over.
      if (p.protectedUntil > simNow()) {continue;}
      const dx = p.position.x - d.pos.x, dy = p.position.y - d.pos.y, dz = p.position.z - d.pos.z;
      if (dx * dx + dy * dy + dz * dz < MINE_TRIGGER_DIST * MINE_TRIGGER_DIST) {
        r.room.broadcast(eventPayload(WORLD_MODEL.deploy!, 'mineBoom', 'id', d.id, { owner: d.owner, pos: { ...d.pos} }) as ServerMessage);
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
    if (d.fireCd > 0) {return;}
    d.fireCd = STATION_HEAL_CD;
    const dTeam = r.teamOf(d);
    for (const [pid, p] of r.room.players.getAllPlayers()) {
      if (p.isDead) {continue;}
      if (dTeam && p.team !== dTeam) {continue;}
      const dx = p.position.x - d.pos.x, dy = p.position.y - d.pos.y, dz = p.position.z - d.pos.z;
      if (dx * dx + dy * dy + dz * dz > STATION_RANGE * STATION_RANGE) {continue;}
      if (p.health >= p.maxHealth) {continue;}
      healPool(p, p.maxHealth * STATION_HP_RATE * STATION_HEAL_CD);
      p.forceSendUntil = wallMs(wallNow() + FORCE_SEND_MS);
      void pid;
    }
  }

  /** Structure LOS for the gun scan — a sentry indoors shouldn't plink
   *  players outside through the wall. Target at chest height. */
export function losClear(r: RoomDeployables, from: Vec3, to: Vec3, team?: string): boolean {
    const cols = r.room.ballSim.colliders;
    if (cols.length === 0) {return true;}
    return !segSolidHit(
      { x: from.x, y: from.y + 0.5, z: from.z },
      { x: to.x, y: to.y + 1, z: to.z },
      cols, r.room.ballSim.colliderIndex ?? undefined, team,
    );
  }

  /** Server-side sentry fire: nearest hostile player in the envelope gets
   *  a bolt every TURRET_FIRE_INTERVAL. Damage rides the shared funnel so
   *  kill credit, spawn protection and respawn all behave — the client
   *  visual layer shows the matching rocket via the turretShot broadcast. */
export function tickTurret(r: RoomDeployables, d: Deployed, dt: number): void {
    d.fireCd -= dt;
    if (d.fireCd > 0) {return;}
    const dTeam = r.teamOf(d);
    let target: string | null = null;
    let bestD2 = TURRET_RANGE * TURRET_RANGE;
    for (const [pid, p] of r.room.players.getAllPlayers()) {
      if (p.isDead || pid === d.owner) {continue;}
      if (dTeam && p.team === dTeam) {continue;}
      if (p.protectedUntil > simNow()) {continue;}
      const dx = p.position.x - d.pos.x, dy = p.position.y - d.pos.y, dz = p.position.z - d.pos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= bestD2) {continue;}
      if (!losClear(r, d.pos, p.position, dTeam)) {continue;}
      bestD2 = d2; target = pid;
    }
    if (!target) { d.fireCd = Math.min(d.fireCd + 0.15, 0.15); return; } // idle scan: cheap re-check
    d.fireCd = TURRET_FIRE_INTERVAL;
    r.room.broadcast(eventPayload(WORLD_MODEL.deploy!, 'turretShot', 'id', d.id, { owner: d.owner, targetId: target }) as ServerMessage);
    r.room.messages.turretAttack(d.owner, target, TURRET_DAMAGE);}

const SENTRY_RANGE = DEPLOY_ITEMS.baseturret.range!;
const SENTRY_FIRE_INTERVAL = DEPLOY_ITEMS.baseturret.fireInterval!;
const SENTRY_DAMAGE = DEPLOY_ITEMS.baseturret.damage!;
const SENTRY_BOLT_SPEED = DEPLOY_ITEMS.baseturret.projSpeed!;
const SENTRY_BLAST_RADIUS = DEPLOY_ITEMS.baseturret.blastRadius!;
const SENTRY_KNOCKBACK = DEPLOY_ITEMS.baseturret.knockback!;

/** Base sentry: same nearest-hostile scan as the field turret, but the
 *  shell is a REAL bolt — it aims at the target's lead point (pos +
 *  vel × flight time), flies there, then blasts whoever's still inside
 *  the small radius. Moving targets are dodged honestly: nothing homes.
 *  The sentryShot broadcast carries the aim point so clients paint the
 *  same straight-line flight. */
export function tickSentry(r: RoomDeployables, d: Deployed, dt: number): void {
    d.fireCd -= dt;
    if (d.fireCd > 0) {return;}
    const dTeam = r.teamOf(d);
    let target: string | null = null;
    let tp: { x: number; y: number; z: number } | null = null;
    let tv = { x: 0, y: 0, z: 0 };
    let bestD2 = SENTRY_RANGE * SENTRY_RANGE;
    for (const [pid, p] of r.room.players.getAllPlayers()) {
      if (p.isDead || pid === d.owner) {continue;}
      if (dTeam && p.team === dTeam) {continue;}
      if (p.protectedUntil > simNow()) {continue;}
      const dx = p.position.x - d.pos.x, dy = p.position.y - d.pos.y, dz = p.position.z - d.pos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= bestD2) {continue;}
      if (!losClear(r, d.pos, p.position, dTeam)) {continue;}
      bestD2 = d2; target = pid; tp = p.position;
      tv = { x: p.velocity?.x ?? 0, y: p.velocity?.y ?? 0, z: p.velocity?.z ?? 0 };
    }
    if (!target || !tp) { d.fireCd = 0.15; return; }
    d.fireCd = SENTRY_FIRE_INTERVAL;
    const dist = Math.sqrt(bestD2);
    const flight = dist / SENTRY_BOLT_SPEED;
    // Lead the runner at chest height — a still target gets the bolt dead
    // on, a skier crossing at 40 m/s watches it land behind them.
    const aim = {
      x: tp.x + tv.x * flight,
      y: tp.y + 1 + tv.y * flight * 0.5, // partial vertical lead — bolts drop nothing anyway
      z: tp.z + tv.z * flight,
    };
    r.room.broadcast(eventPayload(WORLD_MODEL.deploy!, 'sentryShot', 'id', d.id, { owner: d.owner, x: aim.x, y: aim.y, z: aim.z }) as ServerMessage);
    r.bolts.push({ at: aim, ttl: flight, owner: d.owner, dmg: SENTRY_DAMAGE, rad: SENTRY_BLAST_RADIUS, kb: SENTRY_KNOCKBACK });
}

const SENSOR_RANGE = DEPLOY_ITEMS.sensor.range!;
const SENSOR_SCAN_S = DEPLOY_ITEMS.sensor.fireInterval!;

/** Base sensor mast: sweeps its radius for hostiles and relays them to
 *  the owning team — the compound's early-warning net. Clients draw the
 *  pings as map blips; enemies learn to kill the mast first, which is
 *  the point of a raid prep phase. */
export function tickSensor(r: RoomDeployables, d: Deployed, dt: number): void {
    d.fireCd -= dt;
    if (d.fireCd > 0) {return;}
    d.fireCd = SENSOR_SCAN_S;
    const dTeam = r.teamOf(d);
    const targets: { id: string; x: number; y: number; z: number }[] = [];
    for (const [pid, p] of r.room.players.getAllPlayers()) {
      if (p.isDead) {continue;}
      if (dTeam && p.team === dTeam) {continue;}
      const dx = p.position.x - d.pos.x, dy = p.position.y - d.pos.y, dz = p.position.z - d.pos.z;
      if (dx * dx + dy * dy + dz * dz > SENSOR_RANGE * SENSOR_RANGE) {continue;}
      targets.push({ id: pid, x: p.position.x, y: p.position.y, z: p.position.z });
    }
    if (targets.length === 0) {return;}
    r.room.broadcast(eventPayload(WORLD_MODEL.deploy!, 'sensorPing', 'id', d.id, { team: dTeam, targets }) as ServerMessage);
}
