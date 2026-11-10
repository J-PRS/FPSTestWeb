/**
 * RoomDeployables - server-authoritative placed structures (sentry turret,
 * proximity mine, resupply station, patrol drone). The client owns aiming
 * and FX; the server owns existence: a `deploy` claim registers the object,
 * the room broadcasts it, and the sim enforces per-player caps, TTL, and
 * teardown on death/leave/match-reset. Without this layer a cheater could
 * carpet the map - there was previously no server record at all.
 */
import type { Vec3, ClaimVerdict, ServerMessage, PlayerState } from './types.ts';
import { WORLD_MODEL, spawnPayload, verbPayload, eventPayload, rosterRow } from '../../shared/worldModel.ts';
import type { Room } from './Room.ts';
import { logger } from './logger.ts';
import { weaponStats } from './weaponStats.ts';
import { aoeDamage } from '../../shared/combat.ts';
import { REPAIR_RANGE, REPAIR_HEAL_PER_TICK, REPAIR_MIN_TICK_S, REPAIR_ARMOR_MULT, WeaponType } from '../../shared/weapons.ts';
import { tickCg, tickDrone, tickJammer, tickLoiter, tickMine, tickMortar, tickMotion, tickPad, tickSensor, tickSentry, tickSpider, tickStation, tickTurret, tickWatersphere, losClear } from './deployTicks.ts';

import { DEPLOY_KINDS, DEPLOY_MAX, DEPLOY_HP, type DeployKind } from '../../shared/deployables.ts';
import { DEPLOY_ITEMS, deploySolid, type WaterDome } from '../../shared/deployItems.ts';
import type { StructureCollider } from '../../shared/ballCollide.ts';
import { segSolidHit } from '../../shared/solidWorld.ts';
import { hmHeight, hmChord } from '../../shared/heightfield.ts';
import { simNow } from './simClock.ts';
import type { TeamId } from '../../shared/teams.ts';
/** Per-kind tick registry - tick fn + `standsDown` flag (true = the
 *  kind freezes while players are invulnerable/intermission; support
 *  kinds keep healing/pinging). One row per tickable kind. */
const TICK_SPEC: Record<string, { tick: (room: RoomDeployables, d: Deployed, dt: number) => void; standsDown?: boolean }> = {
  turret:      { tick: (r, d, dt) => tickTurret(r, d, dt),      standsDown: true },
  mine:        { tick: (r, d, dt) => tickMine(r, d, dt),        standsDown: true },
  station:     { tick: (r, d, dt) => tickStation(r, d, dt) },
  drone:       { tick: (r, d, dt) => tickDrone(r, d, dt),       standsDown: true },
  sensor:      { tick: (r, d, dt) => tickSensor(r, d, dt) },
  baseturret:  { tick: (r, d, dt) => tickSentry(r, d, dt),      standsDown: true },
  mortar:      { tick: (r, d, dt) => tickMortar(r, d, dt),      standsDown: true },
  cgturret:    { tick: (r, d, dt) => tickCg(r, d, dt),          standsDown: true },
  watersphere: { tick: (r, d, dt) => tickWatersphere(r, d, dt) },
  pad:         { tick: (r, d, dt) => tickPad(r, d, dt) },
  loiter:      { tick: (r, d, dt) => tickLoiter(r, d, dt),      standsDown: true },
  spider:      { tick: (r, d, dt) => tickSpider(r, d, dt),      standsDown: true },
  jammer:      { tick: (r, d, dt) => tickJammer(r, d, dt) },
  motion:      { tick: (r, d, dt) => tickMotion(r, d, dt) },
};

export type { DeployKind } from '../../shared/deployables.ts';
const KINDS = new Set<DeployKind>(DEPLOY_KINDS);
const MAX_PER_PLAYER = DEPLOY_MAX;
// Thrown nugget mints a pickup that can't be grabbed for a beat - the
// gem needs to leave the thrower's grab radius before anyone banks it.
const NUGGET_ARM_S = 0.2;
// Plants near the action are legit; plants across the map are not.
const MAX_PLANT_DIST = 40;
// A claim's y is trusted within this band of the surface beneath it -
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
  /** Overcharge layer from repair beams - soaks damage before hp, caps
   *  at REPAIR_ARMOR_MULT × base hp. The technician's payoff. */
  armor: number;
  /** Map-authored base asset - owner is the virtual `base:<team>` id,
   *  it never decays, and destruction puts it on RESPAWN_S rather than
   *  removing it. `team` is authoritative for targeting (no player row
   *  exists for the owner id). */
  base?: boolean;
  team?: TeamId;
  /** Seconds until a downed base asset re-arms. 0 while alive. */
  respawnT: number;
  /** Jump pad's per-body re-trigger cooldown (pid → sim-ms last launch). */
  padHits?: Map<string, number>;
  /** Loiter munition mid-dive: the kamikaze point + launch velocity +
   *  elapsed fuse + the committed target. Present only while diving -
   *  the detonation removes the item either way. */
  loiterDive?: { x: number; y: number; z: number; vx: number; vy: number; vz: number; t: number; tid: string };
  /** Loiter orbit: angle + the plant anchor it circles (pos chases the
   *  ring so the wire replica orbits too). */
  orbitA?: number;
  orbitC?: { x: number; z: number };
}

