import type { ServerWebSocket, Server } from 'bun';
import { CONFIG } from './config.ts';
import { Room } from './Room.ts';
import { BallSim } from './BallSim.ts';
import { validateMessage } from './validation.ts';
import type { WebSocketData } from './types.ts';
import { logger } from './logger.ts';
import { fileURLToPath } from 'node:url';
import type { Heightfield } from '../../shared/heightfield.ts';
import { isWireFrame, decodePosition } from '../../shared/wire.ts';
import { TickLoop } from './TickLoop.ts';
import { SessionManager } from './SessionManager.ts';
import { readFileSync, appendFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { type MapSpec, resolveMapSpec } from '../../shared/mapSpec.ts';

export class GameServer {
  // One match's state per room — players land in 'default' unless the join
  // handshake names a room. Everything per-match (players, sockets, ball
  // sim, tick bookkeeping) lives inside Room; GameServer is the dispatcher.
  private rooms = new Map<string, Room>();
  private field: Heightfield | null = null; // shared across rooms
  private bunServer: Server<WebSocketData> | null = null;
  private readonly tickLoop: TickLoop;
  private readonly sessions: SessionManager;

  // Ops counters — cheap ints, read by /metrics. msgsIn counts everything
  // that passed validation; tick lag measures setInterval drift (the
  // server-clock skew that makes client replays overshoot).
  private ops = {
    startedAt: Date.now(),
    msgsIn: 0, msgsRejected: 0, joins: 0, leaves: 0,
    // Which netcode-v2 tier clients actually land on — the cost/perf mix
    // this deployment is paying for.
    tierWs: 0, tierWt: 0, tierRtc: 0, tierOther: 0,
    tickLagMsMax: 0, tickLagMsSum: 0, tickLagSamples: 0,
    lastTickAt: 0,
  };

  constructor() {
    // Server-owned creatures: balls are the shared-PvE pilot. A missing
    // heightmap must degrade gracefully — log and run creature-free rather
    // than take down the whole game server. The parsed field is shared by
    // every room's BallSim rather than re-read per match.
    const heightmapPath = CONFIG.heightmapPath || fileURLToPath(new URL('../heightmap.bin', import.meta.url));
    const bunFile = (globalThis as { Bun?: { file(p: string): { arrayBuffer(): Promise<ArrayBuffer> } } }).Bun?.file;
    if (bunFile) {
      bunFile(heightmapPath).arrayBuffer()
        .then(ab => {
          this.field = BallSim.parseHeightmap(new Uint8Array(ab));
          // Rooms that already exist (players joined before the load
          // finished) get the field attached now.
          for (const room of this.rooms.values()) {
            if (!room.ballSim.hasField) room.ballSim.attachField(this.field);
          }
        })
        .catch(err => logger.warn('BallSim disabled — heightmap load failed', { err: String(err) }));
    } else {
      logger.warn('BallSim disabled — not running under Bun');
    }

    // The broadcast engine — owns both timers; teardown delegates back
    // here so playerRoom/ops stay in one place.
    this.tickLoop = new TickLoop(this.rooms, this.ops, (room, id, reason) => this.removePlayerCompletely(room, id, reason));
    this.tickLoop.start();
    // SessionManager owns the join handshake: identity claims, join
    // throttle, grace-period reclaim, spectate.
    this.sessions = new SessionManager({
      rooms: this.rooms,
      playerRoom: this.playerRoom,
      specRooms: this.specRooms,
      roomFor: (n, m, mp, b) => this.roomFor(n, m, mp, b),
      roomOfPlayer: (id) => this.roomOfPlayer(id),
      totalPlayers: () => this.totalPlayers(),
      ops: this.ops,
    });
  }

  // Per-map terrain: spec.terrain names a maps/<file>.bin heightfield;
  // files are shared across rooms via this cache and attach when ready —
  // a room always plays on the default field until its own terrain lands.
  private fields = new Map<string, Promise<Heightfield | null>>();

  private loadField(file: string): Promise<Heightfield | null> {
    let p = this.fields.get(file);
    if (!p) {
      const bunFile = (globalThis as { Bun?: { file(p: string): { arrayBuffer(): Promise<ArrayBuffer> } } }).Bun?.file;
      p = bunFile
        ? bunFile(join(import.meta.dir, '..', '..', 'maps', file)).arrayBuffer()
            .then(ab => BallSim.parseHeightmap(new Uint8Array(ab)))
            .catch(err => { logger.warn('map terrain load failed', { file, err: String(err) }); return null; })
        : Promise.resolve(null);
      this.fields.set(file, p);
    }
    return p;
  }

  // Match journal — every win condition lands one JSON line on disk plus
  // a small in-memory ring for /matches. Append-only so a restart never
  // loses history; the ring is just a cheap read cache.
  private matchRing: ({ t: number; room: string; mode: string; winner: string; scores: Record<string, number> })[] = [];
  private recordMatchEnd(rec: {
    room: string; mode: string; winner: string; scores: Record<string, number>;
    players?: { id: string; team?: string; kills: number; deaths: number }[];
  }): void {
    const entry = { t: Date.now(), ...rec };
    this.matchRing.push(entry);
    if (this.matchRing.length > 100) this.matchRing.shift();
    try {
      const dir = join(import.meta.dir, '..', '..', 'logs');
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'matches.jsonl'), JSON.stringify(entry) + '\n');
    } catch (e) {
      logger.warn('Match journal write failed', { err: String(e) });
    }
  }

  /** Recent match results — newest last. */
  listMatches(): unknown[] {
    return this.matchRing;
  }

  /** Lifetime leaderboard read off the match journal — survives restarts
   *  since matches.jsonl is append-only. Read-per-request is fine at this
   *  scale; cache it if the file ever grows past a few MB. */
  async getStats(): Promise<unknown[]> {
    interface Row { playerId: string; matches: number; wins: number; kills: number; deaths: number }
    const agg = new Map<string, Row>();
    try {
      const file = Bun.file(join(import.meta.dir, '..', '..', 'logs', 'matches.jsonl'));
      const text = await file.text();
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let rec: { winner?: string; players?: { id: string; team?: string; kills?: number; deaths?: number }[] };
        try { rec = JSON.parse(line); } catch { continue; }
        for (const p of rec.players ?? []) {
          const row = agg.get(p.id) ?? { playerId: p.id, matches: 0, wins: 0, kills: 0, deaths: 0 };
          row.matches++;
          row.kills += p.kills ?? 0;
          row.deaths += p.deaths ?? 0;
          // FFA records name the player; team records name the side.
          if (rec.winner === p.id || (p.team && rec.winner === p.team)) row.wins++;
          agg.set(p.id, row);
        }
      }
    } catch { /* no journal yet — empty leaderboard */ }
    return [...agg.values()].sort((a, b) => b.wins - a.wins || b.kills - a.kills);
  }

  /** Resolve-or-create a room. Joins may name any room; 'default' is the
   *  unnamed lobby every existing client already lands in. `mode` is only
   *  honored at creation — the first joiner defines the match. */
  private roomFor(name: string, mode = '', map = '', bots?: number): Room {
    let room = this.rooms.get(name);
    if (!room) {
      let spec = this.loadMapSpec(name);
      let src = spec ? name : '';
      if (!spec && map) { spec = this.loadMapSpec(map); src = map; }
      if (!spec) { spec = this.loadMapSpec(mode); src = spec ? mode : ''; }
      if (spec && bots !== undefined) spec = { ...spec, bots, botFill: bots };
      if (src) this.roomMapName.set(name, src);
      room = new Room(name, this.field, mode, spec, CONFIG.moveAuthority);
      // `room` is a mutable let — bind a const for the closures or TS
      // widens them back to Room | undefined.
      const r = room;
      room.onMatchEnd = (rec) => this.recordMatchEnd(rec);
      room.onRotate = () => this.nextRotationSpec(r);
      room.onTerrain = (s) => this.attachTerrain(r, s);
      if (spec?.terrain) this.attachTerrain(room, spec);
      this.rooms.set(name, room);
      logger.info('Room created', { room: name, mode: room.mode });
    }
    return room;
  }

  /** Attach a spec's terrain to every room sim that sweeps it — missing
   *  one means two systems disagree about where the ground is. */
  private attachTerrain(room: Room, spec: MapSpec): void {
    const roomName = room.name;
    // No spec.terrain → the room plays on the default field. Rotation can
    // land on a terrain-less map after a terrain one, so reverting matters.
    const target = spec.terrain ? this.loadField(spec.terrain) : Promise.resolve(this.field);
    target.then(f => {
      if (!f || this.rooms.get(roomName) !== room) return;
      room.ballSim.attachField(f);
      room.moveSim.attachField(f, (pid) => room.players.getPlayer(pid)?.position);
      room.projectiles.attachField(f);
      logger.info('Room terrain attached', { room: roomName, terrain: spec.terrain ?? 'default' });
    });
  }

  // Map rotation pool: maps/rotation.json (["name","name",…]) or the
  // FPS_MAP_ROTATION env (comma list). Rooms advance a shared cursor —
  // every room on the rotation marches the same sequence.
  private rotationList: string[] | null | undefined;
  private rotationIdx = 0;

  private rotation(): string[] {
    if (this.rotationList === undefined) {
      const env = (process.env.FPS_MAP_ROTATION ?? '').split(',')
        .map(s => s.trim()).filter(Boolean);
      if (env.length) this.rotationList = env;
      else {
        try {
          const raw = readFileSync(`${import.meta.dir}/../../maps/rotation.json`, 'utf8');
          const list = JSON.parse(raw);
          this.rotationList = Array.isArray(list) ? list.filter(s => typeof s === 'string') : [];
        } catch { this.rotationList = null; }
      }
    }
    return this.rotationList ?? [];
  }

  /** Next map in the rotation whose mode matches the room's — a mode
   *  swap would need Room reconstruction (mode wiring is ctor-time), so
   *  foreign-mode specs are skipped rather than half-applied. */
  private nextRotationSpec(room: Room): MapSpec | null {
    const list = this.rotation();
    if (!list.length) return null;
    for (let i = 0; i < list.length; i++) {
      const name = list[this.rotationIdx++ % list.length];
      const spec = this.loadMapSpec(name);
      if (!spec || (spec.mode && room.mode && spec.mode !== room.mode)) continue;
      this.rotationIdx %= list.length;
      // Terrain attach rides applySpec's onTerrain hook — calling it here
      // too would double-attach the same field.
      logger.info('Map rotated', { room: room.name, map: name });
      return spec;
    }
    return null;
  }

  /** maps/<name>.json at repo root — a missing or malformed file just
   *  means "default match rules", not an error. roomFor also tries the
   *  mode name so ad-hoc rooms like 'ctf-2' inherit ctf.json's rules. */
  private loadMapSpec(name: string): MapSpec | undefined {
    if (!name) return undefined;
    try {
      const path = `${import.meta.dir}/../../maps/${name}.json`;
      // readFileSync keeps roomFor synchronous — map files are tiny and
      // loaded once per room lifetime.
      const raw = readFileSync(path, 'utf8');
      const spec = resolveMapSpec(JSON.parse(raw));
      logger.info('Map spec loaded', { room: name, path });
      return spec;
    } catch {
      return undefined;
    }
  }

  /** Which maps/<X>.json spawned each room — lets quick-join group by
   *  map rather than room name. */
  private roomMapName = new Map<string, string>();

  /** Quick-join: pick the emptiest open room already running `mode`
   *  (and `map` when given), else spin up `<map|mode>-N`. `bots`
   *  overrides the spec's bot count/botFill on creation only. */
  quickRoom(mode: string, map = '', bots?: number): Room {
    let best: Room | undefined;
    for (const room of this.rooms.values()) {
      if (map ? this.roomMapName.get(room.name) !== map
              : room.mode !== mode) continue;
      if (room.playerCount() >= CONFIG.maxPlayers) continue;
      if (!best || room.playerCount() < best.playerCount()) best = room;
    }
    if (best) return best;
    const base = map || mode || 'arena';
    let n = 1;
    while (this.rooms.has(`${base}-${n}`)) n++;
    return this.roomFor(`${base}-${n}`, mode, map, bots);
  }

  /** Playable map list for the menu — name + declared mode + default
   *  bot count, straight from maps/*.json. */
  listMaps(): { name: string; mode: string; bots: number }[] {
    try {
      const dir = `${import.meta.dir}/../../maps`;
      return readdirSync(dir)
        .filter((f) => f.endsWith('.json') && f !== 'rotation.json') // rotation.json is a playlist, not a map
        .map((f) => {
          const spec = this.loadMapSpec(f.slice(0, -5));
          return {
            name: f.slice(0, -5),
            mode: spec?.mode ?? '',
            bots: spec?.bots ?? spec?.botFill ?? 0,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }

  // playerId → room index: the binary position path calls this at 20Hz per
  // player, so scanning this.rooms per frame doesn't scale. Kept in sync at
  // join/addPlayer and every removal (close/grace/kick/idle paths all funnel
  // through removePlayerCompletely or onClose).
  private playerRoom = new Map<string, Room>();

  private roomOfPlayer(playerId: string): Room | undefined {
    return this.playerRoom.get(playerId);
  }

  /** Spectator sockets aren't players — roomOfPlayer can't find them. */
  private specRooms = new Map<string, Room>();

  onOpen(ws: ServerWebSocket<WebSocketData>): void {
    logger.debug('WebSocket connection opened', { remoteAddress: ws.remoteAddress });
    // Join deadline: a socket that connects but never completes the join
    // handshake would otherwise sit forever (QUIC/RTC peers don't die on
    // their own quickly). 15s is generous — real clients join in ms.
    setTimeout(() => {
      if (!ws.data.playerId && ws.readyState === 1) ws.close(1000, 'join timeout');
    }, 15000).unref?.();
  }

  onMessage(ws: ServerWebSocket<WebSocketData>, message: string | ArrayBuffer | Uint8Array): void {
    // Binary hot path: [0x54] magic frames skip JSON entirely.
    // Currently only `position` (28B, replaces a ~140B JSON message at 20Hz).
    if (typeof message !== 'string') {
      const u8 = message instanceof ArrayBuffer ? new Uint8Array(message) : new Uint8Array((message as Uint8Array).buffer, (message as Uint8Array).byteOffset, (message as Uint8Array).byteLength);
      if (isWireFrame(u8)) {
        const existingId = ws.data.playerId;
        const room = existingId ? this.roomOfPlayer(existingId) : undefined;
        if (!existingId || !room) return; // binary before join — ignore
        const pos = decodePosition(u8);
        if (pos) {
          this.handleGameMessage(room, existingId, pos);
        }
        return;
      }
      logger.warn('Unknown binary frame rejected', { playerId: ws.data.playerId });
      return;
    }
    const text = message;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      logger.warn('Failed to parse JSON', { playerId: ws.data.playerId });
      return;
    }

    const existingPlayerId = ws.data.playerId;
    if (existingPlayerId && this.specRooms.has(existingPlayerId)) return; // spectators are read-only
    const room = existingPlayerId ? this.roomOfPlayer(existingPlayerId) : undefined;

    if (!existingPlayerId || !room) {
      this.handleHandshake(ws, raw);
      return;
    }

    // A room hop crosses room ownership — handle it at the dispatcher, not
    // inside one room's MessageHandler.
    const probe = raw as { type?: string };
    if (probe.type === 'switchRoom') {
      this.switchRoom(ws, existingPlayerId, raw);
      return;
    }

    this.handleGameMessage(room, existingPlayerId, raw);
  }

  // Switch-spam guard: reseating a session tears down/rebuilds a player
  // record plus two broadcasts — cheap per hop, but a 20Hz spammer would
  // churn two rooms' rosters for free. A short cooldown is plenty.
  private switchCooldowns = new Map<string, number>();
  private static readonly SWITCH_COOLDOWN_MS = 1500;

  /** Mid-match room hop: same socket, new membership. Reuses the leave
   *  teardown + SessionManager's join tail — the fresh gameState the new
   *  room emits drives the client's existing (re)connect rebuild, so the
   *  wire needs no new shape. */
  private switchRoom(ws: ServerWebSocket<WebSocketData>, playerId: string, raw: unknown): void {
    const now = Date.now();
    const last = this.switchCooldowns.get(playerId) ?? 0;
    if (now - last < GameServer.SWITCH_COOLDOWN_MS) return;
    this.switchCooldowns.set(playerId, now);

    const msg = raw as { room?: string; map?: string; mode?: string; bots?: number };
    const word = (v: unknown) => typeof v === 'string' && /^[\w-]{1,32}$/.test(v) ? v : undefined;
    const target = word(msg.room) ?? 'default';
    const from = this.roomOfPlayer(playerId);
    if (!from) return;
    if (from.name === target) return; // already seated — no-op, not an error

    const to = this.roomFor(target, word(msg.mode) ?? '', word(msg.map) ?? '',
      typeof msg.bots === 'number' && Number.isFinite(msg.bots) ? Math.max(0, Math.min(24, Math.floor(msg.bots))) : undefined);
    if (to.playerCount() >= CONFIG.maxPlayers ||
        (CONFIG.globalMaxPlayers > 0 && this.totalPlayers() >= CONFIG.globalMaxPlayers)) {
      from.connections.sendToPlayer(playerId, { type: 'matchNotice', text: `${target} is full` });
      return;
    }

    // The kit rides with the player — the hop isn't a loadout reset.
    const perk = from.players.getPlayer(playerId)?.perk ?? 'none';
    const transport = from.players.getPlayer(playerId)?.transport;

    // Leave teardown: the disconnect path minus the grace window.
    from.connections.unregister(playerId);
    from.rateLimiter.removePlayer(playerId);
    from.messages.onPlayerDisconnected(playerId);
    this.removePlayerCompletely(from, playerId, 'roomSwitch');

    // Join tail — identical to SessionManager's accept path.
    const sessionToken = this.sessions.tokenFor(playerId);
    to.sessionTokens.set(playerId, sessionToken);
    const joined = to.players.addPlayer(playerId, to.nextTeam(), perk);
    if (transport) joined.transport = transport;
    this.playerRoom.set(playerId, to);
    to.connections.register(playerId, ws);
    to.messages.handleHandshake(playerId, sessionToken);
    logger.info('Player switched rooms', { playerId, from: from.name, to: to.name });
  }

  private reconnectGraceMs = CONFIG.reconnectGraceMs; // Grace period for F5 reconnect

  onClose(ws: ServerWebSocket<WebSocketData>): void {
    const playerId = ws.data.playerId;
    if (!playerId) return;
    const specRoom = this.specRooms.get(playerId);
    if (specRoom) {
      specRoom.spectators.delete(playerId);
      specRoom.connections.unregister(playerId);
      this.specRooms.delete(playerId);
      logger.info('Spectator left', { playerId, room: specRoom.name });
      return;
    }
    const room = this.roomOfPlayer(playerId);
    if (!room) return;

    room.connections.unregister(playerId);
    room.rateLimiter.removePlayer(playerId);
    room.messages.onPlayerDisconnected(playerId);

    // Keep player state for grace period to allow seamless F5 reconnect
    const existingTimeout = room.disconnected.get(playerId);
    if (existingTimeout) clearTimeout(existingTimeout.timeout);

    const timeout = setTimeout(() => {
      room.disconnected.delete(playerId);
      this.removePlayerCompletely(room, playerId, 'grace period');
    }, this.reconnectGraceMs);

    room.disconnected.set(playerId, { timeout });
    logger.info('Player disconnected, grace period started', { playerId, room: room.name, graceMs: this.reconnectGraceMs });
  }

  onDrain(ws: ServerWebSocket<WebSocketData>): void {
    logger.debug('Backpressure drain', { playerId: ws.data.playerId });
  }

  /** Lobby listing — live matches a client can join by name. */
  listRooms() {
    return [...this.rooms.values()].map(r => ({
      name: r.name,
      mode: r.mode || undefined,
      players: r.playerCount(),
      maxPlayers: CONFIG.maxPlayers,
      spectators: r.spectators.size || undefined,
      // Live match state so the lobby row shows more than occupancy.
      scores: r.modeSpec?.teams ? { ...r.scores } : undefined,
      ffaLeader: r.modeSpec?.ffa
        ? [...r.ffaScores.entries()].sort((a, b) => b[1] - a[1])[0]
        : undefined,
      winAt: r.modeSpec?.winAt,
      // Lobby countdown — ms until the horn; omitted when the clock isn't armed.
      timeLeftMs: r.matchTimeLeftMs() || undefined,
    }));
  }

  // ---- Admin API ----------------------------------------------------

  /** Re-read maps/<name>.json and hot-swap it into the live room. The
   *  room keeps its mode (locked at creation) and roster; only the
   *  layout — spawns, structures, arena, ball mix, bot fill — reloads. */
  reloadRoom(name: string): 'ok' | 'no-room' | 'no-spec' {
    const room = this.rooms.get(name);
    if (!room) return 'no-room';
    const spec = this.loadMapSpec(name);
    if (!spec) return 'no-spec';
    room.applySpec(spec);
    logger.info('Room spec reloaded', { room: name });
    return 'ok';
  }

  /** Boot a player out of their room — the wire sees a normal playerLeft. */
  kickPlayer(playerId: string): boolean {
    const room = this.roomOfPlayer(playerId);
    if (!room) return false;
    room.socketOf(playerId)?.close(1000, 'kicked');
    this.removePlayerCompletely(room, playerId, 'adminKick');
    logger.info('Player kicked', { playerId });
    return true;
  }

  /** End the room's current match with the standing leader (or draw). */
  forceEndMatch(roomName: string): 'ok' | 'no-room' | 'no-mode' {
    const room = this.rooms.get(roomName);
    if (!room) return 'no-room';
    return room.forceEndMatch() ? 'ok' : 'no-mode';
  }

  private totalPlayers(): number {
    let n = 0;
    for (const room of this.rooms.values()) n += room.playerCount();
    return n;
  }

  /** Server-browser card: what a master list / LAN browser displays per
   *  host. Cheap to poll — one row per room, no per-player data. */
  getServerInfo() {
    const uptimeS = Math.floor((Date.now() - this.ops.startedAt) / 1000);
    return {
      name: CONFIG.serverName,
      region: CONFIG.serverRegion || undefined,
      tickRate: CONFIG.tickRate,
      maxPlayers: CONFIG.maxPlayers,
      players: this.totalPlayers(),
      uptimeS,
      rooms: this.listRooms(),
    };
  }

  getHealthStatus(): { status: string; players: number; maxPlayers: number; tickRate: number } {
    return {
      status: 'running',
      players: this.totalPlayers(),
      maxPlayers: CONFIG.maxPlayers,
      tickRate: CONFIG.tickRate,
    };
  }

  /** Ops snapshot for /metrics — counts since boot plus tick-lag stats,
   *  with per-room occupancy/ball counts for match-level observability. */
  getMetrics() {
    const o = this.ops;
    const uptimeS = Math.floor((Date.now() - o.startedAt) / 1000);
    const rooms = [...this.rooms.values()].map(r => ({
      name: r.name,
      players: r.playerCount(),
      balls: r.ballSim.ballCount,
      gracePending: r.disconnected.size,
      ballSimNow: r.ballSim.simNow,
    }));
    return {
      uptimeS,
      players: this.totalPlayers(),
      rooms,
      joins: o.joins,
      leaves: o.leaves,
      msgsIn: o.msgsIn,
      msgsRejected: o.msgsRejected,
      tiers: { ws: o.tierWs, wt: o.tierWt, rtc: o.tierRtc, other: o.tierOther },
      tickLagMs: {
        avg: o.tickLagSamples ? +(o.tickLagMsSum / o.tickLagSamples).toFixed(2) : 0,
        max: o.tickLagMsMax,
      },
    };
  }

  setBunServer(server: Server<WebSocketData>): void {
    this.bunServer = server;
  }

  stop(): void {
    this.tickLoop.stop();
    if (this.bunServer) {
      this.bunServer.stop(true);
      logger.info('Server stopped');
    }
  }

  private handleHandshake(ws: ServerWebSocket<WebSocketData>, raw: unknown): void {
    this.sessions.handle(ws, raw);
  }

  private handleGameMessage(room: Room, playerId: string, raw: unknown): void {
    const result = validateMessage(raw);
    if (!result.success) {
      this.ops.msgsRejected++;
      logger.warn('Invalid message rejected', { playerId, room: room.name, error: result.error });
      return;
    }

    this.ops.msgsIn++;
    room.messages.handleMessage(playerId, result.data);
  }

  // Full teardown shared by grace expiry and idle reap — the five stores
  // and the broadcast must move together or a stale slot/token leaks.
  private removePlayerCompletely(room: Room, playerId: string, reason: string): void {
    room.removePlayerCompletely(playerId, reason, (m, o) => logger.info(m, o));
    this.playerRoom.delete(playerId);
    this.ops.leaves++;
  }

}
