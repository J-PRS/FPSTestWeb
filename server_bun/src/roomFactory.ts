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
  /** Live room index - created rooms register here before returning. */
  rooms: Map<string, Room>;
  /** Session lifecycle owner - rooms read grace state through it. */
  sessions: SessionRegistry;
  maps: MapCatalog;
  /** Shared default field (null until the boot heightmap lands). */
  field(): Heightfield | null;
  /** A completed match's record → journal. */
  recordEnd(rec: Parameters<NonNullable<Room['onMatchEnd']>>[0]): void;
  /** Movement-judge cheat verdict → disconnect the player. */
  kickPlayer(playerId: string): boolean;
  /** Name-keyed tick fault state dies with the room - a reminted name
   *  must not inherit the corpse's error streak. */
  forgetRoom(name: string): void;
}

/** The normalized sim-gate set a joiner asked for (server policy folded). */
interface RoomGates {
  unlisted: boolean; noCreatures: boolean; noBalls: boolean;
  instagib: boolean; gungame: boolean; igun: boolean;
}

export class RoomFactory {
  constructor(private host: RoomFactoryHost) {}

  // Per-map terrain: spec.terrain names a maps/<file>.bin heightfield;
  // files are shared across rooms via this cache and attach when ready -
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

  /** Drop a terrain file's cached field (all scale variants) - a
   *  .bin edited under the same name otherwise survives reloadRoom,
   *  since the cache keys on file@scale, not content. */
  invalidateField(terrain: string): void {
    for (const key of this.fields.keys()) {
      if (key.startsWith(`${terrain}@`)) {this.fields.delete(key);}
    }
  }

  /** Attach a spec's terrain to every room sim that sweeps it - missing
   *  one means two systems disagree about where the ground is. */
  attachTerrain(room: Room, spec: MapSpec): void {
    const roomName = room.name;
    // No spec.terrain → the room plays on the default field. Rotation can
    // land on a terrain-less map after a terrain one, so reverting matters.
    // heightScale wraps the bytes (default field included) via hmScaled -
    // the shared field object is never mutated.
    const scale = spec.heightScale ?? 1;
    const wscale = spec.tileSize;
    const def = (): Promise<Heightfield | null> => Promise.resolve(this.host.field()).then((f): Heightfield | null => f && hmScaled(f, scale, wscale));
    const target = spec.terrain ? this.loadField(spec.terrain, scale, wscale) : def();
    // Seat deferral reads this: a joiner arriving mid-swap would pick a
    // spawn against groundAt()=0 (no field) - an authored anchor y under
    // the real surface. Joins wait out the load (ms) instead.
    room.terrainReady = target;
    target.then((f): void => {
      if (!f || this.host.rooms.get(roomName) !== room) {return;}
      room.field = f;
      room.ballSim.attachField(f);
      room.moveSim.attachField(f, (pid) => room.players.getPlayer(pid)?.position);
      room.projectiles.attachField(f);
      // Creatures sweep the same field - without this their step()
      // early-returns forever on spec.terrain rooms (the GameServer
      // default-field fallback only covers rooms with no spec terrain).
      room.creatureSim.attachField(f);
      // Flag homes were snapped in the ctor against whatever field the
      // host had then (often null) - re-snap now that the real one is in.
      room.refreshFlagHomes();
      // Join seats picked pre-field kept authored anchor y - buried.
      // Lift them now; the alternative is every first-joiner paying a
      // 40m+ correction snap on a terrain map.
      room.unburySeats();
      logger.info('Room terrain attached', { room: roomName, terrain: spec.terrain ?? 'default' });
    return; }).catch((error): void => {
      // Room stays up on the null field rather than crashing the boot -
      // without this log a bad terrain file reads as invisible terrain.
      logger.warn('Room terrain load failed - running without heightfield', { room: roomName, error });
    }).finally((): void => {
      // Deferred bot seats - populated here (still ahead of deferred
      // human joins, which hook the same promise later) or on a failed
      // load, where groundAt=0 reproduces the old authored-anchor seat.
      room.populateDeferredBots();
      if (room.terrainReady === target) {room.terrainReady = null;}
    });
  }