// A downed base asset comes back on its own after this - a repair tech
// can beat the clock by welding it back up early.
const RESPAWN_S = 120;

// Blast-only durability - splash damage clears a stand's defenses the
// Tribes way (mortar/disc spam opens the approach). Hitscan has no
// deployable collision, so these are AOE-sweep budgets, not bullet HP.
const HP = DEPLOY_HP;

// Barrier dome - a sphere centered on the emitter (the half-buried read
// conforms to any slope). Hostile shells detonate on entry; friendly
// fire passes. The emitter itself eats blast damage like any stand -
// shelling the dome is the intended counterplay.
// Combat envelopes derive from DEPLOY_ITEMS - one fact table for both
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

/** First t∈[0,1] where the segment enters the sphere - quadratic solve,
 *  null on a miss. A segment already inside returns 0 (blocked at once). */
function segSphereEnter(from: Vec3, to: Vec3, c: Vec3, r: number): number | null {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const mx = from.x - c.x, my = from.y - c.y, mz = from.z - c.z;
  const a = dx * dx + dy * dy + dz * dz;
  if (a < 1e-9) {return null;}
  const cc = mx * mx + my * my + mz * mz - r * r;
  if (cc <= 0) {return 0;} // started inside
  const b = 2 * (mx * dx + my * dy + mz * dz);
  const disc = b * b - 4 * a * cc;
  if (disc < 0) {return null;}
  const t = (-b - (disc) ** 0.5) / (2 * a);
  return t >= 0 && t <= 1 ? t : null;
}

export class RoomDeployables {
  items = new Map<number, Deployed>();
  private nextId = 1;
  /** Live solid hulls for moveSim - the Room hands this array to the
   *  SolidWorld ONCE; every add/remove rewrites it in place so bodies
   *  can't walk through gear that appeared mid-match. Drones and
   *  nuggets are unsolid (mobile / never an item). */
  readonly solidCols: StructureCollider[] = [];

  constructor(public room: Room) {}

  private refreshSolids(): void {
    this.solidCols.length = 0;
    for (const d of this.items.values()) {
      if (!deploySolid(d.kind)) {continue;}
      const def = DEPLOY_ITEMS[d.kind];
      this.solidCols.push({
        cx: d.pos.x, cy: d.pos.y + def.bodyH / 2, cz: d.pos.z,
        hx: def.bodyR, hy: def.bodyH / 2, hz: def.bodyR, cos: 1, sin: 0,
      });
    }
  }

