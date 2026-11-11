/**
 * Server-side ballistic sim - bots-as-legal-players phase 2.
 *
 * A bot fire no longer means "broadcast a tracer, roll damage". It spawns
 * a real projectile the room integrates through shared/projSim.ts: swept
 * segment vs the heightfield and every live player's capsule, then damage
 * through the same CombatHandler funnels a client's validated claim uses
 * (applyHit → kill credit, weapon attribution, friendly gate, respawn).
 *
 * Clients render the replica off the existing projectileCreated /
 * projectileDestroyed pair - remote projectiles already fly
 * deterministically client-side, so nothing new is needed there.
 *
 * Deliberate simplifications vs the client Projectile: no terrain bounce
 * (a server shell pops on contact - bounces are cosmetic anyway since
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
import { HM_DIVISOR, HM_HEIGHT_SCALE, hmHeight, type Heightfield } from '../../shared/heightfield.ts';
import { getWeaponStats, WeaponType, idSeed, jitteredTtl, roomDirectDamage, directHitAoeBonus, RIDE_CATCH_R, canHostRide, BELT_THROW_WEAPONS, isInstagibWeapon } from '../../shared/weapons.ts';
import { waterDomeDrag, type WaterDome } from '../../shared/deployItems.ts';
import { GRAVITY } from '../../shared/movement.ts';
import type { Vec3, ServerMessage } from './types.ts';
import type { RoomMods } from '../../shared/protocol.ts';
import { WORLD_MODEL, spawnPayload, verbPayload, eventPayload } from '../../shared/worldModel.ts';
import type { PlayerManager } from './PlayerManager.ts';
import type { MessageHandler } from './MessageHandler.ts';
import { stepContact, dischargeRay } from './projContact.ts';
import { perkMods } from '../../shared/perks.ts';
import { weaponStats } from './weaponStats.ts';
import { encodeProjSpawn, encodeProjGone } from '../../shared/wire.ts';

export interface LiveProj {
  id: string;
  ownerId: string;
  weaponType: number;
  /** Stats are weapon-table constants - resolved once at spawn instead of
   *  re-looked-up every tick/discharge per projectile. */
  stats: NonNullable<ReturnType<typeof getWeaponStats>>;
  p: SimProjectile;
  /** Age at which the parabola could first reach the terrain ceiling.
   *  Before it, segFieldHit is skipped - provably nothing below. */
  terrainAt: number;
  /** Slugger perk: direct-hit bonus stamped at spawn when the launch
   *  speed was capped down (min(1.5, orig/cap)). 1 = no trade. */
  directBonus: number;
  /** This shell's fuse - maxLifetime jittered per id so burst weapons
   *  (flak) pop raggedly. Client replicas derive the same value from the
   *  projectileId, so both ends' pops line up. */
  ttl: number;
  /** Glue-bomb rest state (stats.stick): set when contact stops the
   *  shell instead of popping it. `playerId` + `off` ride the body it
   *  glued to; undefined = frozen at its landing point. The fuse is
   *  the only trigger left. */
  stuck?: { playerId?: string; off: Vec3 };
  /** Debug: whether this sticky was cooked by a sibling detonation. */
  cooked?: boolean;
  /** Terrain hits taken - maxBounces ends the shell on the Nth. */
  bounces?: number;
  /** Owner's team at spawn - team-filtered solids (shield gates) let the
   *  shell through when it matches. undefined = teamless/owner gone. */
  ownerTeam?: string;
  /** Trigger-pull identity: the intent's shotId when claimed, this
   *  shell's own id when not (bots carry no nonce). All pellets of one
   *  fan share it - the ledger dedupes per-pull connects on it. */
  pull: string;
  /** Belt-sticky combo: this shell caught a ridable bomb - no wait,
   *  the other direction: set ON THE RIDER, value = the host shell's id.
   *  A riding projectile stops integrating, centers on the host, and
   *  detonates where the host dies. */
  rides?: string;
  /** fuseOnly carriers: bodies this shell already bonked - each body
   *  reflects it once (no re-trigger next tick inside the capsule). */
  bodyBounced?: Set<string>;
}

