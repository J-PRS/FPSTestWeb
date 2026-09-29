/**
 * RoomDeployables — server-authoritative placed structures (sentry turret,
 * proximity mine, resupply station, patrol drone). The client owns aiming
 * and FX; the server owns existence: a `deploy` claim registers the object,
 * the room broadcasts it, and the sim enforces per-player caps, TTL, and
 * teardown on death/leave/match-reset. Without this layer a cheater could
 * carpet the map — there was previously no server record at all.
 */
import type { Vec3 } from './types.ts';
import type { Room } from './Room.ts';
import type { ServerMessage } from '../../shared/protocol.ts';
import { logger } from './logger.ts';
import { weaponStats } from './weaponStats.ts';
import { aoeDamage } from '../../shared/combat.ts';
import { segSolidHit } from '../../shared/solidWorld.ts';

export type DeployKind = 'turret' | 'mine' | 'station' | 'drone';
const KINDS = new Set<DeployKind>(['turret', 'mine', 'station', 'drone']);
const MAX_PER_PLAYER: Record<DeployKind, number> = { turret: 2, mine: 6, station: 1, drone: 2 };
const TTL_S: Record<DeployKind, number> = { turret: 180, mine: 120, station: 240, drone: 90 };
// Plants near the action are legit; plants across the map are not.
const MAX_PLANT_DIST = 40;

interface Deployed {
  id: number;
  owner: string;
  kind: DeployKind;
  pos: Vec3;
  ttl: number;
  fireCd: number;
  hp: number;
}

// Blast-only durability — splash damage clears a stand's defenses the
// Tribes way (mortar/disc spam opens the approach). Hitscan has no
// deployable collision, so these are AOE-sweep budgets, not bullet HP.
const HP: Record<DeployKind, number> = { turret: 60, mine: 20, station: 80, drone: 40 };

// Sentry combat envelope — mirrors the client DeployTurret constants so
// the server sim and the visual agree on what the gun can reach.
const TURRET_RANGE = 42;
const TURRET_FIRE_INTERVAL = 1.25;
const TURRET_DAMAGE = 14;
const TURRET_UNFOLD_S = 0.45;
// Mirrors client config.ts MINE_* — proximity fuse + blast envelope.
const MINE_ARM_S = 1.0;
const MINE_TRIGGER_DIST = 3.2;
const MINE_BLAST_RADIUS = 6.0;
const MINE_DAMAGE = 22;
const MINE_KNOCKBACK = 12.0;
// Mirrors client DeployDrone: escort trades damage for following you.
const DRONE_RANGE = 35;
const DRONE_FIRE_INTERVAL = 1.6;
const DRONE_DAMAGE = 9;
const DRONE_HOVER_UP = 2.5;
// Mirrors client DeployStation: recharge envelope.
const STATION_RANGE = 9;
const STATION_HP_RATE = 0.09;   // fraction of maxHealth per second
const STATION_HEAL_CD = 0.5;    // heal tick cadence
const FORCE_SEND_MS = 900;      // health rides tickUpdate; force past suppression

export class RoomDeployables {
  private items = new Map<number, Deployed>();
  private nextId = 1;

  constructor(private room: Room) {}

  /** Client claims a plant. Validates kind, per-player cap, and that the
   *  drop point is near the planter — the deploy anim throws the pod a few
   *  meters, not across the map. */
  handleDeploy(playerId: string, kind: string, pos: Vec3): void {
    const player = this.room.players.getPlayer(playerId);
    if (!player || player.isDead || !KINDS.has(kind as DeployKind)) return;
    const k = kind as DeployKind;
    const dx = pos.x - player.position.x, dy = pos.y - player.position.y, dz = pos.z - player.position.z;
    if (dx * dx + dy * dy + dz * dz > MAX_PLANT_DIST * MAX_PLANT_DIST) return;
    const owned = [...this.items.values()].filter((d) => d.owner === playerId && d.kind === k);
    // At cap: recycle the oldest rather than refuse — Tribes remote-arms
    // behavior, keeps the feel without an unbounded pile.
    if (owned.length >= MAX_PER_PLAYER[k]) {
      owned.sort((a, b) => a.ttl - b.ttl);
      this.remove(owned[0]!.id);
    }
    const id = this.nextId++;
    const armDelay = k === 'turret' ? TURRET_UNFOLD_S + Math.random() * 0.4
      : k === 'mine' ? MINE_ARM_S
      : k === 'station' ? STATION_HEAL_CD : 0;
    this.items.set(id, { id, owner: playerId, kind: k, pos: { ...pos }, ttl: TTL_S[k], fireCd: armDelay, hp: HP[k] });
    logger.info('Deploy placed', { owner: playerId, kind: k, x: +pos.x.toFixed(1), y: +pos.y.toFixed(1), z: +pos.z.toFixed(1) });
    weaponStats.recordDeploy(this.room.mode, k);
    this.room.broadcast({ type: 'deploySpawn', id, owner: playerId, kind: k, pos: { ...pos }, team: player.team } as ServerMessage);
  }