  /** Client claims a plant. Validates kind, per-player cap, and that the
   *  drop point is near the planter - the deploy anim throws the pod a few
   *  meters, not across the map. */
  handleDeploy(playerId: string, kind: string, pos: Vec3, vel?: Vec3): ClaimVerdict {
    const player = this.room.players.getPlayer(playerId);
    if (!player || player.isDead) {return 'gone';}
    if (!KINDS.has(kind as DeployKind)) {return 'badkind';}
    const k = kind as DeployKind;
    // cap-0 kinds are map-authored only - a client can't plant a generator.
    // world:'empty' rooms skip the deploy sim - a planted item would
    // broadcast a spawn then never tick/fire/decay: a dead prop lying to
    // every observer. Refuse the claim honestly instead.
    if (this.room.modeSpec?.world === 'empty') {return 'nomode';}
    if (DEPLOY_ITEMS[k].cap === 0) {return 'badkind';}
    if (!Number.isFinite(pos.x + pos.y + pos.z)) {return 'badpos';}
    // Pack gear costs belt charges - the same nugget pool the throws drink
    // from, so a builder pays real economy for every stand it fortifies.
    if (player.beltCharges < DEPLOY_ITEMS[k].cost) {
      logger.debug('Deploy blocked: dry belt', { owner: playerId, kind: k });
      return 'drybelt';
    }
    const dx = pos.x - player.position.x, dy = pos.y - player.position.y, dz = pos.z - player.position.z;
    if (dx * dx + dy * dy + dz * dz > MAX_PLANT_DIST * MAX_PLANT_DIST) {return 'toofar';}
    const p2 = Object.assign({}, pos, { y: this.groundY(pos)});
    player.beltCharges -= DEPLOY_ITEMS[k].cost;
    // Nugget: no planted item - the claim mints a grabbable gem where the
    // pod lands. Net sink of one charge (costs 2, pays 1 back), and the
    // grab is first-come - a fast enemy can steal the thrower's change.
    if (k === 'nugget') {
      // Thrown pod: the claim now carries the lob velocity at release -
      // the pickup sim owns the flight and settles to truth itself.
      // The old landing-claim path (no vel) still mints in place. The
      // lob is claim-supplied: clamp to a real throw (~17 lob + 0.6x
      // player speed, ~65 worst) so a forged vel can't arc a gem into
      // orbit - over-bound claims mint at rest rather than refuse, the
      // thrower spent the charges either way.
      const lob = vel && Math.hypot(vel.x, vel.y, vel.z) <= 80 ? vel : undefined;
      this.room.pickups?.spawn(lob ? Object.assign({}, pos) : Object.assign({}, p2), 'gem', NUGGET_ARM_S, 1, undefined, 0, lob);
      return true;
    }
    const owned = [...this.items.values()].filter((d): boolean => d.owner === playerId && d.kind === k);
    // At cap: recycle the oldest rather than refuse - Tribes remote-arms
    // behavior, keeps the feel without an unbounded pile.
    if (owned.length >= MAX_PER_PLAYER[k]) {
      owned.sort((a, b): number => a.ttl - b.ttl);
      this.remove(owned[0]!.id);
    }
    const id = ((this.nextId += 1) - 1);
    let armDelay = 0;
    if (k === 'turret') {armDelay = TURRET_UNFOLD_S + this.room.rng() * 0.4;}
    else if (k === 'mortar') {armDelay = DEPLOY_ITEMS.mortar.armS!;}
    else if (k === 'cgturret') {armDelay = DEPLOY_ITEMS.cgturret.armS!;}
    else if (k === 'mine') {armDelay = MINE_ARM_S;}
    else if (k === 'station') {armDelay = STATION_HEAL_CD;}
    else if (k === 'pad') {armDelay = DEPLOY_ITEMS.pad.armS!;}
    else if (k === 'loiter') {armDelay = DEPLOY_ITEMS.loiter.armS!;}
    else if (k === 'spider') {armDelay = DEPLOY_ITEMS.spider.armS!;}
    else if (k === 'jammer') {armDelay = DEPLOY_ITEMS.jammer.armS!;}
    else if (k === 'motion') {armDelay = DEPLOY_ITEMS.motion.armS!;}
    // Team stamps at plant time - the spawn edge carries this value, so
    // the hash lane must too (a live owner-team lookup desyncs the moment
    // the planter switches sides). Gear fights for its planting team.
    this.items.set(id, { id, owner: playerId, kind: k, pos: Object.assign({}, p2), ttl: DEPLOY_ITEMS[k].ttlS, fireCd: armDelay, hp: HP[k], armor: 0, respawnT: 0, team: player.team });
    this.refreshSolids();
    logger.info('Deploy placed', { owner: playerId, kind: k, x: Number(p2.x.toFixed(1)), y: Number(p2.y.toFixed(1)), z: Number(p2.z.toFixed(1)) });
    weaponStats.recordDeploy(this.room.mode, k);
    this.room.broadcast(spawnPayload(WORLD_MODEL.deploy!, id, 'id', { owner: playerId, kind: k, pos: Object.assign({}, p2), team: player.team }) as ServerMessage);
    return true;
  }

  /** The surface a planted item should rest on: highest structure top
   *  under the claimed point, else terrain. A claim floating more than
   *  PLANT_FLOAT above it is pulled down - "server decides" applies to
   *  the landing spot too, and the replica echoes this y verbatim. */
  private groundY(pos: Vec3): number {
    // Claimed point inside a solid: the downward ray starts inside the
    // collider and the item would plant invisibly inside a wall. Lift to
    // the containing collider's top - same "buried claim surfaces" rule.
    let insideTop = -Infinity;
    for (const c of [...this.room.ballSim.colliders, ...this.solidCols]) {
      const ox = pos.x - c.cx, oz = pos.z - c.cz;
      const lx = ox * c.cos + oz * c.sin;
      const lz = -ox * c.sin + oz * c.cos;
      if (Math.abs(lx) > c.hx || Math.abs(lz) > c.hz) {continue;}
      if (c.dome) {
        const cy0 = c.cy - c.hy;
        const dd = ox * ox + (pos.y - cy0) * (pos.y - cy0) + oz * oz;
        const inside = pos.y < cy0 ? Math.abs(pos.y - c.cy) <= c.hy : dd <= c.dome * c.dome;
        if (inside) {insideTop = Math.max(insideTop, cy0 + c.dome);}
      } else if (Math.abs(pos.y - c.cy) <= c.hy) {
        insideTop = Math.max(insideTop, c.cy + c.hy);
      }
    }
    if (insideTop > -Infinity) {return insideTop;}
    // Chord-augmented floor - the replica renders on the drawn mesh, so
    // "terrain" here must mean the surface the client draws, not the
    // smooth field under it (same law as nuggets/flags/bot shadows).
    const floor = this.room.field ? Math.max(hmHeight(this.room.field, pos.x, pos.z), hmChord(this.room.field, pos.x, pos.z)) : pos.y;
    const hit = segSolidHit(
      { x: pos.x, y: pos.y + 0.5, z: pos.z },
      { x: pos.x, y: floor - 1, z: pos.z },
      this.room.ballSim.colliders,
    );
    const support = hit ? hit.y : floor;
    if (pos.y > support + PLANT_FLOAT) {return support;}
    if (pos.y < support - PLANT_FLOAT) {return support;} // buried claim - lift to the surface
    return pos.y;
  }