// Player aim height - matches where the client sweeps the capsule center.
// Failsafe TTL for weapons that forgot a fuse - nothing should orbit forever.
const HARD_TTL_S = 8;
// Below this altitude the shell is irrecoverably underground / off-map.
const FLOOR_Y = -220;

/** Earliest future time (from now, seconds) at which the parabola
 *  y(t) = y0 + vy·t + ½g·t² can descend to `ceiling`. Infinity when the
 *  shell is rising or gravity-free and never returns there. The result is
 *  a floor for skipping terrain sweeps: no heightfield texel exceeds the
 *  precomputed max, so a miss before this time is impossible. */
function timeToCeiling(y0: number, vy: number, g: number, ceiling: number): number {
  if (y0 <= ceiling) {return 0;}                       // already inside - check now
  const target = ceiling - y0;                        // negative drop needed
  if (g === 0) {
    if (vy >= 0) {return Infinity;}                    // flat/rising forever
    return (target / vy);                            // vy<0: linear descent
  }
  // ½g·t² + vy·t + (y0−ceiling) = 0 → smaller root is first descent to it.
  const a = 0.5 * g, c = y0 - ceiling;
  const disc = vy * vy - 4 * a * c;
  if (disc < 0) {return Infinity;}                     // apex never reaches it
  const sq = Math.sqrt(disc);
  const t1 = (-vy - sq) / (2 * a);
  const t0 = (-vy + sq) / (2 * a);
  // First descent = smallest positive root; taking min() picks the
  // negative root whenever vy≈0 and the sweep gets scheduled at Infinity.
  if (t0 > 0) {return Math.min(t0, t1 > 0 ? t1 : t0);}
  return t1 > 0 ? t1 : Infinity;
}

/** The slice of a live authority RoomProjectiles needs: everything a
 *  blast touches in one bag so a Room AND a P2P host can own the sim.
 *  Optional members are the roster sims a host legitimately lacks -
 *  their `?.` sites already degrade (no creature casualties off shells). */
export interface ProjHost {
  players: PlayerManager;
  messages: MessageHandler;
  broadcast(msg: unknown, exclude?: string): void;
  /** Binary edge lane (dedicated). Absent on the P2P host - its edges
   *  stay JSON, small rooms don't need the byte win. */
  connections?: { broadcastBinaryReliable(data: Uint8Array): void };
  /** playerId → wireId - needed to name the shooter on binary spawns. */
  wireIds?: Map<string, number>;
  rng(): number;
  tickSeq: number;
  mode: string;
  /** Room modifiers - instagib whitelists spawned weapons and pays
   *  the flat rail number; gungame gates spawns to the owner's rung
   *  weapon and igun pays the flat ~200 on body contacts. */
  mods?: RoomMods;
  gunGameAllowsFire?(ownerId: string, weaponType: number): boolean;
  pushNoise(pos: Vec3): void;
  ballSim?: {
    handleHit(ownerId: string, ballId: number, dmg: number): { killed: boolean };
    splashDamage(ownerId: string, at: Vec3, radius: number, dmg: number, excludeId?: number): void;
    sweepHit(a: Vec3, b: Vec3, pad: number, backMs?: number): { id: number; t: number; d: number } | null;
    ballAt(id: number): { radius: number } | null | undefined;
  };
  creatureSim?: {
    handleHit(ownerId: string, crawlerId: number, dmg: number): { killed: boolean };
    splashDamage(ownerId: string, at: Vec3, radius: number, dmg: number, excludeId?: number): void;
    sweepHit(a: Vec3, b: Vec3, pad: number, backMs?: number): { id: number; t: number; d: number } | null;
  };
  deployables?: {
    shieldBlock(from: Vec3, to: Vec3, shooterId: string): number | null;
    /** Live gear hulls - a shell detonates on contact instead of
     *  phasing through a generator and popping on the wall behind it. */
    solidCols?: readonly StructureCollider[];
    /** Live watersphere domes - every shell wades them (environmental
     *  drag, no team check). Absent = dry map. */
    waterDomes?(): readonly WaterDome[];
  };
  moveSim?: { structureTop(x: number, z: number): number; transitOf?(playerId: string): number; transitVarOf?(playerId: string): number };
}

