/**
 * RoomFlags — server-authoritative CTF state. The server already tracks
 * every player's position and death, so flag rules run off that truth
 * with no client claims to trust: each tick we look at who is near a
 * flag and apply the same constants the offline sim uses
 * (FLAG_PICKUP_R / FLAG_HOME_R / FLAG_RESET_S from shared/teams.ts).
 *
 * State transitions only ever happen here — clients render flagUpdate
 * broadcasts; a client that ignores them just sees the wrong visuals,
 * never the wrong score.
 */
import type { Vec3 } from './types.ts';
import type { Room } from './Room.ts';
import { FLAG_PICKUP_R, FLAG_HOME_R, FLAG_RESET_S, type TeamId } from '../../shared/teams.ts';
import { logger } from './logger.ts';
import { weaponStats } from './weaponStats.ts';
import { perkMods } from '../../shared/perks.ts';
import { simNow } from './simClock.ts';
import { aoeImpulse } from '../../shared/combat.ts';
import { hmHeight, hmSettleWalkable } from '../../shared/heightfield.ts';
import { GRAVITY } from '../../shared/movement.ts';
import { CTF_PTS } from '../../shared/teams.ts';
import { WORLD_MODEL, rosterRow } from '../../shared/worldModel.ts';

// 'unspawned' is server-internal — rabbit's flag doesn't exist until
// first blood, and it never reaches the wire (snapshot filters it).
export type FlagState = 'unspawned' | 'home' | 'carried' | 'dropped';

export interface RoomFlag {
  team: TeamId;        // the flag's owning team (whose base it defends)
  home: Vec3;
  pos: Vec3;
  state: FlagState;
  carrier: string | null;
  /** Dropped-flag ballistic velocity — zero when resting. */
  vel: Vec3;
  /** Seconds left before a dropped flag walks itself home. */
  dropT: number;
  /** Balance telemetry: grab/drop wall-times → carrier hold ms on cap,
   *  drop ms on return (flags dying on the stand vs midfield transit). */
  carriedAt: number;
  droppedAt: number;
  /** Rabbit hold-time accumulator — each whole second carried pays out. */
  holdAcc: number;
  /** Whose toss is still airborne — the thrower can't instantly re-grab
   *  their own throw (the flag never leaves the touch ring in one tick).
   *  Cleared the moment the flag settles or changes hands. */
  airborneBy: string | null;
}

// Dropped-flag ballistics — a nugget-class loose object: pops out of the
// dead carrier's grip, arcs to dirt, bounces a little, skids to rest.
// Blast impulses knock it again; the rest spot is pickup truth.
const FLAG_REST_LIFT = 0.5;   // sphere rest height above terrain
const FLAG_BOUNCE = 0.3;      // vertical restitution
const FLAG_FRICTION = 4.0;    // skid bleed per second
const FLAG_GRAV = -GRAVITY;   // loose objects fall at world gravity — one constant, no soft-tumble fork
const FLAG_KNOCK = 0.55;      // fraction of the player-scale blast impulse
const FLAG_SETTLE = 0.6;      // |vel| below this on the ground = rest
const FLAG_THROW_SPEED = 20;  // deliberate toss along aim — hand-off range, not a hail mary
// Rabbit's ring is wider: carriers die every ~9s and a hunter arriving at
// ski speed can't turn inside 2.2m — the overshoot lap was ~4s of flag-lay
// per drop (~30% of a match down on a 12-bot raindance soak).
const RABBIT_PICKUP_R = 4.5;
// Rabbit loose flag drifts toward the nearest living player — a corpse's
// fumble should find the next carrier fast; without it a flag that lands
// 15m off anyone's line eats ~3s of pickup latency per drop (~18% of a
// match down). Item-magnet, not AI: the flag comes to feet.
const RABBIT_MAGNET_R = 20;
const RABBIT_MAGNET_SPEED = 5;