  /** Resolve-or-create a room. Joins may name any room; 'default' is the
   *  unnamed lobby every existing client already lands in. `mode` is only
   *  honored at creation - the first joiner defines the match.
   *  Room minting is join-driven - a script cycling fresh names grows
   *  `rooms` forever (hibernation kills the sim cost, not the memory or
   *  the per-tick map iteration). Past the cap, recycle the eldest room
   *  with no human audience: an empty or bot-only room loses nothing,
   *  its name just remints on the next join. Returns null only when
   *  every live room is occupied - the caller rejects the join. */
  roomFor(name: string, mode = '', map = '', bots?: number, mods: RoomMods = {}): Room | null {
    const gates = RoomFactory.gateMods(mods);
    let room = this.host.rooms.get(name);
    // A bot-only room's mode is first-joiner residue, not someone's
    // match - a hosted 'ctf' landing in a stale 'nuggets' room would
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
      const minted = this.mintRoom(name, mode, map, bots, gates);
      if (!minted) {return null;}
      room = minted;
    }
    else if (RoomFactory.gatesDiffer(room, gates)) {this.adoptJoinerGates(name, room, mods, gates);}
    return room;
  }

  /** Server policy beats client requests: gates only tighten unless the
   *  operator opted in. igun implies gungame (roomModsOf already
   *  normalized, belt-and-suspenders for direct callers); instagib and
   *  gungame are mutually exclusive - a railgun-only whitelist can't
   *  host an 18-rung ladder. */
  private static gateMods(mods: RoomMods): RoomGates {
    const instagib = mods.instagib === true;
    const gungame = !instagib && mods.gungame === true;
    return {
      unlisted: mods.unlisted === true,
      noCreatures: mods.noCreatures === true || !CONFIG.allowCreatures,
      noBalls: mods.noBalls === true || !CONFIG.allowBalls,
      instagib, gungame,
      igun: gungame && mods.igun === true,
    };
  }

  /** Do the live room's sim gates disagree with the joiner's ask? */
  private static gatesDiffer(room: Room, g: RoomGates): boolean {
    return (room.mods.noBalls === true) !== g.noBalls || (room.mods.noCreatures === true) !== g.noCreatures
        || (room.mods.instagib === true) !== g.instagib
        || (room.mods.gungame === true) !== g.gungame || (room.mods.igun === true) !== g.igun;
  }

  /** Room-cap enforcement: past the cap, recycle the eldest room with no
   *  human audience (standing lobbies never recycle). Returns false when
   *  every live room is occupied - the caller rejects the join. */
  private makeRoomForMint(name: string): boolean {
    // The cap bounds join-driven room growth only - operator-authored
    // standing lobbies (duel-1, headhunt-1) are seeded at boot and can
    // never be recycled, so counting them would fill a low cap with
    // rooms that reject every user mint.
    let joinRooms = 0;
    for (const r of this.host.rooms.values()) {if (!r.standing) {joinRooms += 1;}}
    if (joinRooms < CONFIG.maxRooms) {return true;}
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
      return false;
    }
    return true;
  }

  /** The mint path: spec resolve, Room ctor, gate fold, wiring. */
  private mintRoom(name: string, mode: string, map: string, bots: number | undefined, gates: RoomGates): Room | null {
    if (!this.makeRoomForMint(name)) {return null;}
    const { spec, src } = this.host.maps.specFor(name, mode, map, bots);
    this.host.maps.noteSource(name, src);
    // Mint + record the room seed - production rooms replay their draw
    // stream; ambient entropy at mint is fine (it's recorded, not drawn
    // inside the sim).
    // deferBots: a spec that needs an async terrain attach seats its
    // bots pre-field - their spawn pick lifts via groundAt, which reads
    // 0 until the field lands (buried announces + unbury warps).
    const needsAttach = Boolean(spec?.terrain || spec?.heightScale || spec?.tileSize);
    const room = new Room(name, this.host.field(), mode, spec, { moveAuthority: CONFIG.moveAuthority,
      seed: Math.trunc(Math.random() * 0x1_00_00_00_00), deferBots: needsAttach });
    this.applyGates(room, spec, gates);
    room.sessions = this.host.sessions;
    room.mapSrc = src; // spec source filename - scoreboard map title fallback
    // Leaderboard receipt: one signer per room, fed by every bus event.
    // mint() at matchEnd carries the whole match's outcome chain.
    room.resultSigner = new ResultSigner(SIGN_SECRET, () => nextMatchId(room.name));
    room.events.on((e): void => { room.resultSigner?.feed(e); });
    room.onMatchEnd = (rec): void => this.host.recordEnd(rec);
    // Judge mode counts divergences instead of correcting - the kick
    // only fires on repeated teleport-scale gaps honest drift can't
    // reach (see RoomMoveSim.SEVERE_*).
    room.moveSim.onCheat = (pid, dist, detail): void => {
      logger.warn('Movement cheat detected', Object.assign({}, {playerId: pid,room: room.name,dist: Number(dist.toFixed(1))}, detail));
      // Warn instead of kick - flap/reconnect catch-up reports read as
      // teleport-scale divergence, and a kick loop punishes honest lag.
      room.sendToPlayer(pid, { type: 'serverWarn', text: 'SUSPICIOUS BEHAVIOR DETECTED' });
    };
    room.onRotate = (): MapSpec | null => this.host.maps.nextRotationSpec(room);
    room.onTerrain = (s): void => this.attachTerrain(room, s);
    if (needsAttach && spec) {this.attachTerrain(room, spec);}
    this.host.rooms.set(name, room);
    logger.info('Room created', { room: name, mode: room.mode });
    return room;
  }

  /** Post-ctor sim-gate fold. The ctor already seeded populations (mods
   *  default empty) - the gates apply here and on later applySpec
   *  reloads. Spec-declared modifiers fold in with the join-spec ones -
   *  that's how a `standing` map mints an igun/gungame room, since its
   *  mint path (standingRooms -> roomFor(name)) carries no join spec. */
  private applyGates(room: Room, spec: MapSpec | undefined, gates: RoomGates): void {
    const gg = gates.gungame || spec?.gungame === true || spec?.igun === true;
    const ig = gg && (gates.igun || spec?.igun === true);
    room.mods = {};
    if (gates.unlisted) {room.mods.unlisted = true;}
    if (gates.noCreatures) {room.mods.noCreatures = true; room.creatureSim.pops = {};}
    if (gates.noBalls) {room.mods.noBalls = true; room.ballSim.population = { base: 0, perPlayer: 0, max: 0 };}
    if (gates.instagib) {room.mods.instagib = true;}
    if (gg) {room.mods.gungame = true;}
    if (ig) {room.mods.igun = true;}
  }

  /** A live room whose sim gates differ from the joiner's ask: bot-only
   *  rooms adopt the gates outright; occupied/standing rooms warn. */
  private adoptJoinerGates(name: string, room: Room, mods: RoomMods, g: RoomGates): void {
    // Standing rooms are operator-authored - a bare join request
    // (mods={}) must not wipe spec-declared gates like igun/gungame
    // that the mint path folded in.
    if (!room.standing && room.players.getHumanCount() === 0) {
      // No human contradicts the joiner's gates - a bot-only room just
      // adopts them instead of warning. Same post-ctor gate writes the
      // mint path runs, plus culling the populations already alive.
      room.mods.noBalls = g.noBalls || undefined;
      room.mods.noCreatures = g.noCreatures || undefined;
      room.mods.instagib = g.instagib || undefined;
      room.mods.gungame = g.gungame || undefined;
      room.mods.igun = g.igun || undefined;
      if (g.noCreatures) {
        room.creatureSim.pops = {};
        room.creatureSim.cullAll();
      }
      if (g.noBalls) {
        room.ballSim.population = { base: 0, perPlayer: 0, max: 0 };
        room.ballSim.cullAll();
      }
      logger.info('Bot-only room adopted joiner sim gates', {
        room: name, noBalls: g.noBalls, noCreatures: g.noCreatures, instagib: g.instagib, gungame: g.gungame, igun: g.igun,
      });
      return;
    }
    if (mods.noBalls !== true && mods.noCreatures !== true && mods.instagib !== true
        && mods.gungame !== true && mods.igun !== true) {return;}
    // First joiner defines the sim gates - callers warn their joiner,
    // but only when they ASKED for gates. A bare join (mods={}) to a
    // modded standing room declares nothing and just plays its rules -
    // warning on it spams every /s/ join to igunffa-1.
    logger.warn('Join sim gates differ from room', {
      room: name, wantNoBalls: g.noBalls, wantNoCreatures: g.noCreatures,
      wantInstagib: g.instagib, wantGungame: g.gungame, wantIgun: g.igun,
      roomNoBalls: room.mods.noBalls === true, roomNoCreatures: room.mods.noCreatures === true,
      roomInstagib: room.mods.instagib === true, roomGungame: room.mods.gungame === true, roomIgun: room.mods.igun === true,
      standing: room.standing === true,
    });
  }

  /** Quick-join: pick the emptiest open room already running `mode`
   *  (and `map` when given), else spin up `<map|mode>-N`. `bots`
   *  overrides the spec's bot count/botFill on creation only. The sim
   *  gates must ride the mint too - joining the freshly picked name
   *  with noBalls afterwards is a no-op (first joiner defines), so a
   *  bare quickRoom would silently ignore the host's toggles. */
  quickRoom(mode: string, map = '', bots?: number, mods: RoomMods = {}, preferHumans = false, mayMint = true): Room | null {
    const instagib = mods.instagib === true;
    const gungame = !instagib && mods.gungame === true;
    // Quick-join gates normalize WITHOUT the CONFIG folds roomFor uses -
    // an unasked joiner (flags false) must land in whatever room is live.
    const g: RoomGates = { unlisted: false, noCreatures: mods.noCreatures === true, noBalls: mods.noBalls === true,
      instagib, gungame, igun: gungame && mods.igun === true };
    const { best, bestHumans } = this.quickScan(map, mode, g, preferHumans);
    if (preferHumans && bestHumans < 0) {return this.quickRoom(mode, map, bots, mods, false, mayMint);}
    if (best) {return best;}
    // Public deploys deny mints to untrusted traffic - the join falls back
    // to the caller's no-mint retry or 'Server full' instead of growing
    // the room set per request param.
    if (!mayMint) {return null;}
    return this.mintQuickRoom(mode, map, bots, mods);
  }

  /** Scan live rooms for the busiest quick-join seat. humans=1 wants a
   *  live match: the busiest room with humans in it, falling back to the
   *  plain busiest pick when every room is bots-only. */
  private quickScan(map: string, mode: string, g: RoomGates, preferHumans: boolean): { best?: Room; bestHumans: number } {
    let best: Room | undefined = undefined;
    let bestHumans = -1;
    for (const room of this.host.rooms.values()) {
      if (!this.quickFits(room, map, mode, g)) {continue;}
      if (preferHumans) {
        const h = room.players.getHumanCount();
        if (h === 0) {continue;}
        // Humans first, total players breaks ties - the fullest live
        // room wins, so joins consolidate into ONE match instead of
        // splitting into twin half-empty headhunt-N rooms.
        if (h > bestHumans || (h === bestHumans && best && room.playerCount() > best.playerCount())) {best = room; bestHumans = h;}
        continue;
      }
      if (!best || room.playerCount() > best.playerCount()) {best = room;}
    }
    return { best, bestHumans };
  }

  /** Candidate filter: map+mode are independent filters (a peaks-ctf
   *  room must not absorb a peaks-dm quick-join), the sim gates are part
   *  of the match a joiner asked for (picking a balled room for a
   *  no-balls joiner silently ignores the toggle - first joiner defines,
   *  so a wrong-gated room can never be fixed). One-directional: the
   *  flags only ever assert OFF, so an unasked joiner lands in whatever
   *  room is live. Instagib/gun-game are hard room properties, not
   *  preferences - a normal room can never become one mid-match. */
  private quickFits(room: Room, map: string, mode: string, g: RoomGates): boolean {
    if (map && this.host.maps.mapNameOf(room.name) !== map) {return false;}
    if (mode && room.mode !== mode) {return false;}
    if ((g.noBalls && room.mods.noBalls !== true) || (g.noCreatures && room.mods.noCreatures !== true)) {return false;}
    if (g.instagib !== (room.mods.instagib === true)
        || g.gungame !== (room.mods.gungame === true) || g.igun !== (room.mods.igun === true)) {return false;}
    if (room.playerCount() >= room.maxPlayers) {return false;}
    return room.mods.unlisted !== true;
  }

  /** The mint path when no live room fits: mode-named base + worker-
   *  strided counter. Empty-server join still lands in a REAL match -
   *  if no room exists, mint on the default map so the joiner never
   *  gets a spec-less arena with maps/null terrain. Rooms are mode-
   *  named, not map-named: the rotation walks maps INSIDE a room, so
   *  'headhunt-1' reads true after a map swap where 'rimrock-1' lies. */
  private mintQuickRoom(mode: string, map: string, bots: number | undefined, mods: RoomMods): Room | null {
    const mintMap = map || this.host.maps.defaultMap();
    // Bare /join sends no mode - the standing-room default is headhunt;
    // a named mode still wins outright.
    const specMode = mode || 'headhunt';
    const base = specMode || mintMap || 'arena';
    // Room names list fleet-wide but mint worker-local - stride the
    // counter per worker so each names its own (-1/-4/-7 on w0,
    // -2/-5/-8 on w1…) and the aggregated /rooms can't collide.
    const wIdx = Number(process.env.FPS_WORKER_ID?.replace(/^w/, '') ?? 0) || 0;
    const wCnt = Math.max(1, Number(process.env.FPS_WORKERS ?? 1) || 1);
    let n = wIdx + 1;
    while (this.host.rooms.has(`${base}-${n}`)) {n += wCnt;}
    return this.roomFor(`${base}-${n}`, specMode, mintMap, bots, mods);
  }
}
