/**
 * RoomIntel - the server-truth IFF layer. Tribes-style sensor net:
 * an enemy marker is a privilege of DETECTION, not a roster echo.
 *
 * Two sight channels feed one per-viewer contact table:
 *  - personal LOS: every ~1s each living non-bot player sweeps hostiles
 *    inside SIGHT_M through the shared botLos march (terrain + structure
 *    occlusion, memoized). A sighting lands on every teammate's table at
 *    BASE linger (the loose/shared read) AND on the observer's own table
 *    at perk-scaled linger (recon remembers longer, nobody else does).
 *  - sensor masts: tickSensor's pulse sweep calls noteSensor(), which
 *    stamps the same base linger for the owning side.
 *
 * The wire 'intel' message carries each client's live set split into
 * `seen` (fresh this sweep - marker rides the replicated body) and `mem`
 * (lingering - marker sits at last-known). Every expiry is stamped here,
 * so a modified client can only render what the server already decided
 * it may see.
 */
import type { Room } from './Room.ts';
import type { Vec3 } from './types.ts';
import { simNow } from './simClock.ts';
import { hmHeight, type Heightfield } from '../../shared/heightfield.ts';
import { losClear } from '../../shared/botLos.ts';
import type { BrainCtx } from '../../shared/botBrain.ts';
import { perkMods } from '../../shared/perks.ts';
import { STATUS, shootRevealed } from '../../shared/status.ts';
import type { IntelContact } from '../../shared/protocol.ts';

const SWEEP_S = 1;
/** Personal sight envelope - matches the bot sight domain (botHunt's
 *  SIGHT_M) so humans and bots share one honest range; occlusion, not
 *  distance, is what actually hides a marker. Sensors extend it locally. */
const SIGHT_M = 300;
const BASE_LINGER_MS = 4000;
/** A contact counts as 'seen' (live marker) for this long after its
 *  last detection, then decays to 'mem' (last-known ghost marker). */
const FRESH_MS = 1500;

interface Contact {
  x: number; y: number; z: number;
  until: number;
  freshUntil: number;
}

type Row = { id: string; team?: string; position: Vec3; isDead: boolean; isBot?: boolean; perk: string; status: number; lastFireSim: number };

export class RoomIntel {
  /** viewerId -> targetId -> contact. Entries self-expire; maps are
   *  pruned each sweep so a 64-seat room stays ~4k rows worst case. */
  private readonly detect = new Map<string, Map<string, Contact>>();
  private sweepT = 0;
  /** One ctx mutated per viewer - losClear reads it synchronously and
   *  losMemo keys already carry the team nibble. */
  private readonly ctx: Partial<BrainCtx> & { groundY: (x: number, z: number) => number } = { groundY: () => 0 };

  constructor(private readonly room: Room) {
    const field = (): Heightfield | null => this.room.field;
    this.ctx.groundY = (x: number, z: number): number => {
      const f = field();
      return Math.max(f ? hmHeight(f, x, z) : -1e9, this.room.moveSim.structureTop(x, z));
    };
    this.ctx.now = 0;
  }

  /** ballSim swaps its collider array on terrain attach - refresh the
   *  ctx refs per use rather than caching them in the ctor. */
  private syncCtx(): void {
    this.ctx.solids = this.room.ballSim.colliders;
    this.ctx.solidIndex = this.room.ballSim.colliderIndex ?? undefined;
  }

  tick(dt: number): void {
    this.sweepT -= dt;
    if (this.sweepT > 0) {return;}
    this.sweepT = SWEEP_S;
    this.sweep();
  }

  /** Same-side predicate mirroring serverParties: team modes share
   *  sightings across the team; FFA/teamless intel is personal-only. */
  private matesOf(o: Row, players: Row[], teams: boolean): Row[] {
    if (!teams || o.team === undefined) {return [o];}
    return players.filter((q): boolean => q.team === o.team);
  }

  private touch(viewer: string, target: string, pos: Vec3, until: number, now: number): void {
    let m = this.detect.get(viewer);
    if (!m) {m = new Map(); this.detect.set(viewer, m);}
    const c = m.get(target);
    if (c) {
      if (until > c.until) {c.until = until;}
      c.x = pos.x; c.y = pos.y; c.z = pos.z;
      c.freshUntil = now + FRESH_MS;
    } else {
      m.set(target, { x: pos.x, y: pos.y, z: pos.z, until, freshUntil: now + FRESH_MS });
    }
  }

