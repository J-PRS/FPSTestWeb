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
import { logger } from './logger.ts';
import { weaponStats } from './weaponStats.ts';
import { aoeDamage } from '../../shared/combat.ts';
import { REPAIR_RANGE, REPAIR_HEAL_PER_TICK, REPAIR_MIN_TICK_S, REPAIR_ARMOR_MULT } from '../../shared/weapons.ts';
import { tickDrone, tickMine, tickStation, tickTurret, losClear } from './deployTicks.ts';

export type { DeployKind } from '../../shared/deployables.ts';
import { DEPLOY_KINDS, DEPLOY_MAX, DEPLOY_HP, type DeployKind } from '../../shared/deployables.ts';
import { simNow } from './simClock.ts';
const KINDS = new Set<DeployKind>(DEPLOY_KINDS);
const MAX_PER_PLAYER = DEPLOY_MAX;
const TTL_S: Record<DeployKind, number> = { turret: 180, mine: 120, station: 240, drone: 90, shield: 120 };
// Plants near the action are legit; plants across the map are not.
const MAX_PLANT_DIST = 40;

export interface Deployed {
  id: number;
  owner: string;
  kind: DeployKind;
  pos: Vec3;
  ttl: number;
  fireCd: number;
  hp: number;
  /** Overcharge layer from repair beams — soaks damage before hp, caps
   *  at REPAIR_ARMOR_MULT × base hp. The technician's payoff. */
  armor: number;
}

// Blast-only durability — splash damage clears a stand's defenses the
// Tribes way (mortar/disc spam opens the approach). Hitscan has no
// deployable collision, so these are AOE-sweep budgets, not bullet HP.
const HP = DEPLOY_HP;

// Barrier dome — a sphere centered on the emitter (the half-buried read
// conforms to any slope). Hostile shells detonate on entry; friendly
// fire passes. The emitter itself eats blast damage like any stand —
// shelling the dome is the intended counterplay.
export const SHIELD_RADIUS = 6;

// Sentry combat envelope — mirrors the client DeployTurret constants so
// the server sim and the visual agree on what the gun can reach.
export const TURRET_RANGE = 42;
export const TURRET_FIRE_INTERVAL = 1.25;
export const TURRET_DAMAGE = 14;
export const TURRET_UNFOLD_S = 0.45;
// Mirrors client config.ts MINE_* — proximity fuse + blast envelope.
export const MINE_ARM_S = 1.0;
export const MINE_TRIGGER_DIST = 3.2;
export const MINE_BLAST_RADIUS = 6.0;
export const MINE_DAMAGE = 22;
export const MINE_KNOCKBACK = 12.0;
// Mirrors client DeployDrone: escort trades damage for following you.
export const DRONE_RANGE = 35;
export const DRONE_FIRE_INTERVAL = 1.6;
export const DRONE_DAMAGE = 9;
export const DRONE_HOVER_UP = 2.5;
// Mirrors client DeployStation: recharge envelope.
export const STATION_RANGE = 9;
export const STATION_HP_RATE = 0.09;   // fraction of maxHealth per second
export const STATION_HEAL_CD = 0.5;    // heal tick cadence

/** First t∈[0,1] where the segment enters the sphere — quadratic solve,
 *  null on a miss. A segment already inside returns 0 (blocked at once). */
function segSphereEnter(from: Vec3, to: Vec3, c: Vec3, r: number): number | null {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const mx = from.x - c.x, my = from.y - c.y, mz = from.z - c.z;
  const a = dx * dx + dy * dy + dz * dz;
  if (a < 1e-9) return null;
  const cc = mx * mx + my * my + mz * mz - r * r;
  if (cc <= 0) return 0; // started inside
  const b = 2 * (mx * dx + my * dy + mz * dz);
  const disc = b * b - 4 * a * cc;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t <= 1 ? t : null;
}

export class RoomDeployables {
  items = new Map<number, Deployed>();
  private nextId = 1;

  constructor(public room: Room) {}

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
    const armDelay = k === 'turret' ? TURRET_UNFOLD_S + this.room.rng() * 0.4
      : k === 'mine' ? MINE_ARM_S
      : k === 'station' ? STATION_HEAL_CD : 0;
    this.items.set(id, { id, owner: playerId, kind: k, pos: { ...pos }, ttl: TTL_S[k], fireCd: armDelay, hp: HP[k], armor: 0 });
    logger.info('Deploy placed', { owner: playerId, kind: k, x: +pos.x.toFixed(1), y: +pos.y.toFixed(1), z: +pos.z.toFixed(1) });
    weaponStats.recordDeploy(this.room.mode, k);
    this.room.broadcast({ type: 'deploySpawn', id, owner: playerId, kind: k, pos: { ...pos }, team: player.team });
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