  /** Owner death clears their field — no orphaned turrets farming kills
   *  for a corpse. Match reset and player leave use the same path. */
  clearOwner(ownerId: string): void {
    // Map iteration survives deletes — no snapshot needed.
    for (const d of this.items.values()) {
      if (d.owner === ownerId) this.remove(d.id);
    }
  }

  clearAll(): void {
    for (const id of this.items.keys()) this.remove(id);
  }

  snapshot(): { id: number; owner: string; kind: DeployKind; pos: Vec3 }[] {
    return [...this.items.values()].map((d) => ({ id: d.id, owner: d.owner, kind: d.kind, pos: { ...d.pos } }));
  }

  /** Creature-sim candidates — `dep:N` ids mirror the client species
   *  targeting table so wildlife raze stands on dedicated rooms too. */
  creatureTargets(): { id: string; pos: Vec3 }[] {
    const out: { id: string; pos: Vec3 }[] = [];
    for (const d of this.items.values()) out.push({ id: `dep:${d.id}`, pos: d.pos });
    return out;
  }

  posOf(depId: string): Vec3 | null {
    const d = this.items.get(+depId.slice(4));
    return d ? d.pos : null;
  }

  /** A creature's bite lands on a deployable — same durability pool the
   *  blast sweep drains, so gnawing and shelling clear gear alike. */
  gnaw(depId: string, dmg: number): void {
    const d = this.items.get(+depId.slice(4));
    if (!d) return;
    d.hp -= dmg;
    if (d.hp <= 0) {
      logger.info('Deploy destroyed', { id: d.id, kind: d.kind, owner: d.owner, by: 'creature' });
      this.remove(d.id);
    }
  }

  private remove(id: number): void {
    if (!this.items.delete(id)) return;
    this.room.broadcast({ type: 'deployGone', id } as ServerMessage);
  }