  /** Map-authored base assets - the mission's generator, base turrets,
   *  sensor mast. Owner is a virtual `base:<team>` id so nothing in the
   *  player lifecycle can orphan them; the respawn clock replaces ttl.
   *  Idempotent per room open - call once after construction. */
  seedBase(entries: readonly { kind: string; pos: Vec3; team?: TeamId }[]): void {
    for (const e of entries) {
      const k = e.kind as DeployKind;
      if (!KINDS.has(k)) {continue;}
      const id = ((this.nextId += 1) - 1);
      const owner = e.team ? `base:${e.team}` : 'base';
      this.items.set(id, { id, owner, kind: k, pos: Object.assign({}, e.pos), ttl: Infinity, fireCd: 0, hp: HP[k], armor: 0, base: true, team: e.team, respawnT: 0 });
      this.room.broadcast(spawnPayload(WORLD_MODEL.deploy!, id, 'id', { owner, kind: k, pos: Object.assign({}, e.pos), team: e.team }) as ServerMessage);
      logger.info('Base asset seeded', { id, kind: k, team: e.team, x: Number(e.pos.x.toFixed(1)), z: Number(e.pos.z.toFixed(1)) });
    }
    this.refreshSolids();
  }

  /** Owner death clears their field - no orphaned turrets farming kills
   *  for a corpse. Match reset and player leave use the same path. */
  clearOwner(ownerId: string): void {
    // Map iteration survives deletes - no snapshot needed.
    for (const d of this.items.values()) {
      if (d.owner === ownerId) {this.remove(d.id);}
    }
    // The owner's cooldown keys are their trace too: items outlive them
    // (base gear is immortal), so a departed welder's entries would sit
    // in lastRepair for the room's life.
    for (const k of this.lastRepair.keys()) {
      if (k.startsWith(`${ownerId}:`)) {this.lastRepair.delete(k);}
    }
  }

  /** The item's effective team - authored assets carry their own, field
   *  plants inherit the owner's current side. */
  teamOf(d: Deployed): TeamId | undefined {
    return d.team ?? this.room.players.getPlayer(d.owner)?.team;
  }

  /** Inside a live friendly jammer bubble? Pulse detection (the base
   *  mast sweep) skips protected players; personal-LOS sightings and
   *  motion sensors are unaffected - jammers beat pulses, never
   *  eyeballs. Teamless bubbles protect their owner only. */
  jammed(t: { id: string; team?: string }, pos: Vec3): boolean {
    const jr = DEPLOY_ITEMS.jammer.range!;
    const jr2 = jr * jr;
    for (const d of this.items.values()) {
      if (d.kind !== 'jammer' || d.hp <= 0 || d.fireCd > 0) {continue;}
      const dx = pos.x - d.pos.x, dy = pos.y - d.pos.y, dz = pos.z - d.pos.z;
      if (dx * dx + dy * dy + dz * dz > jr2) {continue;}
      const jTeam = this.teamOf(d);
      if (jTeam === undefined ? d.owner === t.id : t.team === jTeam) {return true;}
    }
    return false;
  }

  /** Generator economy: while a team's generator is down, its OTHER base
   *  assets go dormant - turrets stop scanning, pads stop healing. Field
   *  plants and generator-less teams are always powered. */
  powered(d: Deployed): boolean {
    if (!d.base || !d.team || d.kind === 'generator') {return true;}
    for (const g of this.items.values()) {
      if (g.base && g.kind === 'generator' && g.team === d.team) {return g.hp > 0;}
    }
    return true;
  }

  /** Is a team's base grid live? Structure shields gate on this - a dead
   *  generator drops the gate field, a team with no generator is always
   *  powered. */
  teamPowered(team: TeamId): boolean {
    for (const g of this.items.values()) {
      if (g.base && g.kind === 'generator' && g.team === team) {return g.hp > 0;}
    }
    return true;
  }

