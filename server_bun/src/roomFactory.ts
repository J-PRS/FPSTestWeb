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
import type { SessionRegistry } from './sessionRegistry.ts';
import { ResultSigner, SIGN_SECRET, nextMatchId } from './resultSigner.ts';

export interface RoomFactoryHost {
  /** Live room index — created rooms register here before returning. */
  rooms: Map<string, Room>;
  /** Session lifecycle owner — rooms read grace state through it. */
  sessions: SessionRegistry;
  maps: MapCatalog;
  /** Shared default field (null until the boot heightmap lands). */
  field(): Heightfield | null;
  /** A completed match's record → journal. */
  recordEnd(rec: Parameters<NonNullable<Room['onMatchEnd']>>[0]): void;
  /** Movement-judge cheat verdict → disconnect the player. */
  kickPlayer(playerId: string): boolean;
  /** Name-keyed tick fault state dies with the room — a reminted name
   *  must not inherit the corpse's error streak. */
  forgetRoom(name: string): void;
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
            .then((ab): Heightfield => BallSim.parseHeightmap(new Uint8Array(ab), heightScale, worldScale))
            .catch((error): null => { logger.warn('map terrain load failed', { file, err: String(error) }); return null; })
        : Promise.resolve(null);
      this.fields.set(key, p);
    }
    return p;
  }

  /** Drop a terrain file's cached field (all scale variants) — a
   *  .bin edited under the same name otherwise survives reloadRoom,
   *  since the cache keys on file@scale, not content. */
  invalidateField(terrain: string): void {
    for (const key of this.fields.keys()) {
      if (key.startsWith(`${terrain}@`)) {this.fields.delete(key);}
    }
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
    const def = (): Promise<Heightfield | null> => Promise.resolve(this.host.field()).then((f): Heightfield | null => f && hmScaled(f, scale, wscale));
    const target = spec.terrain ? this.loadField(spec.terrain, scale, wscale) : def();
    // Seat deferral reads this: a joiner arriving mid-swap would pick a
    // spawn against groundAt()=0 (no field) — an authored anchor y under
    // the real surface. Joins wait out the load (ms) instead.
    room.terrainReady = target;
    target.then((f): void => {
      if (!f || this.host.rooms.get(roomName) !== room) {return;}
      room.field = f;
      room.ballSim.attachField(f);
      room.moveSim.attachField(f, (pid) => room.players.getPlayer(pid)?.position);
      room.projectiles.attachField(f);
      // Flag homes were snapped in the ctor against whatever field the
      // host had then (often null) — re-snap now that the real one is in.
      room.refreshFlagHomes();
      // Join seats picked pre-field kept authored anchor y — buried.
      // Lift them now; the alternative is every first-joiner paying a
      // 40m+ correction snap on a terrain map.
      room.unburySeats();
      logger.info('Room terrain attached', { room: roomName, terrain: spec.terrain ?? 'default' });
    return; }).catch((error): void => {
      // Room stays up on the null field rather than crashing the boot —
      // without this log a bad terrain file reads as invisible terrain.
      logger.warn('Room terrain load failed — running without heightfield', { room: roomName, error });
    }).finally((): void => { if (room.terrainReady === target) {room.terrainReady = null;} });
  }

  /** Resolve-or-create a room. Joins may name any room; 'default' is the
   *  unnamed lobby every existing client already lands in. `mode` is only
   *  honored at creation — the first joiner defines the match.
   *  Room minting is join-driven — a script cycling fresh names grows
   *  `rooms` forever (hibernation kills the sim cost, not the memory or
   *  the per-tick map iteration). Past the cap, recycle the eldest room
   *  with no human audience: an empty or bot-only room loses nothing,
   *  its name just remints on the next join. Returns null only when
   *  every live room is occupied — the caller rejects the join. */
  roomFor(name: string, mode = '', map = '', bots?: number, unlisted = false, noCreatures = false, noBalls = false): Room | null {
    let room = this.host.rooms.get(name);
    // A bot-only room's mode is first-joiner residue, not someone's
    // match — a hosted 'ctf' landing in a stale 'nuggets' room would
    // otherwise be absorbed with only a warn toast. No humans and no
    // spectators means nothing is lost: remint under the asked mode.
    if (room && mode && room.mode !== mode &&
        room.players.getHumanCount() === 0 && room.spectators.size === 0) {
      room.dispose();
      this.host.rooms.delete(name);
      this.host.forgetRoom(name);
      logger.info('Bot-only room reminted for hosted mode', { room: name, was: room.mode, mode });
      room = undefined;
    }
    if (!room) {
      if (this.host.rooms.size >= CONFIG.maxRooms) {
        for (const [n, r] of this.host.rooms) {
          if (r.players.getHumanCount() > 0 || r.spectators.size > 0) {continue;}
          r.dispose();
          this.host.rooms.delete(n);
          this.host.forgetRoom(n);
          logger.warn('Room cap recycled idle room', { room: n });
          break;
        }
        if (this.host.rooms.size >= CONFIG.maxRooms) {
          logger.warn('Room mint rejected: all rooms live', { wanted: name });
          return null;
        }
      }
      const { spec, src } = this.host.maps.specFor(name, mode, map, bots);
      this.host.maps.noteSource(name, src);
      // Mint + record the room seed — production rooms replay their draw
      // stream; ambient entropy at mint is fine (it's recorded, not drawn
      // inside the sim).
      room = new Room(name, this.host.field(), mode, spec, CONFIG.moveAuthority,
        (Math.random() * 0x1_00_00_00_00) >>> 0);
      room.unlisted = unlisted;
      // The ctor already seeded populations (fields default false) — the
      // gates apply post-ctor and on later applySpec reloads.
      room.noCreatures = noCreatures;
      room.noBalls = noBalls;
      if (noCreatures) {room.creatureSim.pops = {};}
      if (noBalls) {room.ballSim.population = { base: 0, perPlayer: 0, max: 0 };}
      room.sessions = this.host.sessions;
      room.mapSrc = src; // spec source filename — scoreboard map title fallback
      // `room` is a mutable let — bind a const for the closures or TS
      // widens them back to Room | undefined.
      const r = room;
      // Leaderboard receipt: one signer per room, fed by every bus event.
      // mint() at matchEnd carries the whole match's outcome chain.
      r.resultSigner = new ResultSigner(SIGN_SECRET, () => nextMatchId(r.name));
      r.events.on((e): void => { r.resultSigner?.feed(e); });
      room.onMatchEnd = (rec): void => this.host.recordEnd(rec);
      // Judge mode counts divergences instead of correcting — the kick
      // only fires on repeated teleport-scale gaps honest drift can't
      // reach (see RoomMoveSim.SEVERE_*).
      room.moveSim.onCheat = (pid, dist, detail): void => {
        logger.warn('Movement cheat detected', Object.assign({}, {playerId: pid,room: r.name,dist: Number(dist.toFixed(1))}, detail));
        // Warn instead of kick — flap/reconnect catch-up reports read as
        // teleport-scale divergence, and a kick loop punishes honest lag.
        r.sendToPlayer(pid, { type: 'serverWarn', text: 'SUSPICIOUS BEHAVIOR DETECTED' });
      };
      room.onRotate = (): MapSpec | null => this.host.maps.nextRotationSpec(r);
      room.onTerrain = (s): void => this.attachTerrain(r, s);
      if (spec?.terrain || spec?.heightScale || spec?.tileSize) {this.attachTerrain(room, spec);}
      this.host.rooms.set(name, room);
      logger.info('Room created', { room: name, mode: room.mode });
    } else if (room.noBalls !== noBalls || room.noCreatures !== noCreatures) {
      if (room.players.getHumanCount() === 0) {
        // No human contradicts the joiner's gates — a bot-only room just
        // adopts them instead of warning. Same post-ctor gate writes the
        // mint path runs, plus culling the populations already alive.
        room.noBalls = noBalls;
        room.noCreatures = noCreatures;
        if (noCreatures) {
          room.creatureSim.pops = {};
          room.creatureSim.cullAll();
        }
        if (noBalls) {
          room.ballSim.population = { base: 0, perPlayer: 0, max: 0 };
          room.ballSim.cullAll();
        }
        logger.info('Bot-only room adopted joiner sim gates', {
          room: name, noBalls, noCreatures,
        });
      } else {
        // First joiner defines the sim gates — callers warn their joiner.
        logger.warn('Join sim gates differ from room', {
          room: name, wantNoBalls: noBalls, wantNoCreatures: noCreatures,
          roomNoBalls: room.noBalls, roomNoCreatures: room.noCreatures,
        });
      }
    }
    return room;
  }

  /** Quick-join: pick the emptiest open room already running `mode`
   *  (and `map` when given), else spin up `<map|mode>-N`. `bots`
   *  overrides the spec's bot count/botFill on creation only. The sim
   *  gates must ride the mint too — joining the freshly picked name
   *  with noBalls afterwards is a no-op (first joiner defines), so a
   *  bare quickRoom would silently ignore the host's toggles. */
  quickRoom(mode: string, map = '', bots?: number, noCreatures = false, noBalls = false): Room | null {
    let best: Room | undefined = undefined;
    for (const room of this.host.rooms.values()) {
      // Map and mode are independent filters — a peaks-ctf room must not
      // absorb a peaks-dm quick-join just because the map matches.
      if (map && this.host.maps.mapNameOf(room.name) !== map) {continue;}
      if (mode && room.mode !== mode) {continue;}
      // The sim gates are part of the match a joiner asked for — picking a
      // balled room for a no-balls joiner silently ignores the toggle
      // (first joiner defines, so a wrong-gated room can never be fixed).
      if (room.noBalls !== noBalls || room.noCreatures !== noCreatures) {continue;}
      if (room.playerCount() >= CONFIG.maxPlayers) {continue;}
      if (room.unlisted) {continue;}
      if (!best || room.playerCount() < best.playerCount()) {best = room;}
    }
    if (best) {return best;}
    const base = map || mode || 'arena';
    let n = 1;
    while (this.host.rooms.has(`${base}-${n}`)) {n += 1;}
    return this.roomFor(`${base}-${n}`, mode, map, bots, false, noCreatures, noBalls);
  }
}