  /** AOE blast sweep — every deployable inside the radius eats scaled
   *  splash (same falloff curve as players). Own gear is not exempt:
   *  a careless mortar wrecks your own turret too. */
  applyBlast(center: Vec3, damage: number, radius: number, shooterId: string): void {
    if (this.items.size === 0) return;
    for (const d of this.items.values()) {
      const dx = d.pos.x - center.x, dy = d.pos.y - center.y, dz = d.pos.z - center.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > radius) continue;
      // Static gear can't dodge — a bolt landing inside the envelope does
      // at least half its base splash, so clearing a stand costs a few
      // well-placed lobs instead of a dozen grazed edges.
      const dmg = Math.max(aoeDamage(damage, dist, radius), Math.round(damage * 0.5));
      if (dmg <= 0) continue;
      d.hp -= dmg;
      logger.debug('Deploy hit', { kind: d.kind, dist: +dist.toFixed(1), dmg, hp: d.hp, by: shooterId });
      if (d.hp <= 0) {
        logger.info('Deploy destroyed', { id: d.id, kind: d.kind, owner: d.owner, by: shooterId });
        this.remove(d.id);
      }
    }
  }

  tick(dt: number): void {
    if (this.items.size === 0) return;
    for (const d of this.items.values()) {
      d.ttl -= dt;
      if (d.ttl <= 0) { this.remove(d.id); continue; }
      if (d.kind === 'turret') this.tickTurret(d, dt);
      else if (d.kind === 'mine') this.tickMine(d, dt);
      else if (d.kind === 'station') this.tickStation(d, dt);
      else if (d.kind === 'drone') this.tickDrone(d, dt);
    }
  }

  /** Escort drone: shadow follows the owner's hover anchor, and the same
   *  nearest-hostile scan as the sentry plinks whoever's in range. */
  private tickDrone(d: Deployed, dt: number): void {
    const owner = this.room.players.getPlayer(d.owner);
    if (!owner || owner.isDead) { this.remove(d.id); return; }
    d.pos.x = owner.position.x;
    d.pos.y = owner.position.y + DRONE_HOVER_UP;
    d.pos.z = owner.position.z;
    d.fireCd -= dt;
    if (d.fireCd > 0) return;
    let target: string | null = null;
    let bestD2 = DRONE_RANGE * DRONE_RANGE;
    for (const [pid, p] of this.room.players.getAllPlayers()) {
      if (p.isDead || pid === d.owner) continue;
      if (owner.team && p.team === owner.team) continue;
      if (p.protectedUntil > Date.now()) continue;
      const dx = p.position.x - d.pos.x, dy = p.position.y - d.pos.y, dz = p.position.z - d.pos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= bestD2) continue;
      if (!this.losClear(d.pos, p.position)) continue;
      bestD2 = d2; target = pid;
    }
    if (!target) { d.fireCd = 0.15; return; }
    d.fireCd = DRONE_FIRE_INTERVAL;
    this.room.broadcast({ type: 'turretShot', id: d.id, owner: d.owner, targetId: target } as ServerMessage);
    this.room.messages.turretAttack(d.owner, target, DRONE_DAMAGE);
  }

  /** Proximity mine: after the arm delay, a hostile stepping inside the
   *  fuse radius detonates it — blast applies through the shared AOE
   *  funnel (falloff + knockback + friendly gate), clients paint the boom
   *  off the mineBoom broadcast. */
  private tickMine(d: Deployed, _dt: number): void {
    d.fireCd -= _dt; // doubles as the arm timer
    if (d.fireCd > 0) return;
    const owner = this.room.players.getPlayer(d.owner);
    for (const [pid, p] of this.room.players.getAllPlayers()) {
      if (p.isDead || pid === d.owner) continue;
      if (owner?.team && p.team === owner.team) continue;
      const dx = p.position.x - d.pos.x, dy = p.position.y - d.pos.y, dz = p.position.z - d.pos.z;
      if (dx * dx + dy * dy + dz * dz < MINE_TRIGGER_DIST * MINE_TRIGGER_DIST) {
        this.room.broadcast({ type: 'mineBoom', id: d.id, owner: d.owner, pos: { ...d.pos } } as ServerMessage);
        this.remove(d.id);
        this.room.messages.mineBlast(d.owner, d.pos, MINE_DAMAGE, MINE_BLAST_RADIUS, MINE_KNOCKBACK);
        return;
      }
    }
  }

  /** Resupply pad: friendlies in the envelope get a slow health refill.
   *  Energy stays client-side (the move shadow doesn't model the tank
   *  top-off) — health is the server-owned half of the pad's job. */
  private tickStation(d: Deployed, dt: number): void {
    d.fireCd -= dt;
    if (d.fireCd > 0) return;
    d.fireCd = STATION_HEAL_CD;
    const owner = this.room.players.getPlayer(d.owner);
    for (const [pid, p] of this.room.players.getAllPlayers()) {
      if (p.isDead) continue;
      if (owner?.team && p.team !== owner.team) continue;
      const dx = p.position.x - d.pos.x, dy = p.position.y - d.pos.y, dz = p.position.z - d.pos.z;
      if (dx * dx + dy * dy + dz * dz > STATION_RANGE * STATION_RANGE) continue;
      if (p.health >= p.maxHealth) continue;
      p.health = Math.min(p.maxHealth, p.health + p.maxHealth * STATION_HP_RATE * STATION_HEAL_CD);
      p.forceSendUntil = Date.now() + FORCE_SEND_MS;
      void pid;
    }
  }

  /** Structure LOS for the gun scan — a sentry indoors shouldn't plink
   *  players outside through the wall. Target at chest height. */
  private losClear(from: Vec3, to: Vec3): boolean {
    const cols = this.room.ballSim.colliders;
    if (!cols.length) return true;
    return !segSolidHit(
      { x: from.x, y: from.y + 0.5, z: from.z },
      { x: to.x, y: to.y + 1.0, z: to.z },
      cols, this.room.ballSim.colliderIndex ?? undefined,
    );
  }

  /** Server-side sentry fire: nearest hostile player in the envelope gets
   *  a bolt every TURRET_FIRE_INTERVAL. Damage rides the shared funnel so
   *  kill credit, spawn protection and respawn all behave — the client
   *  visual layer shows the matching rocket via the turretShot broadcast. */
  private tickTurret(d: Deployed, dt: number): void {
    d.fireCd -= dt;
    if (d.fireCd > 0) return;
    const owner = this.room.players.getPlayer(d.owner);
    let target: string | null = null;
    let bestD2 = TURRET_RANGE * TURRET_RANGE;
    for (const [pid, p] of this.room.players.getAllPlayers()) {
      if (p.isDead || pid === d.owner) continue;
      if (owner?.team && p.team === owner.team) continue;
      if (p.protectedUntil > Date.now()) continue;
      const dx = p.position.x - d.pos.x, dy = p.position.y - d.pos.y, dz = p.position.z - d.pos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= bestD2) continue;
      if (!this.losClear(d.pos, p.position)) continue;
      bestD2 = d2; target = pid;
    }
    if (!target) { d.fireCd = Math.min(d.fireCd + 0.15, 0.15); return; } // idle scan: cheap re-check
    d.fireCd = TURRET_FIRE_INTERVAL;
    this.room.broadcast({ type: 'turretShot', id: d.id, owner: d.owner, targetId: target } as ServerMessage);
    this.room.messages.turretAttack(d.owner, target, TURRET_DAMAGE);
  }
}