export class RoomFlags {
  readonly flags = new Map<TeamId, RoomFlag>();
  private readonly room: Room;
  /** Accrues between flag broadcasts — cadence is cheap since state is tiny. */
  private dirty = true;
  /** Per-cap telemetry: carrier, hold ms, cap sim-time — soak/reporting
   *  reads real caps here instead of diffing flagUpdate broadcasts
   *  (match resets fake the same carried→home transition). */
  readonly capLog: { by: string; team: string; holdMs: number; capAt: number }[] = [];
  /** Same ground truth for returns — who touched the dropped flag home. */
  readonly retLog: { by: string; team: string; at: number }[] = [];
  /** And for grabs — the stand-touch that starts a run. */
  readonly grabLog: { by: string; team: string; at: number }[] = [];
  /** Last-tick positions for the sweep — a stand touch is a fast graze,
   *  not a park: at 60m/s a capper crosses the pickup ring between two
   *  20Hz frames, so the check must test the path, not the snapshot. */
  private prevPos = new Map<string, Vec3>();

  /** Rabbit rooms run a single neutral flag (keyed 'alpha' on the wire) —
   *  Partial bases are how the room declares it. */
  private get rabbit(): boolean { return this.room.mode === 'rabbit'; }

  constructor(room: Room, bases: Partial<Record<TeamId, Vec3>>) {
    this.room = room;
    for (const [team, home] of Object.entries(bases) as [TeamId, Vec3][]) {
      // Rabbit flags begin unspawned — the FIRST corpse of the match is
      // what brings the flag into the world, exactly like T2.
      const state: FlagState = this.rabbit ? 'unspawned' : 'home';
      this.flags.set(team, { team, home, pos: { ...home }, vel: { x: 0, y: 0, z: 0 }, state, carrier: null, dropT: 0, carriedAt: 0, droppedAt: 0, holdAcc: 0, airborneBy: null });
    }
  }

  /** Re-anchored homes after the real terrain landed or the spec's bases
   *  moved. Homes update unconditionally; a flag sitting 'home' also moves
   *  its live pos, carried/dropped flags keep theirs — the wire shows
   *  where they are, not where the stand is. */
  retargetHomes(homes: Partial<Record<TeamId, Vec3>>): void {
    for (const [team, f] of this.flags) {
      const home = homes[team];
      if (!home) continue;
      if (f.home.x === home.x && f.home.y === home.y && f.home.z === home.z) continue;
      f.home = { ...home };
      if (f.state === 'home') f.pos = { ...home };
      this.dirty = true;
    }
  }

  /** Reset flags on a fresh match — rabbit's goes back to unspawned
   *  so the new match's first blood re-seeds it. */
  reset(): void {
    for (const f of this.flags.values()) {
      f.pos = { ...f.home };
      f.vel = { x: 0, y: 0, z: 0 };
      f.state = this.rabbit ? 'unspawned' : 'home';
      f.carrier = null;
      f.dropT = 0;
      f.holdAcc = 0;
      f.airborneBy = null;
    }
    this.dirty = true;
    // Match-boundary wipe — consumers window by `at >= runStart`, so a
    // prior match's entries only ever read as noise while growing for
    // the room's life.
    this.capLog.length = 0;
    this.grabLog.length = 0;
    this.retLog.length = 0;
  }

  /** Snapshot for gameState joins and the flagUpdate broadcast. */
  snapshot() {
    // home rides every snapshot — the stand mesh + socket marker are
    // placed from it, including by clients who join mid-run while the
    // flag itself is away (a 'home'-state pos alone can't tell them).
    return [...this.flags.values()].filter((f) => f.state !== 'unspawned').map((f) => rosterRow(WORLD_MODEL.flag!, 'team', f.team, {
      pos: { ...f.pos }, home: { ...f.home },
      // 'unspawned' is filtered above — the wire union only knows live states.
      state: f.state, carrier: f.carrier,
    }) as { team: TeamId; pos: Vec3; home: Vec3; state: 'home' | 'carried' | 'dropped'; carrier: string | null });
  }

  /** Carrier died — flag drops where they fell. Called from the shared
   *  damage funnel so ANY death source (shots, bots, environment) drops it. */
  dropIfCarrier(playerId: string): void {
    for (const f of this.flags.values()) {
      if (f.carrier !== playerId) continue;
      // The dead carrier gets the fumble line — the killer's taunt
      // already fires on the frag itself.
      this.room.messages.killFeed.say(playerId, 'flagdrop');
      this.room.bots?.notice('flagdrop', playerId,
        this.room.players.getPlayer(playerId)?.team);
      const p = this.room.players.getPlayer(playerId);
      if (p) f.pos = { ...p.position };
      f.carrier = null;
      f.state = 'dropped';
      f.dropT = FLAG_RESET_S;
      f.droppedAt = simNow();
      this.loose(f, p?.velocity);
      this.dirty = true;
    }
  }

