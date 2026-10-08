/**
 * RoomDeployables — server-authoritative placed structures (sentry turret,
 * proximity mine, resupply station, patrol drone). The client owns aiming
 * and FX; the server owns existence: a `deploy` claim registers the object,
 * the room broadcasts it, and the sim enforces per-player caps, TTL, and
 * teardown on death/leave/match-reset. Without this layer a cheater could
 * carpet the map — there was previously no server record at all.
 */
import type { Vec3, ClaimVerdict, ServerMessage, PlayerState } from './types.ts';
import { WORLD_MODEL, spawnPayload, verbPayload, eventPayload, rosterRow } from '../../shared/worldModel.ts';
import type { Room } from './Room.ts';
import { logger } from './logger.ts';
import { weaponStats } from './weaponStats.ts';
import { aoeDamage } from '../../shared/combat.ts';
import { REPAIR_RANGE, REPAIR_HEAL_PER_TICK, REPAIR_MIN_TICK_S, REPAIR_ARMOR_MULT, WeaponType } from '../../shared/weapons.ts';
import { tickDrone, tickMine, tickSensor, tickSentry, tickStation, tickTurret, losClear } from './deployTicks.ts';

export type { DeployKind } from '../../shared/deployables.ts';
import { DEPLOY_KINDS, DEPLOY_MAX, DEPLOY_HP, type DeployKind } from '../../shared/deployables.ts';
import { DEPLOY_ITEMS, deploySolid } from '../../shared/deployItems.ts';
import type { StructureCollider } from '../../shared/ballCollide.ts';
import { segSolidHit } from '../../shared/solidWorld.ts';
import { hmHeight } from '../../shared/heightfield.ts';
import { simNow } from './simClock.ts';
import type { TeamId } from '../../shared/teams.ts';
const KINDS = new Set<DeployKind>(DEPLOY_KINDS);
const MAX_PER_PLAYER = DEPLOY_MAX;
// Thrown nugget mints a pickup that can't be grabbed for a beat — the
// gem needs to leave the thrower's grab radius before anyone banks it.
const NUGGET_ARM_S = 0.2;
// Plants near the action are legit; plants across the map are not.
const MAX_PLANT_DIST = 40;
// A claim's y is trusted within this band of the surface beneath it —
// the pod lands on ground or a structure top, never floating mid-air.
const PLANT_FLOAT = 3;

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
  /** Map-authored base asset — owner is the virtual `base:<team>` id,
   *  it never decays, and destruction puts it on RESPAWN_S rather than
   *  removing it. `team` is authoritative for targeting (no player row
   *  exists for the owner id). */
  base?: boolean;
  team?: TeamId;
  /** Seconds until a downed base asset re-arms. 0 while alive. */
  respawnT: number;
}

// A downed base asset comes back on its own after this — a repair tech
// can beat the clock by welding it back up early.
const RESPAWN_S = 120;

// Blast-only durability — splash damage clears a stand's defenses the
// Tribes way (mortar/disc spam opens the approach). Hitscan has no
// deployable collision, so these are AOE-sweep budgets, not bullet HP.
const HP = DEPLOY_HP;