export class RoomProjectiles {
  readonly room: ProjHost;
  field: Heightfield | null;
  /** Highest terrain height anywhere on the map - a shell above it
   *  cannot touch ground this step, so segFieldHit can be skipped. */
  fieldMax = -Infinity;
  /** Solid map geometry - shells pop on walls like they do on terrain,
   *  so a mortar can't splash through the base roof. */
  solids: readonly StructureCollider[] = [];
  /** Structure occluders - the beam contact check reads the same set the
   *  flight sweep detonates against. */
  get solidColliders(): readonly StructureCollider[] { return this.solids; }
  solidIndex: ColliderIndex | null = null;
  private projs = new Map<string, LiveProj>();
  private nextId = 1;
  /** Watersphere domes, refreshed once per tick - the drag pass reads
   *  this for every flying shell. */
  private domes: readonly WaterDome[] = [];
  /** Reused start-of-step position - feeds swept collision + detonate;
   *  read synchronously each iteration, never retained. */
  private readonly stepScratch: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(room: ProjHost, field: Heightfield | null) {
    this.room = room;
    this.field = null;
    this.attachField(field);
  }

  /** Map rotation / admin reload can swap the terrain under a live
   *  room - shells must sweep the field players actually stand on. */
  attachField(field: Heightfield | null): void {
    this.field = field;
    // One full scan per field swap; ticks then solve vs this bound.
    let maxByte = 0;
    if (field) {
      const d = field.data, s = field.stride;
      for (let i = 0; i < d.length; i += s) {if (d[i]! > maxByte) {maxByte = d[i]!;}}
    }
    this.fieldMax = (maxByte / HM_DIVISOR) * HM_HEIGHT_SCALE;
    // Schedules were solved against the old ceiling - resweep until each
    // arc re-earns its skip against the new field.
    for (const proj of this.projs.values()) {proj.terrainAt = 0;}
  }

  /** Structures ride the same lifecycle as the field - spec load and
   *  admin reload both refresh them. */
  attachStructures(list: readonly StructureSpec[] | undefined): void {
    this.solids = structureColliders(list);
    this.solidIndex = this.solids.length > 0 ? new ColliderIndex(this.solids) : null;
  }

  /** Fire a real projectile. `dir` is normalized; muzzle velocity = dir*speed
   *  + 50% of the shooter's velocity (same inheritance the client applies).
   *  Burst weapons (flak/shotgun) fire the whole pellet fan - a pull
   *  registers `burst` shells fanned by golden-angle cone offsets, same
   *  coverage the client spawnFan produces. */
  spawn(ownerId: string, weaponType: number, origin: Vec3, dir: Vec3, ownerVel: Vec3, shotId?: string, lagS = 0): string | null {
    // Modifier backstops: every spawn path (claims, bot arsenal, deploy
    // sims) funnels here - a weapon outside the room's rules has no body.
    if (this.room.mods?.instagib === true && !isInstagibWeapon(weaponType)) {return null;}
    if (this.room.mods?.gungame === true && this.room.gunGameAllowsFire?.(ownerId, weaponType) === false) {return null;}
    const stats = getWeaponStats(weaponType);
    const burst = stats?.burst ?? 1;
    const spread = stats?.pelletSpread ?? 0;
    if (burst <= 1 || spread <= 0) {return this.spawnOne(ownerId, weaponType, origin, dir, ownerVel, shotId, undefined, lagS);}
    // One pull = one nonce for every pellet - unclaimed (bot) fans get a
    // minted pull id so the ledger can dedupe connects per trigger pull.
    const pullId = shotId ?? `pf-${(this.nextId += 1)}`;
    // Fan basis: right = dir × up0, up = right × dir - deterministic
    // Vogel-spiral coverage (no rng: every pellet's offset is fixed by
    // index, so sim replicas fan identically).
    let rx = -dir.z, rz = dir.x; const ry = 0;
    const rl = Math.hypot(rx, rz);
    if (rl < 1e-8) { rx = 1; rz = 0; } else { rx /= rl; rz /= rl; }
    const ux = ry * dir.z - rz * dir.y, uy = rz * dir.x - rx * dir.z, uz = rx * dir.y - ry * dir.x;
    const golden = Math.PI * (3 - Math.sqrt(5));
    let first: string | null = null;
    for (let i = 0; i < burst; i += 1) {
      const r = Math.sqrt((i + 0.5) / burst) * spread;
      const a = i * golden;
      const ox = Math.cos(a) * r, oy = Math.sin(a) * r;
      const dx = dir.x + rx * ox + ux * oy, dy = dir.y + ry * ox + uy * oy, dz = dir.z + rz * ox + uz * oy;
      const l = Math.hypot(dx, dy, dz) || 1;
      const id = this.spawnOne(ownerId, weaponType, origin, { x: dx / l, y: dy / l, z: dz / l }, ownerVel, pullId, i, lagS);
      if (first === null) {first = id;}
    }
    return first;
  }