  /** Rabbit: the flag isn't on a stand at match start — first blood
   *  drops it at the corpse. Called on EVERY death like dropIfCarrier;
   *  only the first 'unspawned' flag takes the corpse's position. */
  spawnAtCorpse(playerId: string): void {
    if (!this.rabbit) return;
    for (const f of this.flags.values()) {
      if (f.state !== 'unspawned') continue;
      const corpse = this.room.players.getPlayer(playerId);
      f.pos = corpse ? { ...corpse.position } : { ...f.home };
      f.state = 'dropped';
      f.dropT = FLAG_RESET_S;
      f.droppedAt = simNow();
      this.loose(f, corpse?.velocity);
      logger.info('Rabbit flag spawned', { room: this.room.name, at: f.pos });
      this.room.influence.splat(f.pos, 'opportunity', 1.2);
      this.dirty = true;
    }
  }

  /** The carrier hurls the flag along their look — hand it to a teammate
   *  or ditch it away from a collapsing defense. The arc derives from the
   *  shadow's position/velocity/rotation truth: a client-claimed dir
   *  could punt the objective out of the arena from anywhere. */
  throwFor(playerId: string): void {
    const p = this.room.players.getPlayer(playerId);
    if (!p || p.isDead) return;
    for (const f of this.flags.values()) {
      if (f.state !== 'carried' || f.carrier !== playerId) continue;
      const cp = Math.cos(p.rotation.pitch), sp = Math.sin(p.rotation.pitch);
      f.pos = { ...p.position };
      f.carrier = null;
      f.state = 'dropped';
      f.dropT = FLAG_RESET_S;
      f.droppedAt = simNow();
      // Deliberate throw rides FULL carrier speed — ski-speed hucks
      // carry; drops keep loose()'s half-vel fumble instead.
      f.vel.x = p.velocity.x + cp * Math.sin(p.rotation.yaw) * FLAG_THROW_SPEED;
      f.vel.y = p.velocity.y + 3 + sp * FLAG_THROW_SPEED;
      f.vel.z = p.velocity.z + cp * Math.cos(p.rotation.yaw) * FLAG_THROW_SPEED;
      f.airborneBy = playerId;
      this.room.messages.killFeed.say(playerId, 'flagdrop');
      this.room.bots?.notice('flagdrop', playerId, p.team);
      this.room.influence.splat(f.pos, 'opportunity', 1.2);
      this.dirty = true;
    }
  }

  /** Flag goes loose: inherit half the carrier's speed plus a pop so a
   *  drop reads as a fumble, not a teleport to the dirt. The ballistic
   *  tick owns it from here; the rest spot snaps to walkable ground. */
  private loose(f: RoomFlag, vel?: Vec3): void {
    // Rabbit keeps a short pop — a 40m/s corpse skid carried the flag
    // ~20m past the killer and the re-touch took seconds; the flag
    // staying near the kill is what keeps rabbit's hot-potato pace.
    const k = this.rabbit ? 0.15 : 0.5;
    f.vel.x = (vel?.x ?? 0) * k;
    f.vel.y = (vel?.y ?? 0) * k + 3;
    f.vel.z = (vel?.z ?? 0) * k;
  }