  /** A base mast's pulse sweep relayed hostiles to a side - stamp base
   *  linger on every teammate's table (the shared sensor net). Sightline
   *  occlusion was already applied by the caller's scan. */
  noteSensor(ownerId: string, team: string | undefined, targets: { id: string; x: number; y: number; z: number }[]): void {
    const now = simNow();
    const teams = Boolean(this.room.modeSpec?.teams);
    for (const v of this.room.players.getAllPlayers().values()) {
      if (v.isDead || v.isBot) {continue;}
      const shares = teams ? (team !== undefined && v.team === team) : v.id === ownerId;
      if (!shares) {continue;}
      for (const t of targets) {this.touch(v.id, t.id, t, now + BASE_LINGER_MS, now);}
    }
  }

  /** Structure+terrain LOS for deployable scans that need the intel
   *  layer's honest sightline (the mast sweeps from its crown, not its
   *  feet). */
  los(team: string | undefined, from: Vec3, to: Vec3): boolean {
    this.syncCtx();
    (this.ctx as { team?: string }).team = team;
    this.ctx.now = simNow();
    return losClear(this.ctx as BrainCtx, from, to);
  }

  private sweep(): void {
    const now = simNow();
    this.ctx.now = now;
    this.syncCtx();
    const teams = Boolean(this.room.modeSpec?.teams);
    const players = [...this.room.players.getAllPlayers().values()] as unknown as Row[];
    const sight2 = SIGHT_M * SIGHT_M;
    for (const v of players) {
      if (v.isDead || v.isBot) {continue;}
      (this.ctx as { team?: string }).team = v.team;
      let mates: Row[] | null = null;
      for (const t of players) {
        if (t.id === v.id || t.isDead) {continue;}
        // Cloaked hosts stay dark to pulse sight too - only his own
        // gunfire (shootRevealed) re-opens him, same rule bots use.
        if ((t.status & STATUS.CLOAK) !== 0 && !shootRevealed(t.lastFireSim, now)) {continue;}
        if (teams ? t.team === v.team : false) {continue;}
        const dx = t.position.x - v.position.x, dy = t.position.y - v.position.y, dz = t.position.z - v.position.z;
        if (dx * dx + dy * dy + dz * dz > sight2) {continue;}
        if (!losClear(this.ctx as BrainCtx, v.position, t.position)) {continue;}
        if (!mates) {mates = this.matesOf(v, players, teams);}
        const base = now + BASE_LINGER_MS;
        for (const m of mates) {this.touch(m.id, t.id, t.position, base, now);}
        // The observer's own eyes get the perk-scaled window - the only
        // place intelLinger applies; teammates keep base memory of it.
        this.touch(v.id, t.id, t.position, now + BASE_LINGER_MS * perkMods(v.perk).intelLinger, now);
      }
    }
    this.emit(now, players);
  }

  /** The per-player wire feed - seen = fresh this sweep (live marker),
   *  mem = lingering (last-known ghost). Empty sets still send so a
   *  dropped contact clears promptly instead of waiting out a timeout. */
  private emit(now: number, players: Row[]): void {
    for (const v of players) {
      if (v.isBot) {continue;}
      const m = this.detect.get(v.id);
      const seen: IntelContact[] = [];
      const mem: IntelContact[] = [];
      if (m) {
        for (const [tid, c] of m) {
          if (c.until <= now) {m.delete(tid); continue;}
          (c.freshUntil > now ? seen : mem).push({ id: tid, x: c.x, y: c.y, z: c.z });
        }
      }
      this.room.sendToPlayer(v.id, { type: 'intel', seen, mem });
    }
  }

  /** Test seam - the contact set a player would currently be sent. */
  contactsFor(playerId: string, now = simNow()): { id: string; x: number; y: number; z: number; fresh: boolean }[] {
    const m = this.detect.get(playerId);
    if (!m) {return [];}
    const out: { id: string; x: number; y: number; z: number; fresh: boolean }[] = [];
    for (const [tid, c] of m) {
      if (c.until > now) {out.push({ id: tid, x: c.x, y: c.y, z: c.z, fresh: c.freshUntil > now });}
    }
    return out;
  }
}
