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

export type FlagState = 'home' | 'carried' | 'dropped';

export interface RoomFlag {
  team: TeamId;        // the flag's owning team (whose base it defends)
  home: Vec3;
  pos: Vec3;
  state: FlagState;
  carrier: string | null;
  /** Seconds left before a dropped flag walks itself home. */
  dropT: number;
}

export class RoomFlags {
  readonly flags = new Map<TeamId, RoomFlag>();
  private readonly room: Room;
  /** Accrues between flag broadcasts — cadence is cheap since state is tiny. */
  private dirty = true;

  constructor(room: Room, bases: { alpha: Vec3; bravo: Vec3 }) {
    this.room = room;
    for (const team of TEAMS) {
      const home = bases[team];
      this.flags.set(team, { team, home, pos: { ...home }, state: 'home', carrier: null, dropT: 0 });
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
      const p = this.room.players.getPlayer(playerId);
      if (p) f.pos = { ...p.position };
      f.carrier = null;
      f.state = 'dropped';
      f.dropT = FLAG_RESET_S;
      this.dirty = true;
    }
  }

  /** One flag rule pass — rides the room's existing 20Hz tick. Returns the
   *  capturing team when a flag came home, so Room can bank the point. */
  tick(dt: number): TeamId | null {
    let captureBy: TeamId | null = null;

    for (const f of this.flags.values()) {
      if (f.state === 'carried') {
        const carrier = f.carrier ? this.room.players.getPlayer(f.carrier) : undefined;
        // Carrier vanished (disconnect reap, room teardown): drop on the spot.
        if (!carrier || carrier.isDead) {
          f.state = 'dropped';
          f.carrier = null;
          f.dropT = FLAG_RESET_S;
          this.dirty = true;
          continue;
        }
        f.pos = { ...carrier.position }; // truth for the capture check below —
        // but NOT broadcast: clients pin a carried flag to the carrier's
        // rendered position, so we only send flagUpdate on transitions.
        // Saves a 20Hz stream per carried flag for zero visible difference.
        // Reaching own base ring with the enemy flag scores — but only
        // while your own flag is home; classic CTF, otherwise a team
        // could cap while its flag sits in enemy hands.
        const ownFlag = this.flags.get(carrier.team as TeamId)!;
        const ownBase = ownFlag.home;
        const cdx = f.pos.x - ownBase.x, cdz = f.pos.z - ownBase.z;
        if (carrier.team !== f.team && ownFlag.state === 'home'
          && Math.sqrt(cdx * cdx + cdz * cdz) <= FLAG_HOME_R) {
          f.state = 'home';
          f.pos = { ...f.home };
          f.carrier = null;
          captureBy = carrier.team as TeamId;
          this.dirty = true;
        }
        continue;
      }

      if (f.state === 'dropped') {
        f.dropT -= dt;
        if (f.dropT <= 0) {
          f.state = 'home';
          f.pos = { ...f.home };
          this.dirty = true;
          continue;
        }
      }

      // Touch rules: enemy within pickup radius grabs a home/dropped flag;
      // own team touching a dropped flag sends it home.
      const t = this.nearestTouching(f);
      if (!t) continue;
      if (t.team === f.team && f.state === 'dropped') {
        f.state = 'home';
        f.pos = { ...f.home };
        this.dirty = true;
      } else if (t.team && t.team !== f.team) {
        f.state = 'carried';
        f.carrier = t.id;
        this.dirty = true;
      }
    }

    if (this.dirty) {
      this.dirty = false;
      this.room.broadcast({ type: 'flagUpdate', flags: this.snapshot() });
    }
    return captureBy;
  }

  private nearestTouching(f: RoomFlag): { id: string; team?: string } | null {
    let best: { id: string; team?: string; d: number } | null = null;
    for (const p of this.room.players.getAllPlayers().values()) {
      if (p.isDead || !p.team) continue;
      // Planar grab — the flag rides at ground height but players jump/ski
      // past it; a hop shouldn't put the flag out of reach. Steep vertical
      // separation (a real jet flyover) still doesn't count.
      const dx = p.position.x - f.pos.x, dz = p.position.z - f.pos.z;
      const dy = Math.abs(p.position.y - f.pos.y);
      if (dy > 6) continue;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d <= FLAG_PICKUP_R && (!best || d < best.d)) best = { id: p.id, team: p.team, d };
    }
    return best;
  }
}