// Barrier dome — a sphere centered on the emitter (the half-buried read
// conforms to any slope). Hostile shells detonate on entry; friendly
// fire passes. The emitter itself eats blast damage like any stand —
// shelling the dome is the intended counterplay.
// Combat envelopes derive from DEPLOY_ITEMS — one fact table for both
// ends; the old per-side copies drifted (mine life 45 vs ttl 120 meant
// clients hid a mine the server still exploded for 75s).
export const SHIELD_RADIUS = DEPLOY_ITEMS.shield.shieldRadius!;
export const TURRET_RANGE = DEPLOY_ITEMS.turret.range!;
export const TURRET_FIRE_INTERVAL = DEPLOY_ITEMS.turret.fireInterval!;
export const TURRET_DAMAGE = DEPLOY_ITEMS.turret.damage!;
export const TURRET_UNFOLD_S = DEPLOY_ITEMS.turret.armS!;
export const MINE_ARM_S = DEPLOY_ITEMS.mine.armS!;
export const MINE_TRIGGER_DIST = DEPLOY_ITEMS.mine.triggerDist!;
export const MINE_BLAST_RADIUS = DEPLOY_ITEMS.mine.blastRadius!;
export const MINE_DAMAGE = DEPLOY_ITEMS.mine.blastDamage!;
export const MINE_KNOCKBACK = DEPLOY_ITEMS.mine.knockback!;
export const DRONE_RANGE = DEPLOY_ITEMS.drone.range!;
export const DRONE_FIRE_INTERVAL = DEPLOY_ITEMS.drone.fireInterval!;
export const DRONE_DAMAGE = DEPLOY_ITEMS.drone.damage!;
export const DRONE_HOVER_UP = DEPLOY_ITEMS.drone.hoverUp!;
export const STATION_RANGE = DEPLOY_ITEMS.station.range!;
export const STATION_HP_RATE = DEPLOY_ITEMS.station.healRate!;
export const STATION_HEAL_CD = DEPLOY_ITEMS.station.fireInterval!;

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
  /** Live solid hulls for moveSim — the Room hands this array to the
   *  SolidWorld ONCE; every add/remove rewrites it in place so bodies
   *  can't walk through gear that appeared mid-match. Drones and
   *  nuggets are unsolid (mobile / never an item). */
  readonly solidCols: StructureCollider[] = [];

  constructor(public room: Room) {}

  private refreshSolids(): void {
    this.solidCols.length = 0;
    for (const d of this.items.values()) {
      if (!deploySolid(d.kind)) continue;
      const def = DEPLOY_ITEMS[d.kind];
      this.solidCols.push({
        cx: d.pos.x, cy: d.pos.y + def.bodyH / 2, cz: d.pos.z,
        hx: def.bodyR, hy: def.bodyH / 2, hz: def.bodyR, cos: 1, sin: 0,
      });
    }
  }

  /** Client claims a plant. Validates kind, per-player cap, and that the
   *  drop point is near the planter — the deploy anim throws the pod a few
   *  meters, not across the map. */
  handleDeploy(playerId: string, kind: string, pos: Vec3): ClaimVerdict {
    const player = this.room.players.getPlayer(playerId);
    if (!player || player.isDead) return 'gone';
    if (!KINDS.has(kind as DeployKind)) return 'badkind';
    const k = kind as DeployKind;
    // cap-0 kinds are map-authored only — a client can't plant a generator.
    if (DEPLOY_ITEMS[k].cap === 0) return 'badkind';
    // Pack gear costs belt charges — the same nugget pool the throws drink
    // from, so a builder pays real economy for every stand it fortifies.
    if (player.beltCharges < DEPLOY_ITEMS[k].cost) {
      logger.debug('Deploy blocked: dry belt', { owner: playerId, kind: k });
      return 'drybelt';
    }
    const dx = pos.x - player.position.x, dy = pos.y - player.position.y, dz = pos.z - player.position.z;
    if (dx * dx + dy * dy + dz * dz > MAX_PLANT_DIST * MAX_PLANT_DIST) return 'toofar';
    pos = { ...pos, y: this.groundY(pos) };
    player.beltCharges -= DEPLOY_ITEMS[k].cost;
    // Nugget: no planted item — the claim mints a grabbable gem where the
    // pod lands. Net sink of one charge (costs 2, pays 1 back), and the
    // grab is first-come — a fast enemy can steal the thrower's change.
    if (k === 'nugget') {
      this.room.pickups?.spawn({ ...pos }, 'gem', NUGGET_ARM_S);
      return true;
    }
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
    this.items.set(id, { id, owner: playerId, kind: k, pos: { ...pos }, ttl: DEPLOY_ITEMS[k].ttlS, fireCd: armDelay, hp: HP[k], armor: 0, respawnT: 0 });
    this.refreshSolids();
    logger.info('Deploy placed', { owner: playerId, kind: k, x: +pos.x.toFixed(1), y: +pos.y.toFixed(1), z: +pos.z.toFixed(1) });
    weaponStats.recordDeploy(this.room.mode, k);
    this.room.broadcast(spawnPayload(WORLD_MODEL.deploy!, id, 'id', { owner: playerId, kind: k, pos: { ...pos }, team: player.team }) as ServerMessage);
    return true;
  }

  /** The surface a planted item should rest on: highest structure top
   *  under the claimed point, else terrain. A claim floating more than
   *  PLANT_FLOAT above it is pulled down — "server decides" applies to
   *  the landing spot too, and the replica echoes this y verbatim. */
  private groundY(pos: Vec3): number {
    let floor = this.room.field ? hmHeight(this.room.field, pos.x, pos.z) : pos.y;
    const hit = segSolidHit(
      { x: pos.x, y: pos.y + 0.5, z: pos.z },
      { x: pos.x, y: floor - 1, z: pos.z },
      this.room.ballSim.colliders,
    );
    const support = hit ? hit.y : floor;
    if (pos.y > support + PLANT_FLOAT) return support;
    if (pos.y < support - PLANT_FLOAT) return support; // buried claim — lift to the surface
    return pos.y;
  }

  /** Map-authored base assets — the mission's generator, base turrets,
   *  sensor mast. Owner is a virtual `base:<team>` id so nothing in the
   *  player lifecycle can orphan them; the respawn clock replaces ttl.
   *  Idempotent per room open — call once after construction. */
  seedBase(entries: readonly { kind: string; pos: Vec3; team?: TeamId }[]): void {
    for (const e of entries) {
      const k = e.kind as DeployKind;
      if (!KINDS.has(k)) continue;
      const id = this.nextId++;
      const owner = e.team ? `base:${e.team}` : 'base';
      this.items.set(id, { id, owner, kind: k, pos: { ...e.pos }, ttl: Infinity, fireCd: 0, hp: HP[k], armor: 0, base: true, team: e.team, respawnT: 0 });
      this.room.broadcast(spawnPayload(WORLD_MODEL.deploy!, id, 'id', { owner, kind: k, pos: { ...e.pos }, team: e.team }) as ServerMessage);
      logger.info('Base asset seeded', { id, kind: k, team: e.team, x: +e.pos.x.toFixed(1), z: +e.pos.z.toFixed(1) });
    }
    this.refreshSolids();
  }

  /** Owner death clears their field — no orphaned turrets farming kills
   *  for a corpse. Match reset and player leave use the same path. */
  clearOwner(ownerId: string): void {
    // Map iteration survives deletes — no snapshot needed.
    for (const d of this.items.values()) {
      if (d.owner === ownerId) this.remove(d.id);
    }
    // The owner's cooldown keys are their trace too: items outlive them
    // (base gear is immortal), so a departed welder's entries would sit
    // in lastRepair for the room's life.
    for (const k of this.lastRepair.keys()) {
      if (k.startsWith(`${ownerId}:`)) this.lastRepair.delete(k);
    }
  }

  /** The item's effective team — authored assets carry their own, field
   *  plants inherit the owner's current side. */
  teamOf(d: Deployed): TeamId | undefined {
    return d.team ?? this.room.players.getPlayer(d.owner)?.team;
  }

  /** Generator economy: while a team's generator is down, its OTHER base
   *  assets go dormant — turrets stop scanning, pads stop healing. Field
   *  plants and generator-less teams are always powered. */
  powered(d: Deployed): boolean {
    if (!d.base || !d.team || d.kind === 'generator') return true;
    for (const g of this.items.values()) {
      if (g.base && g.kind === 'generator' && g.team === d.team) return g.hp > 0;
    }
    return true;
  }

  /** Is a team's base grid live? Structure shields gate on this — a dead
   *  generator drops the gate field, a team with no generator is always
   *  powered. */
  teamPowered(team: TeamId): boolean {
    for (const g of this.items.values()) {
      if (g.base && g.kind === 'generator' && g.team === team) return g.hp > 0;
    }
    return true;
  }

  clearAll(): void {
    // Field plants die with the round; base assets survive a match reset
    // and come back repaired — the compound outlives the scoreboard.
    for (const id of this.items.keys()) {
      const d = this.items.get(id)!;
      if (!d.base) this.remove(id);
      else if (d.hp <= 0) this.revive(d);
    }
  }

  snapshot(): { id: number; owner: string; kind: DeployKind; pos: Vec3; hp: number; armor: number; team?: TeamId }[] {
    return [...this.items.values()].map((d) => rosterRow(WORLD_MODEL.deploy!, 'id', d.id, { owner: d.owner, kind: d.kind, pos: { ...d.pos }, hp: d.hp, armor: d.armor, team: this.teamOf(d) }) as { id: number; owner: string; kind: DeployKind; pos: Vec3; hp: number; armor: number; team?: TeamId });
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
      if (!this.powered(d)) continue; // generator down — dome is off
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
    if (d.hp <= 0) return; // downed base hulk — hits are noise, not damage
    d.hp -= dmg;
    this.sendHp(d);
    if (d.hp <= 0) {
      if (d.base) {
        d.respawnT = RESPAWN_S;
        this.room.broadcast(eventPayload(WORLD_MODEL.deploy!, 'deployDown', 'id', d.id, { kind: d.kind, team: d.team, respawnS: RESPAWN_S }) as ServerMessage);
        logger.info('Base asset down', { id: d.id, kind: d.kind, team: d.team, by });
        if (d.kind === 'generator') this.room.refreshPowerStructures(); // grid drops — gate fields go dark
      } else {
        logger.info('Deploy destroyed', { id: d.id, kind: d.kind, owner: d.owner, by });
        this.remove(d.id);
      }
    }
  }

  /** A downed base asset stands back up — timer expiry or a repair tech
   *  beating the clock. Fresh hp, no armor (armor is welded on after). */
  private revive(d: Deployed): void {
    d.hp = HP[d.kind];
    d.armor = 0;
    d.respawnT = 0;
    this.room.broadcast(eventPayload(WORLD_MODEL.deploy!, 'deployUp', 'id', d.id, {}) as ServerMessage);
    this.sendHp(d);
    logger.info('Base asset restored', { id: d.id, kind: d.kind, team: d.team });
    if (d.kind === 'generator') this.room.refreshPowerStructures();
  }

  private sendHp(d: Deployed, src?: string): void {
    // src is the welder's id on a heal tick — other clients draw their
    // repair beam off it; damage ticks carry no src.
    this.room.broadcast(verbPayload(WORLD_MODEL.deploy!, 'update', 'id', d.id, { hp: Math.max(0, Math.round(d.hp)), armor: Math.round(d.armor), src }) as ServerMessage);
  }

  // Repair claims are rate-limited per shooter+target — a client can pace
  // its beam ticks but can't bank a year's worth in a burst.
  private lastRepair = new Map<string, number>();

  /** Friendly only: own gear always; teammates' gear when teams exist.
   *  Base assets belong to the team, not a body — same-side weld only. */
  private weldable(p: PlayerState, d: Deployed, playerId: string): boolean {
    if (d.base) return !d.team || p.team === d.team;
    if (p.team && d.owner !== playerId) {
      return this.room.players.getPlayer(d.owner)?.team === p.team;
    }
    return p.team !== undefined || d.owner === playerId;
  }

  /** Beam-intent target: the weldable deployable the ray actually
   *  touches — same padded-sphere pick as the client's repairHit
   *  (r=1.1, body-center +0.7), nearest entry wins. Lets the
   *  shotFired intent replace the per-tick repair claim: the server
   *  names the target too. */
  repairTarget(playerId: string, muzzle: Vec3, dir: Vec3, range: number): number | null {
    const p = this.room.players.getPlayer(playerId);
    if (!p || p.isDead) return null;
    let best: number | null = null;
    let bestT = range;
    for (const d of this.items.values()) {
      const cx = d.pos.x - muzzle.x, cy = d.pos.y + 0.7 - muzzle.y, cz = d.pos.z - muzzle.z;
      const proj = cx * dir.x + cy * dir.y + cz * dir.z;
      if (proj < 0 || proj > bestT) continue;
      const perp2 = (cx * cx + cy * cy + cz * cz) - proj * proj;
      if (perp2 >= 1.1 * 1.1) continue;
      if (!this.weldable(p, d, playerId)) continue;
      const entry = proj - Math.sqrt(1.1 * 1.1 - perp2);
      if (entry < bestT) { bestT = Math.max(entry, 0); best = d.id; }
    }
    return best;
  }

  /** Repair-tool beam tick on a friendly deployable: heal to base, then
   *  overcharge armor to REPAIR_ARMOR_MULT×. Server re-derives distance,
   *  LOS, team and the heal amount — the claim names a target, nothing
   *  else. */
  repair(playerId: string, targetId: number): ClaimVerdict {
    const d = this.items.get(targetId);
    const p = this.room.players.getPlayer(playerId);
    if (!d || !p || p.isDead) return 'gone';
    if (!this.weldable(p, d, playerId)) return 'enemy';
    const dx = d.pos.x - p.position.x, dy = d.pos.y - p.position.y, dz = d.pos.z - p.position.z;
    if (dx * dx + dy * dy + dz * dz > REPAIR_RANGE * REPAIR_RANGE * 2.25) return 'range'; // 1.5× slack
    if (!losClear(this, p.position, d.pos, p.team)) return 'los';
    const key = `${playerId}:${targetId}`;
    const now = simNow() / 1000;
    if (now - (this.lastRepair.get(key) ?? -1) < REPAIR_MIN_TICK_S) return 'cooldown';
    this.lastRepair.set(key, now);
    const hpCap = HP[d.kind];
    // A hulk welds back from zero — blast overkill digs hp far negative,
    // and making a tech excavate it would gate revival on the kill shot's
    // size instead of the weld time.
    if (d.base && d.hp < 0) d.hp = 0;
    const healed = Math.min(REPAIR_HEAL_PER_TICK, hpCap - d.hp);
    d.hp += healed;
    d.armor = Math.min(REPAIR_ARMOR_MULT * hpCap, d.armor + (REPAIR_HEAL_PER_TICK - healed));
    if (d.base && d.hp > 0 && d.respawnT > 0) this.revive(d); // welded back early
    else this.sendHp(d, playerId);
    return true;
  }

  remove(id: number): void {
    if (!this.items.delete(id)) return;
    // Dead ids must drop their rate-limit keys — otherwise every planted
    // and destroyed item leaves a permanent entry in lastRepair.
    for (const k of this.lastRepair.keys()) {
      if (k.endsWith(`:${id}`)) this.lastRepair.delete(k);
    }
    this.room.broadcast(verbPayload(WORLD_MODEL.deploy!, 'gone', 'id', id, {}) as ServerMessage);
    this.refreshSolids();
  }

  /** AOE blast sweep — every deployable inside the radius eats scaled
   *  splash (same falloff curve as players). Own gear is not exempt:
   *  a careless mortar wrecks your own turret too. */
  applyBlast(center: Vec3, damage: number, radius: number, shooterId: string, scales?: readonly number[], weapon?: number, splash?: number): void {
    if (this.items.size === 0) return;
    // Sticky launcher is the breaching tool — 2x to structures/base
    // assets gives the otherwise-purposeless gun a siege job.
    const mult = weapon === WeaponType.Sticky ? 2 : 1;
    const aoe = splash ?? damage;
    for (const d of this.items.values()) {
      const dx = d.pos.x - center.x, dy = d.pos.y - center.y, dz = d.pos.z - center.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > radius) continue;
      // Contact hit — the blast center landed inside the item's body
      // radius (a sticky glued ON the turret): pays the direct line, no
      // falloff. Outside it, splash does its normal aoe scale.
      const direct = dist <= DEPLOY_ITEMS[d.kind].bodyR;
      // Static gear can't dodge — a bolt landing inside the envelope does
      // at least half its base splash, so clearing a stand costs a few
      // well-placed lobs instead of a dozen grazed edges.
      const dmg = (direct ? damage : Math.max(aoeDamage(aoe, dist, radius, scales), Math.round(aoe * 0.5))) * mult;
      if (dmg <= 0) continue;
      logger.debug('Deploy hit', { kind: d.kind, dist: +dist.toFixed(1), dmg, hp: d.hp, by: shooterId });
      this.hurt(d, dmg, shooterId);
    }
  }

  tick(dt: number): void {
    if (this.items.size === 0) return;
    for (const d of this.items.values()) {
      if (d.base) {
        if (d.respawnT > 0) {
          d.respawnT -= dt;
          if (d.respawnT <= 0) this.revive(d);
          continue;
        }
        if (d.hp <= 0) continue;
      } else {
        d.ttl -= dt;
        if (d.ttl <= 0) { this.remove(d.id); continue; }
      }
      if (!this.powered(d)) continue; // generator down — base goes dark
      if (d.kind === 'turret') tickTurret(this, d, dt);
      else if (d.kind === 'mine') tickMine(this, d, dt);
      else if (d.kind === 'station') tickStation(this, d, dt);
      else if (d.kind === 'drone') tickDrone(this, d, dt);
      else if (d.kind === 'sensor') tickSensor(this, d, dt);
      else if (d.kind === 'baseturret') tickSentry(this, d, dt);
    }
    // Sentry bolts in flight — the blast lands where the bolt does, so a
    // sidestepping capper genuinely outruns it (non-homing by design).
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i]!;
      b.ttl -= dt;
      if (b.ttl > 0) continue;
      this.bolts.splice(i, 1);
      this.room.messages.mineBlast(b.owner, b.at, b.dmg, b.rad, b.kb);
    }
  }

  /** Scheduled sentry-bolt impacts — see tickSentry. */
  readonly bolts: { at: Vec3; ttl: number; owner: string; dmg: number; rad: number; kb: number }[] = [];

}