  /** A blast shoved a dropped flag — puntable objective, same deal as
   *  nuggets: server moves truth, flagUpdate streams the flight, the rest
   *  spot is what a touch resolves against. */
  knock(at: Vec3, radius: number, force: number): void {
    for (const f of this.flags.values()) {
      if (f.state !== 'dropped') continue;
      const dx = f.pos.x - at.x, dy = f.pos.y - at.y, dz = f.pos.z - at.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d >= radius) continue;
      const mag = aoeImpulse(force, d, radius) * FLAG_KNOCK;
      f.vel.x += (dx / (d || 1)) * mag;
      f.vel.z += (dz / (d || 1)) * mag;
      f.vel.y += Math.abs(mag) * 0.4; // pop off the dirt — tumble, not skid
      this.dirty = true;
    }
  }

  /** CTF flag-zone test for the personal-score bonus — is `pos` inside
   *  radius of EITHER stand (defending yours or sieging theirs)? */
  nearStand(pos: Vec3, r: number): boolean {
    for (const f of this.flags.values()) {
      const dx = pos.x - f.home.x, dy = pos.y - f.home.y, dz = pos.z - f.home.z;
      if (dx * dx + dy * dy + dz * dz <= r * r) return true;
    }
    return false;
  }

  /** One flag rule pass — rides the room's existing 20Hz tick. Returns the
   *  capturing team when a flag came home, so Room can bank the point. */
  tick(dt: number): TeamId | null {
    let captureBy: TeamId | null = null;

    for (const f of this.flags.values()) {
      if (f.state === 'unspawned') continue; // rabbit: not in play yet
      if (f.state === 'carried') {
        captureBy = this.tickCarried(f, dt) ?? captureBy;
        continue;
      }
      if (f.state === 'dropped') this.tickDropped(f, dt);
      if (f.state !== 'dropped' && f.state !== 'home') continue;
      this.tickTouch(f);
    }

    if (this.dirty) {
      this.dirty = false;
      this.room.broadcast({ type: 'flagUpdate', flags: this.snapshot() });
    }
    // Snapshot AFTER the rules pass — the next tick's sweep segment
    // starts exactly where this one ended. Reuse the stored Vec3 (must
    // stay a snapshot, not an alias): field writes kill N allocs/tick.
    for (const p of this.room.players.getAllPlayers().values()) {
      const prev = this.prevPos.get(p.id);
      if (prev) { prev.x = p.position.x; prev.y = p.position.y; prev.z = p.position.z; }
      else this.prevPos.set(p.id, { ...p.position });
    }
    for (const id of this.prevPos.keys()) {
      if (!this.room.players.getPlayer(id)) this.prevPos.delete(id);
    }
    return captureBy;
  }

  /** Carried flag: rides the carrier (tracked for capture checks, never
   *  broadcast — clients pin it to the carrier's rendered position, so a
   *  20Hz pos stream would buy zero visible difference). A vanished or
   *  dead carrier drops it on the spot; reaching the own-base ring with
   *  own flag home scores. Returns the capturing team, if any. */
  /** Rabbit's only truth: which player currently holds the neutral flag.
   *  The damage gate and scoring both read this — a null return means the
   *  flag is loose (see spawned() for whether that's still open season). */
  /** Rabbit: the flag exists once first blood drops it — the 'unspawned'
   *  pre-game is open season, spawned-but-loose still enforces pairings. */
  spawned(): boolean {
    for (const f of this.flags.values()) {
      if (f.state !== 'unspawned') return true;
    }
    return false;
  }

  carrierId(): string | null {
    for (const f of this.flags.values()) {
      if (f.state === 'carried') return f.carrier;
    }
    return null;
  }

  private tickCarried(f: RoomFlag, dt: number): TeamId | null {
    const carrier = f.carrier ? this.room.players.getPlayer(f.carrier) : undefined;
    if (!carrier || carrier.isDead) {
      // Refresh pos from the corpse when it's still around — otherwise
      // the flag teleports to wherever it was last tracked.
      if (carrier) f.pos = { ...carrier.position };
      f.state = 'dropped';
      f.carrier = null;
      f.dropT = FLAG_RESET_S;
      this.loose(f, carrier?.velocity);
      this.room.influence.splat(f.pos, 'opportunity', 1.2);
      this.dirty = true;
      return null;
    }
    f.pos = { ...carrier.position };
    // Rabbit: no cap ring — the carrier IS the score. Every second held
    // pays one FFA point through the same awardFfa → matchEnd funnel.
    if (this.rabbit) {
      f.holdAcc += dt;
      while (f.holdAcc >= 1) {
        f.holdAcc -= 1;
        this.room.scoring.grantFfa(carrier.id, 1);
      }
      return null;
    }
    // Classic CTF: the cap only counts while your own flag is home —
    // otherwise a team could score with its flag in enemy hands.
    const ownFlag = this.flags.get(carrier.team as TeamId)!;
    const cdx = f.pos.x - ownFlag.home.x, cdz = f.pos.z - ownFlag.home.z;
    if (carrier.team !== f.team && ownFlag.state === 'home'
      && Math.hypot(cdx, cdz) <= FLAG_HOME_R) {
      logger.info('Flag captured', { room: this.room.name, flag: f.team, by: carrier.id });
      this.room.messages.killFeed.say(carrier.id, 'flagcap');
      this.room.bots?.notice('flagcap', carrier.id, carrier.team);
      if (f.carriedAt) {
        const holdMs = simNow() - f.carriedAt;
        weaponStats.recordFlag(this.room.mode, 'cap', holdMs);
        this.capLog.push({ by: carrier.id, team: f.team, holdMs, capAt: simNow() });
      }
      f.state = 'home';
      f.pos = { ...f.home };
      f.carrier = null;
      f.carriedAt = 0;
      this.room.influence.splat(f.home, 'opportunity', 1.2);
      this.room.scoring.awardPersonal(carrier.id, CTF_PTS.cap);
      this.dirty = true;
      return carrier.team as TeamId;
    }
    return null;
  }

  /** Dropped flag countdown — time-out sends it home. */
  private tickDropped(f: RoomFlag, dt: number): void {
    this.tickBallistic(f, dt);
    if (this.rabbit && f.vel.x === 0 && f.vel.y === 0 && f.vel.z === 0) this.magnet(f, dt);
    f.dropT -= dt;
    if (f.dropT > 0) return;
    if (f.droppedAt) weaponStats.recordFlag(this.room.mode, 'return', simNow() - f.droppedAt);
    f.state = 'home';
    f.pos = { ...f.home };
    f.vel = { x: 0, y: 0, z: 0 };
    f.droppedAt = 0;
    this.dirty = true;
  }

  /** Rabbit-only item magnet: a settled flag slides toward the nearest
   *  living player inside RABBIT_MAGNET_R at walking speed. */
  private magnet(f: RoomFlag, dt: number): void {
    let best: { x: number; y: number; z: number } | null = null;
    let bestD2 = RABBIT_MAGNET_R * RABBIT_MAGNET_R;
    for (const p of this.room.players.getAllPlayers().values()) {
      if (p.isDead) continue;
      const dx = p.position.x - f.pos.x, dy = p.position.y - f.pos.y, dz = p.position.z - f.pos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = p.position; }
    }
    if (!best) return;
    const d = Math.sqrt(bestD2) || 1;
    const stepLen = Math.min(RABBIT_MAGNET_SPEED * dt, d);
    f.pos.x += (best.x - f.pos.x) / d * stepLen;
    f.pos.z += (best.z - f.pos.z) / d * stepLen;
    const field = this.room.field;
    if (field) f.pos.y = hmHeight(field, f.pos.x, f.pos.z) + FLAG_REST_LIFT;
    this.dirty = true;
  }

  /** Loose-flag physics: ballistic arc + terrain restitution, then a skid
   *  bleed to rest. While it moves, flagUpdate streams the live pos each
   *  tick (truth matters — the ring a player grabs is THIS position);
   *  at rest the spot is snapped to walkable ground like a nugget. */
  private tickBallistic(f: RoomFlag, dt: number): void {
    if (f.vel.x === 0 && f.vel.y === 0 && f.vel.z === 0) return;
    const field = this.room.field;
    f.vel.y -= FLAG_GRAV * dt;
    f.pos.x += f.vel.x * dt;
    f.pos.y += f.vel.y * dt;
    f.pos.z += f.vel.z * dt;
    const gy = field ? hmHeight(field, f.pos.x, f.pos.z) + FLAG_REST_LIFT : f.pos.y;
    if (f.pos.y <= gy) {
      f.pos.y = gy;
      if (f.vel.y < -2) {
        f.vel.y = -f.vel.y * FLAG_BOUNCE; // thud, not a ricochet
      } else {
        f.vel.y = 0;
      }
      const bleed = Math.max(0, 1 - FLAG_FRICTION * dt);
      f.vel.x *= bleed;
      f.vel.z *= bleed;
    }
    const sp2 = f.vel.x * f.vel.x + f.vel.y * f.vel.y + f.vel.z * f.vel.z;
    if (sp2 < FLAG_SETTLE * FLAG_SETTLE && f.pos.y <= gy + 0.05) {
      f.vel.x = f.vel.y = f.vel.z = 0;
      f.airborneBy = null; // settled — anyone, the thrower included, may touch
      if (field) hmSettleWalkable(field, f.pos, FLAG_REST_LIFT);
    }
    this.dirty = true; // flight is stream-worthy — see the doc comment
  }

  /** Touch rules: an enemy inside pickup radius grabs a home/dropped
   *  flag; own team touching a dropped flag sends it home. */
  private tickTouch(f: RoomFlag): void {
    const t = this.nearestTouching(f);
    if (!t) return;
    // Rabbit: the flag is neutral — anyone touching it becomes the
    // carrier, home or dropped. No return-by-touch exists; the only
    // way home is the drop timer.
    if (this.rabbit) {
      logger.info('Rabbit flag grabbed', { room: this.room.name, by: t.id });
      this.room.messages.killFeed.say(t.id, 'flaggrab');
      this.room.bots?.notice('flaggrab', t.id, undefined);
      f.state = 'carried';
      f.carrier = t.id;
      f.carriedAt = simNow();
      f.holdAcc = 0;
      this.grabLog.push({ by: t.id, team: f.team, at: simNow() });
      this.room.influence.splat(f.pos, 'opportunity', 1.2);
      f.airborneBy = null;
      this.dirty = true;
      return;
    }
    if (t.team === f.team && f.state === 'dropped') {
      logger.info('Flag returned', { room: this.room.name, flag: f.team, by: t.id });
      this.room.messages.killFeed.say(t.id, 'flagreturn');
      this.room.bots?.notice('flagreturn', t.id, t.team);
      if (f.droppedAt) weaponStats.recordFlag(this.room.mode, 'return', simNow() - f.droppedAt);
      this.retLog.push({ by: t.id, team: f.team, at: simNow() });
      this.room.scoring.awardPersonal(t.id, CTF_PTS.flagReturn);
      f.state = 'home';
      f.pos = { ...f.home };
      f.droppedAt = 0;
      f.airborneBy = null;
      this.dirty = true;
    } else if (t.team && t.team !== f.team) {
      logger.info('Flag grabbed', { room: this.room.name, flag: f.team, by: t.id });
      this.room.messages.killFeed.say(t.id, 'flaggrab');
      this.room.bots?.notice('flaggrab', t.id, t.team);
      f.state = 'carried';
      f.carrier = t.id;
      f.airborneBy = null;
      f.carriedAt = simNow();
      this.grabLog.push({ by: t.id, team: f.team, at: simNow() });
      // A grab is the loudest objective scent — it starts the chase.
      this.room.influence.splat(f.pos, 'opportunity', 1.2);
      this.dirty = true;
    }
  }

  private nearestTouching(f: RoomFlag): { id: string; team?: string } | null {
    let best: { id: string; team?: string; d: number } | null = null;
    for (const p of this.room.players.getAllPlayers().values()) {
      // Rabbit is FFA — hunters carry no team, so the !p.team guard
      // would make the flag untouchable; it's a CTF-only filter.
      if (p.isDead || (!this.rabbit && !p.team)) continue;
      // A thrown flag can't be re-grabbed by its thrower until it
      // settles — without this a stationary carrier instantly re-catches
      // their own toss (it never leaves the ring inside one tick).
      if (p.id === f.airborneBy) continue;
      // Swept capsule: closest point on the player's path segment to the
      // flag, so a full-speed graze can't tunnel through the ring the
      // way a snapshot check does. Planar reach + vertical cap keep a
      // real jet flyover from counting — the capsule is the touch.
      const a = this.prevPos.get(p.id) ?? p.position;
      const b = p.position;
      const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
      const len2 = abx * abx + aby * aby + abz * abz;
      let t = 0;
      if (len2 > 0) {
        t = Math.min(1, Math.max(0,
          ((f.pos.x - a.x) * abx + (f.pos.y - a.y) * aby + (f.pos.z - a.z) * abz) / len2));
      }
      const cx = a.x + abx * t, cy = a.y + aby * t, cz = a.z + abz * t;
      if (Math.abs(cy - f.pos.y) > 6) continue;
      const d = Math.hypot(cx - f.pos.x, cz - f.pos.z);
      const ring = (this.rabbit ? RABBIT_PICKUP_R : FLAG_PICKUP_R) * perkMods(p.perk).pickupRadius;
      if (d <= ring && (!best || d < best.d)) best = { id: p.id, team: p.team, d };
    }
    return best;
  }
}