  clearAll(): void {
    // Field plants die with the round; base assets survive a match reset
    // and come back repaired - the compound outlives the scoreboard.
    for (const id of this.items.keys()) {
      const d = this.items.get(id)!;
      if (!d.base) {this.remove(id);}
      else if (d.hp <= 0) {this.revive(d);}
    }
  }

  snapshot(): { id: number; owner: string; kind: DeployKind; pos: Vec3; hp: number; armor: number; team?: TeamId }[] {
    return [...this.items.values()].map((d) => rosterRow(WORLD_MODEL.deploy!, 'id', d.id, { owner: d.owner, kind: d.kind, pos: Object.assign({}, d.pos), hp: d.hp, armor: d.armor, team: this.teamOf(d) }) as { id: number; owner: string; kind: DeployKind; pos: Vec3; hp: number; armor: number; team?: TeamId });
  }

  /** Creature-sim candidates - `dep:N` ids mirror the client species
   *  targeting table so wildlife raze stands on dedicated rooms too. */
  creatureTargets(): { id: string; pos: Vec3 }[] {
    const out: { id: string; pos: Vec3 }[] = [];
    for (const d of this.items.values()) {out.push({ id: `dep:${d.id}`, pos: d.pos });}
    return out;
  }

  posOf(depId: string): Vec3 | null {
    const d = this.items.get(Number(depId.slice(4)));
    return d ? d.pos : null;
  }

  /** Live watersphere domes as projectile drag volumes - RoomProjectiles
   *  reads this once per tick; every shell wades them regardless of team. */
  waterDomes(): WaterDome[] {
    const out: WaterDome[] = [];
    const r = DEPLOY_ITEMS.watersphere.waterRadius ?? 0;
    if (r <= 0) {return out;}
    for (const d of this.items.values()) {
      if (d.kind === 'watersphere' && d.hp > 0) {out.push({ x: d.pos.x, y: d.pos.y, z: d.pos.z, r });}
    }
    return out;
  }

  /** Shield sweep: does this shell's frame segment enter an ENEMY dome?
   *  Returns the earliest entry t∈[0,1], or null - the caller detonates
   *  the shell at that point. Friendly fire sails through: the owner and
   *  teammates (when a team is known) are exempt. */
  shieldBlock(from: Vec3, to: Vec3, shooterId: string): number | null {
    let bestT = Infinity;
    const shooterTeam = this.room.players.getPlayer(shooterId)?.team;
    for (const d of this.items.values()) {
      if (d.kind !== 'shield' || d.owner === shooterId) {continue;}
      if (!this.powered(d)) {continue;} // generator down - dome is off
      const domeTeam = this.room.players.getPlayer(d.owner)?.team;
      if (domeTeam !== undefined && shooterTeam !== undefined && domeTeam === shooterTeam) {continue;}
      const t = segSphereEnter(from, to, d.pos, SHIELD_RADIUS);
      if (t !== null && t < bestT) {bestT = t;}
    }
    return bestT === Infinity ? null : bestT;
  }

  /** Is this point inside a powered ENEMY dome? Blasts use it as
   *  occlusion: a shell detonating at the shield's edge splashes into
   *  the dome without it - the victim inside must read immune. Same
   *  owner/team exemptions as shieldBlock. */
  shieldedPoint(pos: Vec3, shooterId: string, blastPos: Vec3): boolean {
    const shooterTeam = this.room.players.getPlayer(shooterId)?.team;
    const r2 = SHIELD_RADIUS * SHIELD_RADIUS;
    for (const d of this.items.values()) {
      if (d.kind !== 'shield' || d.owner === shooterId) {continue;}
      if (!this.powered(d)) {continue;}
      const domeTeam = this.room.players.getPlayer(d.owner)?.team;
      if (domeTeam !== undefined && shooterTeam !== undefined && domeTeam === shooterTeam) {continue;}
      const dx = pos.x - d.pos.x, dy = pos.y - d.pos.y, dz = pos.z - d.pos.z;
      if (dx * dx + dy * dy + dz * dz > r2) {continue;} // victim outside this dome
      // A blast already inside the dome still hurts its occupants -
      // only fire from OUTSIDE is walled off. The entry-point detonation
      // sits ON the boundary (dist == r), so "inside" needs real depth,
      // not a boundary epsilon - 0.5m in is a grenade thrown in, not a
      // shell popped at the wall.
      const bx = blastPos.x - d.pos.x, by = blastPos.y - d.pos.y, bz = blastPos.z - d.pos.z;
      if (bx * bx + by * by + bz * bz <= (SHIELD_RADIUS - 0.5) ** 2) {continue;}
      return true;
    }
    return false;
  }

  /** A creature's bite lands on a deployable - same durability pool the
   *  blast sweep drains, so gnawing and shelling clear gear alike. */
  gnaw(depId: string, dmg: number): void {
    const d = this.items.get(Number(depId.slice(4)));
    if (!d) {return;}
    this.hurt(d, dmg, 'creature');
  }

