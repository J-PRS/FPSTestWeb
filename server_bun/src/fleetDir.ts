import { wallMs, type WallMs } from './wallClock.ts';

// Fleet directory — which worker owns which room. Pure state, no IO:
// the launcher (fleet.ts) drives it from worker heartbeats and /join
// claims, and tests drive it with staged clocks.

export interface FleetWorker {
  id: string;
  port: number;
  ccu: number;
  rooms: Set<string>;
  lastBeat: WallMs;
  up: boolean;
}

export class FleetDirectory {
  readonly workers = new Map<string, FleetWorker>();
  /** Rooms confirmed by a worker heartbeat — the directory's source of
   *  truth. Pending claims only cover the gap between /join and the
   *  worker's next beat so two simultaneous joiners can't split. */
  private readonly roomHome = new Map<string, string>();
  private readonly claims = new Map<string, { workerId: string; at: WallMs }>();

  /** A beat older than this marks the worker down — its rooms re-open
   *  for placement on the survivors (clients rejoin through /join). */
  static readonly BEAT_STALE_MS = 8_000;
  /** A pending claim lives only until the beat confirms (or another
   *  claim lands) — a crashed-join claim must not pin the room forever. */
  static readonly CLAIM_TTL_MS = 10_000;

  register(id: string, port: number): FleetWorker {
    const w: FleetWorker = { id, port, ccu: 0, rooms: new Set(), lastBeat: wallMs(0), up: false };
    this.workers.set(id, w);
    return w;
  }

  beat(id: string, rooms: string[], ccu: number, now: WallMs): void {
    const w = this.workers.get(id);
    if (!w) {return;}
    w.lastBeat = now;
    w.up = true;
    w.ccu = ccu;
    w.rooms = new Set(rooms);
    // Reconcile: drop this worker's homes it no longer reports (room
    // disposed/drained), adopt the ones it does.
    for (const [room, home] of this.roomHome) {
      if (home === id && !w.rooms.has(room)) {this.roomHome.delete(room);}
    }
    for (const room of rooms) {
      const home = this.roomHome.get(room);
      // A pending claim on another worker wins over a stale beat —
      // matches the claim's purpose (first joiner pins the placement).
      if (home === undefined) {this.roomHome.set(room, id);}
    }
  }

  /** Where should a client asking for `room` connect? Confirmed homes
   *  and fresh claims win; otherwise least-CCU live worker gets a
   *  pending claim. Null when every worker is down. */
  resolve(room: string | undefined, now: WallMs): FleetWorker | null {
    this.sweep(now);
    if (room) {
      const home = this.roomHome.get(room);
      const homeW = home ? this.workers.get(home) : undefined;
      if (homeW?.up) {return homeW;}
      const claim = this.claims.get(room);
      const claimW = claim ? this.workers.get(claim.workerId) : undefined;
      if (claim && now - claim.at < FleetDirectory.CLAIM_TTL_MS && claimW?.up) {return claimW;}
    }
    let best: FleetWorker | null = null;
    for (const w of this.workers.values()) {
      if (!w.up) {continue;}
      if (best === null || w.ccu < best.ccu) {best = w;}
    }
    if (best && room) {this.claims.set(room, { workerId: best.id, at: now });}
    return best;
  }

  private sweep(now: WallMs): void {
    for (const w of this.workers.values()) {
      if (w.up && now - w.lastBeat > FleetDirectory.BEAT_STALE_MS) {
        w.up = false;
        w.ccu = 0;
        // Its confirmed homes re-open — but claims pointing at it are
        // dead weight until they expire, so drop them now.
        for (const [room, home] of this.roomHome) {
          if (home === w.id) {this.roomHome.delete(room);}
        }
        for (const [room, c] of this.claims) {
          if (c.workerId === w.id) {this.claims.delete(room);}
        }
      }
    }
  }

  status() {
    return [...this.workers.values()].map((w) => ({
      id: w.id,
      port: w.port,
      up: w.up,
      ccu: w.ccu,
      rooms: [...w.rooms],
    }));
  }
}