  snapshot(): { id: number; owner: string; kind: DeployKind; pos: Vec3; hp: number; armor: number; team?: string }[] {
    return [...this.items.values()].map((d) => ({ id: d.id, owner: d.owner, kind: d.kind, pos: { ...d.pos }, hp: d.hp, armor: d.armor, team: this.room.players.getPlayer(d.owner)?.team }));
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

  /** Shield sweep: does this shell's frame segment enter an ENEMY dome?
   *  Returns the earliest entry t∈[0,1], or null — the caller detonates
   *  the shell at that point. Friendly fire sails through: the owner and
   *  teammates (when a team is known) are exempt. */
  shieldBlock(from: Vec3, to: Vec3, shooterId: string): number | null {
    let bestT = Infinity;
    const shooterTeam = this.room.players.getPlayer(shooterId)?.team;
    for (const d of this.items.values()) {
      if (d.kind !== 'shield' || d.owner === shooterId) continue;
      const domeTeam = this.room.players.getPlayer(d.owner)?.team;
      if (domeTeam !== undefined && shooterTeam !== undefined && domeTeam === shooterTeam) continue;
      const t = segSphereEnter(from, to, d.pos, SHIELD_RADIUS);
      if (t !== null && t < bestT) bestT = t;
    }
    return bestT === Infinity ? null : bestT;
  }

  /** A creature's bite lands on a deployable — same durability pool the
   *  blast sweep drains, so gnawing and shelling clear gear alike. */
  gnaw(depId: string, dmg: number): void {
    const d = this.items.get(+depId.slice(4));
    if (!d) return;
    this.hurt(d, dmg, 'creature');
  }

  /** Armor soaks before hp; any change rides out as deployHp so clients
   *  can paint the overcharge. */
  private hurt(d: Deployed, dmg: number, by: string): void {
    if (d.armor > 0) {
      const soaked = Math.min(d.armor, dmg);
      d.armor -= soaked;
      dmg -= soaked;
    }
    d.hp -= dmg;
    this.sendHp(d);
    if (d.hp <= 0) {
      logger.info('Deploy destroyed', { id: d.id, kind: d.kind, owner: d.owner, by });
      this.remove(d.id);
    }
  }

  private sendHp(d: Deployed, src?: string): void {
    // src is the welder's id on a heal tick — other clients draw their
    // repair beam off it; damage ticks carry no src.
    this.room.broadcast({ type: 'deployHp', id: d.id, hp: Math.max(0, Math.round(d.hp)), armor: Math.round(d.armor), ...(src ? { src } : {}) });
  }

  // Repair claims are rate-limited per shooter+target — a client can pace
  // its beam ticks but can't bank a year's worth in a burst.
  private lastRepair = new Map<string, number>();

  /** Repair-tool beam tick on a friendly deployable: heal to base, then
   *  overcharge armor to REPAIR_ARMOR_MULT×. Server re-derives distance,
   *  LOS, team and the heal amount — the claim names a target, nothing
   *  else. */
  repair(playerId: string, targetId: number): void {
    const d = this.items.get(targetId);
    const p = this.room.players.getPlayer(playerId);
    if (!d || !p || p.isDead) return;
    // Friendly only: own gear always; teammates' gear when teams exist.
    if (p.team && d.owner !== playerId) {
      const owner = this.room.players.getPlayer(d.owner);
      if (owner?.team !== p.team) return;
    } else if (!p.team && d.owner !== playerId) return;
    const dx = d.pos.x - p.position.x, dy = d.pos.y - p.position.y, dz = d.pos.z - p.position.z;
    if (dx * dx + dy * dy + dz * dz > REPAIR_RANGE * REPAIR_RANGE * 2.25) return; // 1.5× slack
    if (!losClear(this, p.position, d.pos)) return;
    const key = `${playerId}:${targetId}`;
    const now = simNow() / 1000;
    if (now - (this.lastRepair.get(key) ?? -1) < REPAIR_MIN_TICK_S) return;
    this.lastRepair.set(key, now);
    const hpCap = HP[d.kind];
    const healed = Math.min(REPAIR_HEAL_PER_TICK, hpCap - d.hp);
    d.hp += healed;
    d.armor = Math.min(REPAIR_ARMOR_MULT * hpCap, d.armor + (REPAIR_HEAL_PER_TICK - healed));
    this.sendHp(d, playerId);
  }

  remove(id: number): void {
    if (!this.items.delete(id)) return;
    this.room.broadcast({ type: 'deployGone', id });
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
      logger.debug('Deploy hit', { kind: d.kind, dist: +dist.toFixed(1), dmg, hp: d.hp, by: shooterId });
      this.hurt(d, dmg, shooterId);
    }
  }

  tick(dt: number): void {
    if (this.items.size === 0) return;
    for (const d of this.items.values()) {
      d.ttl -= dt;
      if (d.ttl <= 0) { this.remove(d.id); continue; }
      if (d.kind === 'turret') tickTurret(this, d, dt);
      else if (d.kind === 'mine') tickMine(this, d, dt);
      else if (d.kind === 'station') tickStation(this, d, dt);
      else if (d.kind === 'drone') tickDrone(this, d, dt);
    }
  }

}