  /** Armor soaks before hp; any change rides out as deployHp so clients
   *  can paint the overcharge. */
  private hurt(d: Deployed, dmg: number, by: string): void {
    if (!Number.isFinite(dmg)) {return;} // NaN would silent-poison the replica
    let left = dmg;
    if (d.armor > 0) {
      const soaked = Math.min(d.armor, left);
      d.armor -= soaked;
      left -= soaked;
    }
    if (d.hp <= 0) {return;} // downed base hulk - hits are noise, not damage
    d.hp -= left;
    this.sendHp(d);
    if (d.hp <= 0) {
      if (d.base) {
        d.respawnT = RESPAWN_S;
        this.room.broadcast(eventPayload(WORLD_MODEL.deploy!, 'deployDown', 'id', d.id, { kind: d.kind, team: d.team, respawnS: RESPAWN_S }) as ServerMessage);
        logger.info('Base asset down', { id: d.id, kind: d.kind, team: d.team, by });
        if (d.kind === 'generator') {this.room.refreshPowerStructures();} // grid drops - gate fields go dark
      } else {
        logger.info('Deploy destroyed', { id: d.id, kind: d.kind, owner: d.owner, by });
        this.remove(d.id);
      }
    }
  }

  /** A downed base asset stands back up - timer expiry or a repair tech
   *  beating the clock. Fresh hp, no armor (armor is welded on after). */
  private revive(d: Deployed): void {
    d.hp = HP[d.kind];
    d.armor = 0;
    d.respawnT = 0;
    this.room.broadcast(eventPayload(WORLD_MODEL.deploy!, 'deployUp', 'id', d.id, {}) as ServerMessage);
    this.sendHp(d);
    logger.info('Base asset restored', { id: d.id, kind: d.kind, team: d.team });
    if (d.kind === 'generator') {this.room.refreshPowerStructures();}
  }

  private sendHp(d: Deployed, src?: string): void {
    // src is the welder's id on a heal tick - other clients draw their
    // repair beam off it; damage ticks carry no src.
    this.room.broadcast(verbPayload(WORLD_MODEL.deploy!, 'update', 'id', d.id, { hp: Math.max(0, Math.round(d.hp)), armor: Math.round(d.armor), src }) as ServerMessage);
  }

  // Repair claims are rate-limited per shooter+target - a client can pace
  // its beam ticks but can't bank a year's worth in a burst.
  private lastRepair = new Map<string, number>();

  /** Friendly only: own gear always; teammates' gear when teams exist.
   *  Base assets belong to the team, not a body - same-side weld only. */
  private weldable(p: PlayerState, d: Deployed, playerId: string): boolean {
    if (d.base) {return !d.team || p.team === d.team;}
    if (p.team && d.owner !== playerId) {
      return this.room.players.getPlayer(d.owner)?.team === p.team;
    }
    return p.team !== undefined || d.owner === playerId;
  }

  /** Beam-intent target: the weldable deployable the ray actually
   *  touches - same padded-sphere pick as the client's repairHit
   *  (r=1.1, body-center +0.7), nearest entry wins. Lets the
   *  shotFired intent replace the per-tick repair claim: the server
   *  names the target too. */
  repairTarget(playerId: string, muzzle: Vec3, dir: Vec3, range: number): number | null {
    const p = this.room.players.getPlayer(playerId);
    if (!p || p.isDead) {return null;}
    // Weld assist: the beam bends ~5° toward the weldable nearest the
    // crosshair - a thin antenna on a sensor at 40m is a pixel-wide
    // target under a flat 1.1m capsule. Direct capsule hits still win;
    // cone candidates pick the smallest angular offset.
    const CONE_SIN = 0.0872; // sin(5°) - ang off-axis the beam bends
    let bestDirect: number | null = null;
    let bestDirectT = range;
    let bestCone: number | null = null;
    let bestConeAng = Infinity;
    for (const d of this.items.values()) {
      const cx = d.pos.x - muzzle.x, cy = d.pos.y + 0.7 - muzzle.y, cz = d.pos.z - muzzle.z;
      const proj = cx * dir.x + cy * dir.y + cz * dir.z;
      if (proj < 0 || proj > range) {continue;}
      const perp2 = (cx * cx + cy * cy + cz * cz) - proj * proj;
      if (!this.weldable(p, d, playerId)) {continue;}
      if (perp2 < 1.1 * 1.1) {
        const entry = Math.max(proj - (1.1 * 1.1 - perp2) ** 0.5, 0);
        if (entry < bestDirectT) { bestDirectT = entry; bestDirect = d.id; }
        continue;
      }
      const ang = perp2 / (proj * proj); // sin²θ - cone test needs no sqrt
      if (ang < bestConeAng && ang < CONE_SIN * CONE_SIN) { bestConeAng = ang; bestCone = d.id; }
    }
    return bestDirect ?? bestCone;
  }

