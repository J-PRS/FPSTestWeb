/**
 * roomFactory — room resolve-or-create: spec resolution, Room wiring
 * (match journal, cheat kick, rotation, terrain), quick-join placement,
 * and the per-map heightfield cache. GameServer keeps the dispatcher +
 * ops surface; this owns "how a Room comes to exist".
 */
import { join } from 'node:path';
import { CONFIG } from './config.ts';
import { Room } from './Room.ts';
import { BallSim } from './BallSim.ts';
import { logger } from './logger.ts';
import type { MapCatalog } from './mapCatalog.ts';
import type { MapSpec } from '../../shared/mapSpec.ts';
import { hmScaled, type Heightfield } from '../../shared/heightfield.ts';

export interface RoomFactoryHost {
  /** Live room index — created rooms register here before returning. */
  rooms: Map<string, Room>;
  /** Session lifecycle owner — rooms read grace state through it. */
  sessions: import('./sessionRegistry.ts').SessionRegistry;
  maps: MapCatalog;
  /** Shared default field (null until the boot heightmap lands). */
  field(): Heightfield | null;
  /** A completed match's record → journal. */
  recordEnd(rec: Parameters<NonNullable<Room['onMatchEnd']>>[0]): void;
  /** Movement-judge cheat verdict → disconnect the player. */
  kickPlayer(playerId: string): boolean;
}

export class RoomFactory {
  constructor(private host: RoomFactoryHost) {}

  // Per-map terrain: spec.terrain names a maps/<file>.bin heightfield;
  // files are shared across rooms via this cache and attach when ready —
  // a room always plays on the default field until its own terrain lands.
  private fields = new Map<string, Promise<Heightfield | null>>();

  private loadField(file: string, heightScale = 1, worldScale?: number): Promise<Heightfield | null> {
    const key = `${file}@${heightScale}@${worldScale ?? 0}`;
    let p = this.fields.get(key);
    if (!p) {
      const bunFile = (globalThis as { Bun?: { file(p: string): { arrayBuffer(): Promise<ArrayBuffer> } } }).Bun?.file;
      p = bunFile
        ? bunFile(join(import.meta.dir, '..', '..', 'maps', file)).arrayBuffer()
            .then(ab => BallSim.parseHeightmap(new Uint8Array(ab), heightScale, worldScale))
            .catch(err => { logger.warn('map terrain load failed', { file, err: String(err) }); return null; })
        : Promise.resolve(null);
      this.fields.set(key, p);
    }
    return p;
  }

  /** Attach a spec's terrain to every room sim that sweeps it — missing
   *  one means two systems disagree about where the ground is. */
  attachTerrain(room: Room, spec: MapSpec): void {
    const roomName = room.name;
    // No spec.terrain → the room plays on the default field. Rotation can
    // land on a terrain-less map after a terrain one, so reverting matters.
    // heightScale wraps the bytes (default field included) via hmScaled —
    // the shared field object is never mutated.
    const scale = spec.heightScale ?? 1;
    const wscale = spec.tileSize;
    const def = () => Promise.resolve(this.host.field()).then(f => f && hmScaled(f, scale, wscale));
    const target = spec.terrain ? this.loadField(spec.terrain, scale, wscale) : def();
    target.then(f => {
      if (!f || this.host.rooms.get(roomName) !== room) return;
      room.field = f;
      room.ballSim.attachField(f);
      room.moveSim.attachField(f, (pid) => room.players.getPlayer(pid)?.position);
      room.projectiles.attachField(f);
      // Flag homes were snapped in the ctor against whatever field the
      // host had then (often null) — re-snap now that the real one is in.
      room.refreshFlagHomes();
      logger.info('Room terrain attached', { room: roomName, terrain: spec.terrain ?? 'default' });
    });
  }

  /** Resolve-or-create a room. Joins may name any room; 'default' is the
   *  unnamed lobby every existing client already lands in. `mode` is only
   *  honored at creation — the first joiner defines the match. */
  roomFor(name: string, mode = '', map = '', bots?: number, unlisted = false): Room {
    let room = this.host.rooms.get(name);
    if (!room) {
      const { spec, src } = this.host.maps.specFor(name, mode, map, bots);
      this.host.maps.noteSource(name, src);
      room = new Room(name, this.host.field(), mode, spec, CONFIG.moveAuthority);
      room.unlisted = unlisted;
      room.sessions = this.host.sessions;
      room.mapSrc = src; // spec source filename — scoreboard map title fallback
      // `room` is a mutable let — bind a const for the closures or TS
      // widens them back to Room | undefined.
      const r = room;
      room.onMatchEnd = (rec) => this.host.recordEnd(rec);
      // Judge mode counts divergences instead of correcting — the kick
      // only fires on repeated teleport-scale gaps honest drift can't
      // reach (see RoomMoveSim.SEVERE_*).
      room.moveSim.onCheat = (pid, dist) => {
        logger.warn('Movement cheat detected', { playerId: pid, room: r.name, dist: +dist.toFixed(1) });
        // Warn instead of kick — flap/reconnect catch-up reports read as
        // teleport-scale divergence, and a kick loop punishes honest lag.
        r.sendToPlayer(pid, { type: 'serverWarn', text: 'SUSPICIOUS BEHAVIOR DETECTED' });
      };
      room.onRotate = () => this.host.maps.nextRotationSpec(r);
      room.onTerrain = (s) => this.attachTerrain(r, s);
      if (spec?.terrain || spec?.heightScale || spec?.tileSize) this.attachTerrain(room, spec);
      this.host.rooms.set(name, room);
      logger.info('Room created', { room: name, mode: room.mode });
    }
    return room;
  }

  /** Quick-join: pick the emptiest open room already running `mode`
   *  (and `map` when given), else spin up `<map|mode>-N`. `bots`
   *  overrides the spec's bot count/botFill on creation only. */
  quickRoom(mode: string, map = '', bots?: number): Room {
    let best: Room | undefined;
    for (const room of this.host.rooms.values()) {
      // Map and mode are independent filters — a peaks-ctf room must not
      // absorb a peaks-dm quick-join just because the map matches.
      if (map && this.host.maps.mapNameOf(room.name) !== map) continue;
      if (mode && room.mode !== mode) continue;
      if (room.playerCount() >= CONFIG.maxPlayers) continue;
      if (room.unlisted) continue;
      if (!best || room.playerCount() < best.playerCount()) best = room;
    }
    if (best) return best;
    const base = map || mode || 'arena';
    let n = 1;
    while (this.host.rooms.has(`${base}-${n}`)) n++;
    return this.roomFor(`${base}-${n}`, mode, map, bots);
  }
}