  private spawnOne(ownerId: string, weaponType: number, origin: Vec3, dir: Vec3, ownerVel: Vec3, shotId?: string, pellet?: number, lagS = 0): string | null {
    const stats = getWeaponStats(weaponType);
    if (!stats || stats.speed <= 0) {return null;} // hitscan-class - no body
    const owner = this.room.players.getPlayer(ownerId);
    if (!owner) {return null;}
    // Roster gun reveal - a bot's silhouette reads before its first shot
    // edge lands. Belt throws are tossed, not held: stamping one would
    // advertise a type with no hand model and leave the remote wearing
    // the generic prop until the next real gun shot.
    if (!BELT_THROW_WEAPONS.has(weaponType)) {owner.weapon = weaponType;}
    const id = `sp-${((this.nextId += 1) - 1)}`;
    const inh = stats.inherit ?? 0.5;
    // Slugger perk: cap launch speed, excess pays back as direct bonus.
    // Same formula as the client's spawn - cap drives BOTH sim ends.
    const cap = perkMods(owner.perk).projSpeedCap;
    const capped = cap > 0 && stats.speed > cap;
    const effSpeed = capped ? cap : stats.speed;
    const speedRatio = stats.speed / effSpeed;
    const vel: Vec3 = {
      x: dir.x * effSpeed + ownerVel.x * inh,
      y: dir.y * effSpeed + ownerVel.y * inh,
      z: dir.z * effSpeed + ownerVel.z * inh,
    };
    const g = stats.gravity ? GRAVITY : 0;
    // Schedule the first age at which this arc could reach the terrain
    // ceiling; spawned inside it → sweep every tick as before.
    const terrainAt = this.field ? timeToCeiling(origin.y, vel.y, g, this.fieldMax + stats.bodyRadius) : 0;
    this.projs.set(id, {
      id, ownerId, weaponType, stats, p: { pos: Object.assign({}, origin), vel, age: lagS }, terrainAt,
      pull: shotId ?? id,
      ownerTeam: owner.team,
      // ttl scales by the same cut ratio - capped shells keep range.
      ttl: (jitteredTtl(stats, idSeed(id)) ?? HARD_TTL_S) * speedRatio,
      directBonus: capped ? Math.min(1.5, speedRatio) : 1,
    });
    // shotId/pellet are the intent's nonce - the shooter's predicted
    // shell binds its server identity off this echo (linkOwnProjectile).
    this.edgeSpawn(id, ownerId, origin, vel, weaponType, shotId, pellet, lagS);
    return id;
  }

  /** Binary edge (~46B+shotId vs ~200B JSON) - the create/gone pair was
   *  ~44% of client egress at a full room. Owner wireId is how receivers
   *  resolve the shooter; an owner with no wireId yet (first-tick fire)
   *  or a host without the binary lane falls back to JSON. */
  private edgeSpawn(id: string, ownerId: string, origin: Vec3, vel: Vec3, weaponType: number, shotId: string | undefined, pellet: number | undefined, lagS: number): void {
    const bin = this.room.connections;
    const ownerWireId = this.room.wireIds?.get(ownerId);
    if (bin && ownerWireId !== undefined) {
      bin.broadcastBinaryReliable(encodeProjSpawn({
        projId: Number(id.slice(3)), ownerWireId, weaponType, pellet,
        age: lagS, t: Date.now(),
        position: Object.assign({}, origin), velocity: vel, shotId,
      }));
      return;
    }
    this.room.broadcast(spawnPayload(WORLD_MODEL.projectile!, id, 'projectileId', {
      ownerId, position: Object.assign({}, origin), velocity: vel, weaponType, shotId, pellet, age: lagS || undefined, t: Date.now(),
    }) as ServerMessage);
  }