  /** Repair-tool beam tick on a friendly deployable: heal to base, then
   *  overcharge armor to REPAIR_ARMOR_MULT×. Server re-derives distance,
   *  LOS, team and the heal amount - the claim names a target, nothing
   *  else. */
  repair(playerId: string, targetId: number): ClaimVerdict {
    const d = this.items.get(targetId);
    const p = this.room.players.getPlayer(playerId);
    if (!d || !p || p.isDead) {return 'gone';}
    if (!this.weldable(p, d, playerId)) {return 'enemy';}
    const dx = d.pos.x - p.position.x, dy = d.pos.y - p.position.y, dz = d.pos.z - p.position.z;
    if (dx * dx + dy * dy + dz * dz > REPAIR_RANGE * REPAIR_RANGE * 2.25) {return 'range';} // 1.5× slack
    if (!losClear(this, p.position, d.pos, p.team)) {return 'los';}
    const key = `${playerId}:${targetId}`;
    const now = simNow() / 1000;
    if (now - (this.lastRepair.get(key) ?? -1) < REPAIR_MIN_TICK_S) {return 'cooldown';}
    this.lastRepair.set(key, now);
    const hpCap = HP[d.kind];
    // A hulk welds back from zero - blast overkill digs hp far negative,
    // and making a tech excavate it would gate revival on the kill shot's
    // size instead of the weld time.
    if (d.base && d.hp < 0) {d.hp = 0;}
    const healed = Math.min(REPAIR_HEAL_PER_TICK, hpCap - d.hp);
    d.hp += healed;
    d.armor = Math.min(REPAIR_ARMOR_MULT * hpCap, d.armor + (REPAIR_HEAL_PER_TICK - healed));
    if (d.base && d.hp > 0 && d.respawnT > 0) {this.revive(d);} // welded back early
    else {this.sendHp(d, playerId);}
    return true;
  }

  remove(id: number): void {
    const gone = this.items.get(id);
    if (!this.items.delete(id)) {return;}
    // Dead ids must drop their rate-limit keys - otherwise every planted
    // and destroyed item leaves a permanent entry in lastRepair.
    for (const k of this.lastRepair.keys()) {
      if (k.endsWith(`:${id}`)) {this.lastRepair.delete(k);}
    }
    // A dying water sphere must leave nobody wading - the domes are
    // sticky state on the move shadows, not a query.
    if (gone?.kind === 'watersphere') {
      for (const pid of this.room.moveSim.shadowIds()) {this.room.moveSim.setWaterDome(pid, undefined);}
    }
    this.room.broadcast(verbPayload(WORLD_MODEL.deploy!, 'gone', 'id', id, {}) as ServerMessage);
    this.refreshSolids();
  }

  /** AOE blast sweep - every deployable inside the radius eats scaled
   *  splash (same falloff curve as players). Own gear is exempt: your
   *  own blast can't raze your own stand. */
  applyBlast(center: Vec3, damage: number, radius: number, shooterId: string, scales?: readonly number[], weapon?: number, splash?: number): void {
    if (this.items.size === 0) {return;}
    // Sticky launcher is the breaching tool - 2x to structures/base
    // assets gives the otherwise-purposeless gun a siege job.
    const mult = weapon === WeaponType.Sticky ? 2 : 1;
    const aoe = splash ?? damage;
    for (const d of this.items.values()) {
      const dx = d.pos.x - center.x, dy = d.pos.y - center.y, dz = d.pos.z - center.z;
      const dist = (dx * dx + dy * dy + dz * dz) ** 0.5;
      if (dist > radius) {continue;}
      // Friendly fire: no teammate's blast damages our gear - and your
      // OWN blast exempts your OWN gear too (a mortaring engie shouldn't
      // raze his stand; player self-splash staying legal is a body rule,
      // not a gear rule). Base assets resolve the shooter's team from
      // the virtual base:<team> owner id.
      if (shooterId === d.owner) {continue;}
      const deployTeam = this.teamOf(d);
      const shooterTeam = shooterId.startsWith('base:')
        ? shooterId.slice(5)
        : this.room.players.getPlayer(shooterId)?.team;
      if (deployTeam !== undefined && shooterTeam !== undefined && deployTeam === shooterTeam) {
        continue;
      }
      // Contact hit - the blast center landed inside the item's body
      // radius (a sticky glued ON the turret): pays the direct line, no
      // falloff. Outside it, splash does its normal aoe scale.
      const direct = dist <= DEPLOY_ITEMS[d.kind].bodyR;
      // Static gear can't dodge - a bolt landing inside the envelope does
      // at least half its base splash, so clearing a stand costs a few
      // well-placed lobs instead of a dozen grazed edges.
      const dmg = (direct ? damage : Math.max(aoeDamage(aoe, dist, radius, scales), Math.round(aoe * 0.5))) * mult;
      if (!Number.isFinite(dmg) || dmg <= 0) {continue;}
      logger.debug('Deploy hit', { kind: d.kind, dist: Number(dist.toFixed(1)), dmg, hp: d.hp, by: shooterId });
      this.hurt(d, dmg, shooterId);
    }
  }

