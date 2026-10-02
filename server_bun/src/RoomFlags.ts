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
import { FLAG_PICKUP_R, FLAG_HOME_R, FLAG_RESET_S, TEAMS, type TeamId } from '../../shared/teams.ts';
import { logger } from './logger.ts';
import { weaponStats } from './weaponStats.ts';
import { perkMods } from '../../shared/perks.ts';
import { simNow } from './simClock.ts';

export type FlagState = 'home' | 'carried' | 'dropped';

export interface RoomFlag {
  team: TeamId;        // the flag's owning team (whose base it defends)
  home: Vec3;
  pos: Vec3;
  state: FlagState;
  carrier: string | null;
  /** Seconds left before a dropped flag walks itself home. */
  dropT: number;
  /** Balance telemetry: grab/drop wall-times → carrier hold ms on cap,
   *  drop ms on return (flags dying on the stand vs midfield transit). */
  carriedAt: number;
  droppedAt: number;
}

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

  constructor(room: Room, bases: { alpha: Vec3; bravo: Vec3 }) {
    this.room = room;
    for (const team of TEAMS) {
      const home = bases[team];
      this.flags.set(team, { team, home, pos: { ...home }, state: 'home', carrier: null, dropT: 0, carriedAt: 0, droppedAt: 0 });
    }
  }

  /** Reset both flags on a fresh match. */
  reset(): void {
    for (const f of this.flags.values()) {
      f.pos = { ...f.home };
      f.state = 'home';
      f.carrier = null;
      f.dropT = 0;
    }
    this.dirty = true;
  }

  /** Snapshot for gameState joins and the flagUpdate broadcast. */
  snapshot() {
    return [...this.flags.values()].map((f) => ({
      team: f.team, pos: { ...f.pos }, state: f.state, carrier: f.carrier,
    }));
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
      this.dirty = true;
    }
  }

  /** One flag rule pass — rides the room's existing 20Hz tick. Returns the
   *  capturing team when a flag came home, so Room can bank the point. */
  tick(dt: number): TeamId | null {
    let captureBy: TeamId | null = null;

    for (const f of this.flags.values()) {
      if (f.state === 'carried') {
        captureBy = this.tickCarried(f) ?? captureBy;
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
    // starts exactly where this one ended.
    for (const p of this.room.players.getAllPlayers().values()) {
      this.prevPos.set(p.id, { ...p.position });
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
  private tickCarried(f: RoomFlag): TeamId | null {
    const carrier = f.carrier ? this.room.players.getPlayer(f.carrier) : undefined;
    if (!carrier || carrier.isDead) {
      // Refresh pos from the corpse when it's still around — otherwise
      // the flag teleports to wherever it was last tracked.
      if (carrier) f.pos = { ...carrier.position };
      f.state = 'dropped';
      f.carrier = null;
      f.dropT = FLAG_RESET_S;
      this.room.influence.splat(f.pos, 'opportunity', 1.2);
      this.dirty = true;
      return null;
    }
    f.pos = { ...carrier.position };
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
      this.dirty = true;
      return carrier.team as TeamId;
    }
    return null;
  }

  /** Dropped flag countdown — time-out sends it home. */
  private tickDropped(f: RoomFlag, dt: number): void {
    f.dropT -= dt;
    if (f.dropT > 0) return;
    if (f.droppedAt) weaponStats.recordFlag(this.room.mode, 'return', simNow() - f.droppedAt);
    f.state = 'home';
    f.pos = { ...f.home };
    f.droppedAt = 0;
    this.dirty = true;
  }

  /** Touch rules: an enemy inside pickup radius grabs a home/dropped
   *  flag; own team touching a dropped flag sends it home. */
  private tickTouch(f: RoomFlag): void {
    const t = this.nearestTouching(f);
    if (!t) return;
    if (t.team === f.team && f.state === 'dropped') {
      logger.info('Flag returned', { room: this.room.name, flag: f.team, by: t.id });
      this.room.messages.killFeed.say(t.id, 'flagreturn');
      this.room.bots?.notice('flagreturn', t.id, t.team);
      if (f.droppedAt) weaponStats.recordFlag(this.room.mode, 'return', simNow() - f.droppedAt);
      this.retLog.push({ by: t.id, team: f.team, at: simNow() });
      f.state = 'home';
      f.pos = { ...f.home };
      f.droppedAt = 0;
      this.dirty = true;
    } else if (t.team && t.team !== f.team) {
      logger.info('Flag grabbed', { room: this.room.name, flag: f.team, by: t.id });
      this.room.messages.killFeed.say(t.id, 'flaggrab');
      this.room.bots?.notice('flaggrab', t.id, t.team);
      f.state = 'carried';
      f.carrier = t.id;
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
      if (p.isDead || !p.team) continue;
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
      if (d <= FLAG_PICKUP_R * perkMods(p.perk).pickupRadius && (!best || d < best.d)) best = { id: p.id, team: p.team, d };
    }
    return best;
  }
}