  private edgeGone(proj: LiveProj, at: Vec3, age: number): void {
    const bin = this.room.connections;
    const n = proj.id.startsWith('sp-') ? Number(proj.id.slice(3)) : Number.NaN;
    if (bin && Number.isFinite(n)) {
      bin.broadcastBinaryReliable(encodeProjGone({ projId: n, age, position: at, shotId: proj.pull }));
      return;
    }
    this.room.broadcast(verbPayload(WORLD_MODEL.projectile!, 'gone', 'projectileId', proj.id, { position: at, shotId: proj.pull, age }) as ServerMessage);
  }

  tick(dt: number): void {
    this.domes = this.room.deployables?.waterDomes?.() ?? [];
    // Map iterators tolerate mid-loop delete (detonate) - no snapshot.
    for (const proj of this.projs.values()) {
      const {stats} = proj;
      const {p} = proj;
      const prevAge = p.age;
      // Combo rider: centered on the host shell - no integration, no
      // contact; the host's detonation cascades into this pop. A missing
      // host (cleared without detonate) just drops the ride.
      if (proj.rides) {
        const h = this.projs.get(proj.rides);
        if (h) { p.pos.x = h.p.pos.x; p.pos.y = h.p.pos.y; p.pos.z = h.p.pos.z; }
        else {proj.rides = undefined;}
        p.age += dt;
        continue;
      }
      // A glued bomb rides its victim - position follows the player it
      // stuck to (feet + the contact offset), so the fuse pops wherever
      // they carried it. Dead victim keeps the last riding point.
      if (proj.stuck) {p.age += dt;} // a glued bomb's fuse still burns
      if (proj.stuck?.playerId) {
        const t = this.room.players.getPlayer(proj.stuck.playerId);
        if (t && !t.isDead) {
          p.pos.x = t.position.x + proj.stuck.off.x;
          p.pos.y = t.position.y + proj.stuck.off.y;
          p.pos.z = t.position.z + proj.stuck.off.z;
        }
      }
      // stepScratch feeds swept collision + detonate - consumed
      // synchronously each iteration (catchRiders/stepContact/detonate
      // all read fields inline), so one reused Vec3 per room is enough.
      const from = this.stepScratch;
      if (proj.stuck) {from.x = p.pos.x; from.y = p.pos.y; from.z = p.pos.z;}
      else {projStep(p, dt, stats.gravity ? GRAVITY : 0, from);}
      // Watersphere drag - post-integration, pre-contact: this tick's
      // sweep still sees the full-speed segment, next tick flies slower.
      // The client applies the identical pass in stepFrame.
      if (!proj.stuck) {waterDomeDrag(p.pos, p.vel, this.domes, dt);}
      if (p.age >= proj.ttl || p.pos.y < FLOOR_Y) { from.x = p.pos.x; from.y = p.pos.y; from.z = p.pos.z; this.detonate(proj, from); continue; }
      if (proj.stuck) {continue;} // frozen - only the fuse ends it now

      // Ray-burst discharge (remote railgun): crossing rayDelay turns the
      // shell's velocity line into a hitscan beam - the earliest contact
      // along it is where the payload detonates.
      if (stats.rayDelay && prevAge < stats.rayDelay && p.age >= stats.rayDelay) {
        this.dischargeRay(proj, stats.rayRange ?? 160);
        continue;
      }

      // Combo catch: a same-owner ridable bomb inside this shell's swept
      // step glues on dead-center. Runs BEFORE contact so a shell that
      // dies inside the catch still carries its riders into the blast.
      if (!stats.rides && canHostRide(proj.weaponType, stats)) {this.catchRiders(proj, from);}
      if (this.stepContact(proj, stats, from, dt)) {continue;}
      // No contact - still flying; survives to the next tick.
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

  /** Glue a contact-frozen bomb at `at` - on a player it rides them
   *  (`off` in body space), anywhere else it sits until the fuse. */
  attach(proj: LiveProj, at: Vec3, playerId?: string): void {
    if (playerId) {
      const t = this.room.players.getPlayer(playerId);
      proj.stuck = { playerId, off: t ? { x: at.x - t.position.x, y: at.y - t.position.y, z: at.z - t.position.z } : { x: 0, y: 0, z: 0 } };
    } else {
      proj.stuck = { off: { x: 0, y: 0, z: 0 } };
    }
    proj.p.pos.x = at.x; proj.p.pos.y = at.y; proj.p.pos.z = at.z;
    proj.p.vel.x = 0; proj.p.vel.y = 0; proj.p.vel.z = 0;
  }

  /** Combo catch - a same-owner airborne belt sticky inside the swept
   *  segment glues dead-center onto this shell (Painkiller stake+nade).
   *  The edge tells replicas to parent the same pair, so every client
   *  rides the same combined trail. */
  private catchRiders(host: LiveProj, from: Vec3): void {
    const hx = host.p.pos.x - from.x, hy = host.p.pos.y - from.y, hz = host.p.pos.z - from.z;
    const len2 = hx * hx + hy * hy + hz * hz;
    const r2 = RIDE_CATCH_R * RIDE_CATCH_R;
    for (const r of this.projs.values()) {
      if (r === host || !r.stats.rides || r.stuck || r.rides || r.ownerId !== host.ownerId) {continue;}
      const ax = r.p.pos.x - from.x, ay = r.p.pos.y - from.y, az = r.p.pos.z - from.z;
      const t = len2 > 0 ? Math.max(0, Math.min(1, (ax * hx + ay * hy + az * hz) / len2)) : 0;
      const dx = ax - hx * t, dy = ay - hy * t, dz = az - hz * t;
      if (dx * dx + dy * dy + dz * dz <= r2) {
        r.rides = host.id;
        r.p.pos.x = host.p.pos.x; r.p.pos.y = host.p.pos.y; r.p.pos.z = host.p.pos.z;
        r.p.vel.x = 0; r.p.vel.y = 0; r.p.vel.z = 0;
        this.room.broadcast(eventPayload(WORLD_MODEL.projectile!, 'projRide', 'projectileId', r.id, { host: host.id }) as ServerMessage);
      }
    }
  }

  detonate(proj: LiveProj, at: Vec3, directHitId?: string | null, ballId?: number, bodyDirect?: boolean, crawlerId?: number): void {
    // Riders pop where the host died - collect before deleting, their
    // own detonate() mutates the same map.
    for (const r of [...this.projs.values()].filter((s): boolean => s.rides === proj.id)) {
      this.detonate(r, at);
    }
    this.projs.delete(proj.id);
    // `at` rides the edge: a replica's replay drifts past the real
    // contact by ~a transit of flight; exploding AT the wire point keeps
    // every predicted blast centered where the authority put it.
    this.edgeGone(proj, at, proj.p.age);
    // Skillshot ramp: sim shells carry their real flight age - a bot's
    // 2s disc lead pays the same multiplier a player's claim would. Wake
    // contacts still pay flat directDamage; only body hits earn it.
    const rampAge = bodyDirect ? proj.p.age : undefined;

    if (directHitId) {this.room.messages.botAttack(proj.ownerId, directHitId, proj.weaponType, rampAge, proj.pull);}
    // A shell that lands on a creature deals its direct line, then the
    // blast splashes the rest of the swarm - same outcome a player-caused
    // hit + aoeShot pair produces, minus the claims.
    if (ballId !== undefined) {
      const dmg = (roomDirectDamage(proj.weaponType, this.room.mods?.instagib === true, rampAge, this.room.mods?.igun === true) || proj.stats.aoeDamage) * proj.directBonus;
      const killed = this.room.ballSim?.handleHit(proj.ownerId, ballId, dmg).killed ?? false;
      weaponStats.record(this.room.mode, `w${proj.weaponType}:prey`, dmg, killed, proj.ownerId.startsWith('BOT-'));
    }
    if (crawlerId !== undefined) {
      const dmg = (roomDirectDamage(proj.weaponType, this.room.mods?.instagib === true, rampAge, this.room.mods?.igun === true) || proj.stats.aoeDamage) * proj.directBonus;
      const killed = this.room.creatureSim?.handleHit(proj.ownerId, crawlerId, dmg).killed ?? false;
      weaponStats.record(this.room.mode, `w${proj.weaponType}:prey`, dmg, killed, proj.ownerId.startsWith('BOT-'));
    }
    this.room.pushNoise(at); // a blast is louder than the muzzle that launched it
    // Rope dart: contact IS the payload - a body connect yanks the victim,
    // anything else yanks the owner. Fuse expiry is a snapped line, not a
    // reel - a mid-air pop dragging the shooter reads as a bug.
    if (proj.weaponType === WeaponType.Hook) {
      if (directHitId != null || proj.p.age < proj.ttl) {
        this.room.messages.grapple(proj.ownerId, at, directHitId ?? null);
      }
      return;
    }
    // Direct-body hits bloom the blast radius 1.5× (Bolt/Disc contract,
    // shared/weapons.ts) - replicas predict the grown envelope for
    // splash/shove/knock, so the server must pay it or every entity in
    // the annulus reads as a prediction miss (kb-echo + nugrest snaps).
    const radiusScale = bodyDirect ? directHitAoeBonus(proj.weaponType) : 1;
    this.room.messages.serverBlast(proj.ownerId, at, proj.weaponType, directHitId ?? null, { shotId: proj.pull, air: proj.p.age, radiusScale });
    // Cluster carriers (MRV, ClusterBomb): the claim path scatters bomblet
    // blasts around the burst point - sim shells must pay the same way or
    // bot-fired cluster weapons ship only the weak carrier pop.
    if (proj.stats.cluster) {
      const bomblet = proj.weaponType === WeaponType.MRVLauncher
        ? WeaponType.MRVBomblet : WeaponType.ClusterBomblet;
      const bStats = getWeaponStats(bomblet);
      for (let i = 0; i < proj.stats.cluster.count; i += 1) {
        const ang = this.room.rng() * Math.PI * 2;
        const r = this.room.rng() * proj.stats.cluster.radius;
        const bx = at.x + Math.cos(ang) * r;
        const bz = at.z + Math.sin(ang) * r;
        // Bomblets are contact bombs - the blast lands where the rain
        // lands (ground under the scatter point), not on the carrier's
        // mid-air burst plane where it out-ranges nothing above it.
        const bAt = {
          x: bx,
          y: Math.max(this.field ? hmHeight(this.field, bx, bz) : at.y,
            this.room.moveSim?.structureTop(bx, bz) ?? -Infinity),
          z: bz,
        };
        // Credit the carrier - bomblet stats drive the envelope, but
        // the launcher's weapon row is where the rain's damage belongs.
        this.room.messages.serverBlast(proj.ownerId, bAt, bomblet, null, { shotId: proj.id, attribWeaponType: proj.weaponType });
        // serverBlast sweeps players only - the rain must pay creatures
        // and balls the same way the carrier's own pop does below.
        if (bStats.aoeRadius > 0) {
          this.room.ballSim?.splashDamage(proj.ownerId, bAt, bStats.aoeRadius, bStats.aoeDamage);
          this.room.creatureSim?.splashDamage(proj.ownerId, bAt, bStats.aoeRadius, bStats.aoeDamage);
        }
      }
    }
    if (proj.stats.aoeRadius > 0) {
      const br = proj.stats.aoeRadius * radiusScale;
      this.room.ballSim?.splashDamage(proj.ownerId, at, br, proj.stats.aoeDamage, ballId);
      this.room.creatureSim?.splashDamage(proj.ownerId, at, br, proj.stats.aoeDamage, crawlerId);
    }

    // Sticky chain: a blast cooks every sibling bomb in its radius - the
    // client already rips the chain visually; aging siblings to fuse lets
    // the same cascade happen server-side so blasts land when shown.
    // Age to sib.ttl (not maxLifetime): jitteredTtl may roll past
    // maxLifetime, and cooking to the base fuse would leave those stuck.
    if (proj.weaponType === WeaponType.Sticky) {
      const r2 = proj.stats.aoeRadius * proj.stats.aoeRadius;
      let cooked = 0;
      for (const sib of this.projs.values()) {
        if (sib.weaponType !== WeaponType.Sticky) {continue;}
        const dx = sib.p.pos.x - at.x, dy = sib.p.pos.y - at.y, dz = sib.p.pos.z - at.z;
        if (dx * dx + dy * dy + dz * dz <= r2) {
          sib.p.age = Math.max(sib.p.age, sib.ttl);
          sib.cooked = true;
          cooked++;
        }
      }
    }
  }

  /** Per-tick XZ shell grid - incomingNear ran once per think was
   *  O(projs × thinks); cells prune XZ, the 3D checks below stay exact.
   *  Indices sort back to map order so results are identical to the
   *  flat scan, insertion order included. */
  private shellGrid: { seq: number; cells: Map<number, number[]>; list: LiveProj[] } | null = null;
  // Reused result scratches - shellsNear feeds only incomingNear, which
  // consumes it synchronously per bot think before the next call.
  private readonly shellIdx: number[] = [];
  private readonly shellOut: LiveProj[] = [];
  private shellsNear(pos: Vec3, radius: number): LiveProj[] {
    const seq = this.room.tickSeq;
    if (this.shellGrid?.seq !== seq) {
      const CELL = 16, BIAS = 2048;
      const cells = new Map<number, number[]>();
      const list = [...this.projs.values()];
      for (let i = 0; i < list.length; i += 1) {
        const p = list[i]!.p.pos;
        const k = ((Math.floor(p.x / CELL) + BIAS) << 16) | (Math.floor(p.z / CELL) + BIAS);
        const cell = cells.get(k);
        if (cell) {cell.push(i);} else {cells.set(k, [i]);}
      }
      this.shellGrid = { seq, cells, list };
    }
    const { cells, list } = this.shellGrid;
    const CELL = 16, BIAS = 2048;
    const idx = this.shellIdx;
    idx.length = 0;
    const x0 = Math.floor((pos.x - radius) / CELL), x1 = Math.floor((pos.x + radius) / CELL);
    const z0 = Math.floor((pos.z - radius) / CELL), z1 = Math.floor((pos.z + radius) / CELL);
    for (let cx = x0; cx <= x1; cx += 1) {for (let cz = z0; cz <= z1; cz += 1) {
      const cell = cells.get(((cx + BIAS) << 16) | (cz + BIAS));
      if (cell) {for (const i of cell) {idx.push(i);}}
    }}
    idx.sort((a, b): number => a - b);
    const out = this.shellOut;
    out.length = 0;
    for (const i of idx) {out.push(list[i]!);}
    return out;
  }

  /** Shells inside `radius` that are closing on `pos` - feeds bot threat
   *  sense so brains can sidestep incoming fire like a human reading a
   *  rocket's approach. A shell flying away is no threat regardless of
   *  distance. */
  incomingNear(pos: Vec3, radius: number): Vec3[] {
    const out: Vec3[] = [];
    for (const proj of this.shellsNear(pos, radius)) {
      const dx = pos.x - proj.p.pos.x, dy = pos.y - proj.p.pos.y, dz = pos.z - proj.p.pos.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > radius) {continue;}
      const closing = proj.p.vel.x * dx + proj.p.vel.y * dy + proj.p.vel.z * dz;
      // Parked bomb: a bounced/fused AOE shell sitting in range is still a
      // live threat — closing=0 must not make it invisible to the dodge
      // sense (howitzer shell at your feet).
      const parked = proj.stats.aoeRadius > 0
        && proj.p.vel.x * proj.p.vel.x + proj.p.vel.y * proj.p.vel.y + proj.p.vel.z * proj.p.vel.z < 4;
      if (closing <= 0 && !parked) {continue;} // moving away - ignore
      // vel rides along so the dodge sense can anticipate the launch,
      // not just the splash (BotVec + vel duck type).
      out.push(Object.assign({}, proj.p.pos, { vel: proj.p.vel }));
    }
    return out;
  }

  /** Drop an owner's live shells - disconnect/reap cleanup like the
   *  client-side destroy path. */
  clearOwner(ownerId: string): void {
    for (const [id, proj] of this.projs) {
      if (proj.ownerId === ownerId) {
        this.projs.delete(id);
        this.edgeGone(proj, proj.p.pos, proj.p.age);
      }
    }
  }
}