  /** Tether snare - one pass over every player rather than per tether, so a
   *  tether that expires or is recycled can't leave a stale snare on a shadow
   *  (the early-out below would skip that cleanup). `held` tracks the hold a
   *  body built up inside a ring; breaking out of it zaps jet energy. */
  private readonly held = new Map<string, number>();
  /** Currently snared body → the tether holding it - lets bot combat
   *  answer "what do I shoot to get free" instead of polling items. */
  private readonly snaredBy = new Map<string, Deployed>();
  /** The tether holding this player, if any - read by bot combat so a
   *  caught bot can blast its way out instead of waiting out the drag. */
  snareOf(pid: string): Deployed | undefined { return this.snaredBy.get(pid); }
  private tickTethers(): void {
    const def = DEPLOY_ITEMS.tether;
    for (const pid of this.held.keys()) {if (!this.room.players.getPlayer(pid)) {this.held.delete(pid);}}
    for (const pid of this.snaredBy.keys()) {if (!this.room.players.getPlayer(pid)) {this.snaredBy.delete(pid);}}
    for (const [pid, p] of this.room.players.getAllPlayers()) {
      let snare: Deployed | undefined;
      const at = this.room.moveSim.simPos(pid);
      if (!p.isDead && at) {
        for (const t of this.items.values()) {
          if (t.kind !== 'tether' || pid === t.owner) {continue;}
          const dTeam = this.teamOf(t);
          if (dTeam !== undefined && p.team === dTeam) {continue;}
          const dx = at.x - t.pos.x, dz = at.z - t.pos.z;
          if (dx * dx + dz * dz < def.tetherRadius! * def.tetherRadius!) {snare = t; break;}
        }
      }
      if (snare) {this.snaredBy.set(pid, snare);} else {this.snaredBy.delete(pid);}
      // Read the slow the last step applied BEFORE the snare check: the step
      // that carries a body out of the ring is the one that bled it.
      const slow = this.room.moveSim.tetherSlowOf(pid);
      if (slow > 0) {this.held.set(pid, Math.max(this.held.get(pid) ?? 0, slow));}
      this.room.moveSim.setTether(pid, snare && { x: snare.pos.x, y: snare.pos.y, z: snare.pos.z, r: def.tetherRadius! });
      if (!snare && this.held.has(pid)) {
        const hold = this.held.get(pid)!;
        this.held.delete(pid);
        if (!p.isDead && hold > 0) {this.room.moveSim.drainEnergy(pid, def.tetherZap! * hold);}
      }
    }
  }

  tick(dt: number): void {
    this.tickTethers();
    if (this.items.size === 0) {return;}
    for (const d of this.items.values()) {
      if (d.base) {
        if (d.respawnT > 0) {
          d.respawnT -= dt;
          if (d.respawnT <= 0) {this.revive(d);}
          continue;
        }
        if (d.hp <= 0) {continue;}
      } else {
        d.ttl -= dt;
        if (d.ttl <= 0) { this.remove(d.id); continue; }
      }
      if (!this.powered(d)) {continue;} // generator down - base goes dark
      // Intermission godmode: weapons-grade deployables stand down too -
      // a sentry can't kill anyway (applyDamage is gated) but it still
      // paints tracers/knockback over the scoreboard. Station keeps
      // healing, sensor keeps pinging, watersphere keeps sloshing.
      const standDown = this.room.players.invulnerable;
      const spec = TICK_SPEC[d.kind];
      if (spec && (!spec.standsDown || !standDown)) {spec.tick(this, d, dt);}
    }
    // Sentry bolts in flight - the blast lands where the bolt does, so a
    // sidestepping capper genuinely outruns it (non-homing by design).
    for (let i = this.bolts.length - 1; i >= 0; i -= 1) {
      const b = this.bolts[i]!;
      b.ttl -= dt;
      if (b.ttl > 0) {continue;}
      this.bolts.splice(i, 1);
      this.room.messages.mineBlast(b.owner, b.at, b.dmg, b.rad, b.kb);
    }
  }

  /** Scheduled sentry-bolt impacts - see tickSentry. */
  readonly bolts: { at: Vec3; ttl: number; owner: string; dmg: number; rad: number; kb: number }[] = [];

}
