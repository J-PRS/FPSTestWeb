/**
 * roomFactory - room resolve-or-create: spec resolution, Room wiring
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
import type { RoomMods } from '../../shared/protocol.ts';
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
      // Creatures sweep the same field — without this their step()
      // early-returns forever on spec.terrain rooms (the GameServer
      // default-field fallback only covers rooms with no spec terrain).
      room.creatureSim.attachField(f);
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
    }).finally((): void => {
      // Deferred bot seats — populated here (still ahead of deferred
      // human joins, which hook the same promise later) or on a failed
      // load, where groundAt=0 reproduces the old authored-anchor seat.
      room.populateDeferredBots();
      if (room.terrainReady === target) {room.terrainReady = null;}
    });
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
  roomFor(name: string, mode = '', map = '', bots?: number, mods: RoomMods = {}): Room | null {
    // Server policy beats client requests: gates only tighten unless the operator opted in.
    const unlisted = mods.unlisted === true;
    const noCreatures = mods.noCreatures === true || !CONFIG.allowCreatures;
    const noBalls = mods.noBalls === true || !CONFIG.allowBalls;
    const instagib = mods.instagib === true;
    // igun implies gungame (roomModsOf already normalized, belt-and-
    // suspenders for direct callers); instagib and gungame are mutually
    // exclusive - a railgun-only whitelist can't host an 18-rung ladder.
    const gungame = !instagib && mods.gungame === true;
    const igun = gungame && mods.igun === true;
    let room = this.host.rooms.get(name);
    // A bot-only room's mode is first-joiner residue, not someone's
    // match — a hosted 'ctf' landing in a stale 'nuggets' room would
    // otherwise be absorbed with only a warn toast. No humans and no
    // spectators means nothing is lost: remint under the asked mode.
    if (room && mode && room.mode !== mode && !room.standing &&
        room.players.getHumanCount() === 0 && room.spectators.size === 0) {
      room.dispose();
      this.host.rooms.delete(name);
      this.host.forgetRoom(name);
      logger.info('Bot-only room reminted for hosted mode', { room: name, was: room.mode, mode });
      room = undefined;
    }
    if (!room) {
      // The cap bounds join-driven room growth only — operator-authored
      // standing lobbies (duel-1, headhunt-1) are seeded at boot and can
      // never be recycled, so counting them would fill a low cap with
      // rooms that reject every user mint.
      let joinRooms = 0;
      for (const r of this.host.rooms.values()) {if (!r.standing) {joinRooms += 1;}}
      if (joinRooms >= CONFIG.maxRooms) {
        for (const [n, r] of this.host.rooms) {
          if (r.standing) {continue;} // standing lobbies never recycle
          if (r.players.getHumanCount() > 0 || r.spectators.size > 0) {continue;}
          r.dispose();
          this.host.rooms.delete(n);
          this.host.forgetRoom(n);
          logger.warn('Room cap recycled idle room', { room: n });
          break;
        }
        joinRooms = 0;
        for (const r of this.host.rooms.values()) {if (!r.standing) {joinRooms += 1;}}
        if (joinRooms >= CONFIG.maxRooms) {
          logger.warn('Room mint rejected: all rooms live', { wanted: name });
          return null;
        }
      }
      const { spec, src } = this.host.maps.specFor(name, mode, map, bots);
      this.host.maps.noteSource(name, src);
      // Mint + record the room seed — production rooms replay their draw
      // stream; ambient entropy at mint is fine (it's recorded, not drawn
      // inside the sim).
      // deferBots: a spec that needs an async terrain attach seats its
      // bots pre-field — their spawn pick lifts via groundAt, which reads
      // 0 until the field lands (buried announces + unbury warps).
      const needsAttach = Boolean(spec?.terrain || spec?.heightScale || spec?.tileSize);
      room = new Room(name, this.host.field(), mode, spec, CONFIG.moveAuthority,
        (Math.random() * 0x1_00_00_00_00) >>> 0, needsAttach);
      // The ctor already seeded populations (mods default empty) — the
      // gates apply post-ctor and on later applySpec reloads.
      room.mods = {};
      if (unlisted) {room.mods.unlisted = true;}
      if (noCreatures) {room.mods.noCreatures = true;}
      if (noBalls) {room.mods.noBalls = true;}
      if (instagib) {room.mods.instagib = true;}
      if (gungame) {room.mods.gungame = true;}
      if (igun) {room.mods.igun = true;}
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
      if (needsAttach && spec) {this.attachTerrain(room, spec);}
      this.host.rooms.set(name, room);
      logger.info('Room created', { room: name, mode: room.mode });
    } else if ((room.mods.noBalls === true) !== noBalls || (room.mods.noCreatures === true) !== noCreatures
        || (room.mods.instagib === true) !== instagib
        || (room.mods.gungame === true) !== gungame || (room.mods.igun === true) !== igun) {
      if (room.players.getHumanCount() === 0) {
        // No human contradicts the joiner's gates — a bot-only room just
        // adopts them instead of warning. Same post-ctor gate writes the
        // mint path runs, plus culling the populations already alive.
        room.mods.noBalls = noBalls || undefined;
        room.mods.noCreatures = noCreatures || undefined;
        room.mods.instagib = instagib || undefined;
        room.mods.gungame = gungame || undefined;
        room.mods.igun = igun || undefined;
        if (noCreatures) {
          room.creatureSim.pops = {};
          room.creatureSim.cullAll();
        }
        if (noBalls) {
          room.ballSim.population = { base: 0, perPlayer: 0, max: 0 };
          room.ballSim.cullAll();
        }
        logger.info('Bot-only room adopted joiner sim gates', {
          room: name, noBalls, noCreatures, instagib, gungame, igun,
        });
      } else {
        // First joiner defines the sim gates — callers warn their joiner.
        logger.warn('Join sim gates differ from room', {
          room: name, wantNoBalls: noBalls, wantNoCreatures: noCreatures,
          roomNoBalls: room.mods.noBalls === true, roomNoCreatures: room.mods.noCreatures === true,
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
  quickRoom(mode: string, map = '', bots?: number, mods: RoomMods = {}, preferHumans = false, mayMint = true): Room | null {
    const noCreatures = mods.noCreatures === true;
    const noBalls = mods.noBalls === true;
    const instagib = mods.instagib === true;
    const gungame = !instagib && mods.gungame === true;
    const igun = gungame && mods.igun === true;
    let best: Room | undefined = undefined;
    let bestHumans = -1;
    for (const room of this.host.rooms.values()) {
      // Map and mode are independent filters — a peaks-ctf room must not
      // absorb a peaks-dm quick-join just because the map matches.
      if (map && this.host.maps.mapNameOf(room.name) !== map) {continue;}
      if (mode && room.mode !== mode) {continue;}
      // The sim gates are part of the match a joiner asked for — picking a
      // balled room for a no-balls joiner silently ignores the toggle
      // (first joiner defines, so a wrong-gated room can never be fixed).
      // One-directional: the flags only ever assert OFF, so an unasked
      // joiner (both false) lands in whatever room is live - standing
      // lobbies seed gated-off for cost, and exact-match would refuse
      // every bare join the moment minting is denied.
      if ((noBalls && room.mods.noBalls !== true) || (noCreatures && room.mods.noCreatures !== true)) {continue;}
      // Instagib/gun-game are hard room properties, not preferences - a
      // normal room can never become one (or vice versa) mid-match.
      if (instagib !== (room.mods.instagib === true)
          || gungame !== (room.mods.gungame === true) || igun !== (room.mods.igun === true)) {continue;}
      if (room.playerCount() >= room.maxPlayers) {continue;}
      if (room.mods.unlisted === true) {continue;}
      // humans=1 — /quickjoin wants a live match: the busiest room with
      // humans in it, falling back to the plain emptiest pick when every
      // room is bots-only.
      if (preferHumans) {
        const h = room.players.getHumanCount();
        if (h === 0) {continue;}
        // Humans first, total players breaks ties — the fullest live
        // room wins, so joins consolidate into ONE match instead of
        // splitting into twin half-empty headhunt-N rooms.
        if (h > bestHumans || (h === bestHumans && best && room.playerCount() > best.playerCount())) {best = room; bestHumans = h;}
        continue;
      }
      if (!best || room.playerCount() > best.playerCount()) {best = room;}
    }
    if (preferHumans && bestHumans < 0) {return this.quickRoom(mode, map, bots, mods, false, mayMint);}
    if (best) {return best;}
    // Public deploys deny mints to untrusted traffic - the join falls back
    // to the caller's no-mint retry or 'Server full' instead of growing
    // the room set per request param.
    if (!mayMint) {return null;}
    // Empty-server join still lands in a REAL match — pick the busiest
    // room (liveliest, not emptiest); if none exists, mint on the
    // default map so the joiner never gets a spec-less arena with
    // maps/null terrain.
    // Rooms are mode-named, not map-named: the rotation walks maps INSIDE
    // a room, so 'headhunt-1' reads true after a map swap where 'rimrock-1'
    // lies (it's headhunt on caldera now). Mode empty → the map name is
    // the room's identity until a hosted mode claim lands.
    const mintMap = map || this.host.maps.defaultMap();
    // Bare /join sends no mode — the standing-room default is headhunt;
    // a named mode still wins outright.
    const specMode = mode || 'headhunt';
    const base = specMode || mintMap || 'arena';
    // Room names list fleet-wide but mint worker-local — stride the
    // counter per worker so each names its own (-1/-4/-7 on w0,
    // -2/-5/-8 on w1…) and the aggregated /rooms can't collide.
    const wIdx = Number(process.env.FPS_WORKER_ID?.replace(/^w/, '') ?? 0) || 0;
    const wCnt = Math.max(1, Number(process.env.FPS_WORKERS ?? 1) || 1);
    let n = wIdx + 1;
    while (this.host.rooms.has(`${base}-${n}`)) {n += wCnt;}
    return this.roomFor(`${base}-${n}`, specMode, mintMap, bots, mods);
  }
}
