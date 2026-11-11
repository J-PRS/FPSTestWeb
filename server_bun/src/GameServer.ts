import { simMs } from './simClock.ts';
import type { ServerWebSocket, Server } from 'bun';
import { CONFIG } from './config.ts';
import type { Room } from './Room.ts';
import { totalPlayers as opsTotalPlayers, getServerInfo as opsGetServerInfo, getHealthStatus as opsGetHealthStatus, getMetrics as opsGetMetrics } from './serverOps.ts';
import { BallSim } from './BallSim.ts';
import { validateMessage } from './wire.ts';
import type { WebSocketData } from './types.ts';
import { logger } from './logger.ts';
import { fileURLToPath } from 'node:url';
import type { Heightfield } from '../../shared/heightfield.ts';
import { isWireFrame, decodePosition, decodeInputMove, decodeWireJson, decodePosClaim, decodeShot, WIRE_INPUTMOVE, WIRE_JSON, WIRE_JUMP, WIRE_JETPACK, WIRE_SHOT } from '../../shared/wire.ts';
import { TickLoop } from './TickLoop.ts';
import { evictEldest } from './evictEldest.ts';
import { SessionManager } from './SessionManager.ts';
import { MapCatalog } from './mapCatalog.ts';
import { RoomFactory } from './roomFactory.ts';
import { MatchJournal } from './matchJournal.ts';
import { RoomSwitcher } from './roomSwitch.ts';
import { SessionRegistry } from './sessionRegistry.ts';
import { wallNow } from './wallClock.ts';
import { wireRx, BIN_KIND, rxCost } from './wireMeter.ts';
import { ConnectionManager } from './ConnectionManager.ts';
import { MessageHandler } from './MessageHandler.ts';
import type { UdpLane } from './UdpLane.ts';
import type { TeamId } from '../../shared/teams.ts';
import type { ClientMessage, RoomMods } from '../../shared/protocol.ts';
import { roomModsOf } from '../../shared/protocol.ts';

interface RestoreSeat {
  id: string; name?: string; team?: TeamId; perk?: string; armorClass?: string;
  pendingClass?: string; pendingPerk?: string;
  pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number };
  yaw?: number; pitch?: number; health?: number; isDead?: boolean; token: string;
}

interface RestoreRoom extends RoomMods {
  name: string; mode?: string; map?: string; bots?: number;
  players: RestoreSeat[];
}

interface RestoreState { v: 1; rooms: RestoreRoom[] }

/** Ingest-fast-path message types: telemetry mutates no sim state (and
 *  its transit stamps are arrival-time by design); position/inputMove/
 *  teleport order through the shadow's own seq-gated machinery; jump/
 *  jetpack are pure presence relays. Parking them in the command buffer
 *  just adds 0-50ms of queue to every reply they send. Combat claims
 *  stay parked: they adjudicate against sim state and must see this
 *  window's earlier commands in wire order. */
const FAST_MSG_TYPES = new Set([
  'ping', 'pong', 'clientStats', 'tickNack',
  'position', 'inputMove', 'teleport', 'jump', 'jetpack',
]);

export class GameServer {
  // One match's state per room - players land in 'default' unless the join
  // handshake names a room. Everything per-match (players, sockets, ball
  // sim, tick bookkeeping) lives inside Room; GameServer is the dispatcher.
  rooms = new Map<string, Room>();
  private field: Heightfield | null = null; // shared across rooms
  private bunServer: Server<WebSocketData> | null = null;
  readonly tickLoop: TickLoop;
  readonly sessions: SessionManager;
  /** Session lifecycle state machine - every connect/seat/grace/reap
   *  decision funnels through here (see sessionRegistry.ts). */
  readonly registry = new SessionRegistry();
  private readonly maps = new MapCatalog();
  private readonly factory: RoomFactory;
  private readonly switcher: RoomSwitcher;

  /** Verbs a spectator may drive - read-only otherwise. tickNack is safe:
   *  nackFor scopes its reseed to the spec's own intro window. */
  private static readonly SPEC_VERBS = new Set(['ping', 'pong', 'clientStats', 'snapshotRequest', 'resync', 'tickNack']);

  // Ops counters - cheap ints, read by /metrics. msgsIn counts everything
  // that passed validation; tick lag measures setInterval drift (the
  // server-clock skew that makes client replays overshoot).
  ops = {
    startedAt: wallNow(),
    msgsIn: 0, msgsRejected: 0, joins: 0, leaves: 0,
    // Which netcode-v2 tier clients actually land on - the cost/perf mix
    // this deployment is paying for.
    tierWs: 0, tierWt: 0, tierRtc: 0, tierOther: 0,
    // Join-phase rollup - wait = upgrade→handshake dispatch (inbound
    // queue/loop starvation), work = seat+worldstate serialize+send.
    joinWaitMsSum: 0, joinWaitMsMax: 0, joinWorkMsSum: 0, joinWorkMsMax: 0, joinN: 0,
    // Close attribution - ws code histogram + seats that died before
    // seating. The herd's mass-drop mechanism was never provable without
    // this (drown vs join-timeout vs client 1006 all look identical).
    closeCodes: new Map<number, number>(), closesUnseated: 0,
    tickLagMsMax: 0, tickLagMsSum: 0, tickLagSamples: 0,
    lastTickAt: 0, ticksDropped: 0,
  };

  constructor() {
    // Server-owned creatures: balls are the shared-PvE pilot. A missing
    // heightmap must degrade gracefully - log and run creature-free rather
    // than take down the whole game server. The parsed field is shared by
    // every room's BallSim rather than re-read per match.
    const heightmapPath = CONFIG.heightmapPath || fileURLToPath(new URL('../heightmap.bin', import.meta.url));
    const bunFile = (globalThis as { Bun?: { file(p: string): { arrayBuffer(): Promise<ArrayBuffer> } } }).Bun?.file;
    if (bunFile) {
      bunFile(heightmapPath).arrayBuffer()
        .then((ab): void => {
          this.field = BallSim.parseHeightmap(new Uint8Array(ab));
          // Rooms that already exist (players joined before the load
          // finished) get the field attached now.
          for (const room of this.rooms.values()) {
            if (!room.ballSim.hasField) { room.field = this.field; room.ballSim.attachField(this.field); }
            // The creature sim rides the same field - it sits dead
            // without it (step() early-returns on !field).
            if (!room.creatureSim.hasField) {room.creatureSim.attachField(this.field);}
            // moveSim + projectiles got null at construction the same
            // way - without this their seats sit in pendingTrack forever:
            // no reconcile, no transit channel, no corrections for anyone
            // who joined before the heightmap read resolved.
            if (!room.moveSim.hasField) {room.moveSim.attachField(this.field, (pid) => room.players.getPlayer(pid)?.position);}
            room.projectiles.attachField(this.field);
          }
        return; })
        .catch((error): void => logger.warn('BallSim disabled - heightmap load failed', { err: String(error) }));
    } else {
      logger.warn('BallSim disabled - not running under Bun');
    }

    // The broadcast engine - owns both timers; teardown delegates back
    // here so playerRoom/ops stay in one place.
    this.tickLoop = new TickLoop(this.rooms, this.ops, (room, id, reason): void => this.removePlayerCompletely(room, id, reason));
    this.tickLoop.start();
    // SessionManager owns the join handshake: identity claims, join
    // throttle, grace-period reclaim, spectate.
    this.sessions = new SessionManager({
      rooms: this.rooms,
      playerRoom: this.playerRoom,
      specRooms: this.specRooms,
      roomFor: (n, m, mp, b, mods): Room | null => this.factory.roomFor(n, m, mp, b, mods),
      quickRoom: (m, mp, b, mods, ph, mm): Room | null => this.factory.quickRoom(m, mp ?? '', b, mods, ph ?? false, mm ?? true),
      roomOfPlayer: (id): Room | undefined => this.roomOfPlayer(id),
      totalPlayers: (): number => opsTotalPlayers(this),
      draining: this.draining,
      ops: this.ops,
      registry: this.registry,
      departSpectator: (id, reason, closeCode): boolean => this.departSpectator(id, reason, closeCode),
      removePlayerCompletely: (r, id, reason): void => this.removePlayerCompletely(r, id, reason),
    });
    this.factory = new RoomFactory({
      rooms: this.rooms,
      sessions: this.registry,
      maps: this.maps,
      field: (): Heightfield | null => this.field,
      recordEnd: (rec): void => this.journal.recordEnd(rec),
      kickPlayer: (pid): boolean => this.kickPlayer(pid),
      forgetRoom: (name): void => this.tickLoop.forgetRoom(name),
    });
    this.switcher = new RoomSwitcher({
      roomOfPlayer: (id): Room | undefined => this.roomOfPlayer(id),
      roomFor: (n, m, mp, b, mods): Room | null => this.factory.roomFor(n, m, mp, b, mods),
      hasRoom: (n): boolean => this.rooms.has(n),
      removePlayerCompletely: (r, id, reason): void => this.removePlayerCompletely(r, id, reason),
      totalPlayers: (): number => opsTotalPlayers(this),
      specRooms: this.specRooms,
      playerRoom: this.playerRoom,
      sessions: this.sessions,
      registry: this.registry,
    });
    // Standing lobbies: specs flagged standing:true get a permanent
    // <name>-1 room now - hibernating empty (near-zero cost), always
    // joinable and always listed in /rooms (a 1v1 duel-1 with nobody in
    // it is still an open table, not a dead room). Fleet workers skip
    // this: every worker seeding 'duel-1' shadows the same-named room
    // on its siblings in the claim directory (duplicate /rooms rows,
    // joiners split across invisible instances) - the matchmaker owns
    // room naming fleet-wide instead.
    // Standing lobbies: specs flagged standing:true get a permanent
    // <name>-1 room. Single-worker deploys seed them at boot. In fleet
    // mode only the primary worker (w0) seeds - every worker seeding
    // 'duel-1' would shadow the same-named room on its siblings (duplicate
    // /rooms rows, joiners split across invisible instances). The
    // matchmaker routes joins to w0 for those rooms.
    if (!process.env.FPS_FLEET_REPORT || process.env.FPS_WORKER_ID === 'w0') {
      for (const name of this.maps.standingRooms()) {this.factory.roomFor(name);}
    }
  }

  /** Native-shell volatile lane - one datagram socket, sessions bind by
   *  token (issued in gameState). The ws session still owns the reliable
   *  lane; only volatile binary (claims up, ticks down) rides UDP. */
  /** Per-session decode scratch for udp-sourced frames - same zero-alloc
   *  contract as ws.data.posScratch. */
  private udpScratch = new Map<string, WebSocketData>();
  attachUdpLane(lane: UdpLane): void {
    lane.onFrame = (playerId, frame): void => {
      let data = this.udpScratch.get(playerId);
      if (!data) {data = { playerId, connectedAt: wallNow() }; this.udpScratch.set(playerId, data);}
      this.handleBinaryFrame(playerId, frame, null, data, (): void => lane.unbind(playerId));
    };
    MessageHandler.udpBind = (playerId): { token: string; port: number } => ({
      token: lane.issue(playerId),
      port: lane.port,
    });
    ConnectionManager.udpSend = (playerId, data): boolean => {
      // Stale lanes fall back to ws - a client whose inbound path died
      // (shim crash, NAT blackhole) gets ticks back without a reconnect.
      if (!lane.live(playerId)) {return false;}
      lane.sendTo(playerId, data);
      return true;
    };
    ConnectionManager.udpLive = (playerId): boolean => lane.live(playerId);
    ConnectionManager.onUnreg = (playerId): void => {
      lane.unbind(playerId);
      this.udpScratch.delete(playerId);
    };
    logger.info('udp lane attached', { port: lane.port });
  }

  // playerId → room index: the binary position path calls this at 20Hz per
  // player, so scanning this.rooms per frame doesn't scale. Kept in sync at
  // join/addPlayer and every removal (close/grace/kick/idle paths all funnel
  // through removePlayerCompletely or onClose).
  private playerRoom = new Map<string, Room>();

  private roomOfPlayer(playerId: string): Room | undefined {
    return this.playerRoom.get(playerId);
  }

  // Match history lives in MatchJournal - the ring is a read cache over
  // the append-only matches.jsonl journal.
  private readonly journal = new MatchJournal();

  /** Recent match results - newest last. */
  listMatches(): unknown[] {
    return this.journal.list();
  }

  /** Lifetime leaderboard read off the match journal - survives restarts
   *  since matches.jsonl is append-only. */
  async getStats(): Promise<unknown[]> {
    return this.journal.stats();
  }

  /** AFK demotion: humans who stop claiming (hidden tab, parked menu)
   *  become spectators so their player seat frees for a joiner. On
   *  return a normal join/reclaim re-seats them - they were only ever
   *  watching. lastClaimAt is claims-only (pings don't count). */
  afkSweep(): void {
    const now = wallNow();
    for (const room of this.rooms.values()) {
      for (const [id, p] of room.players.getAllPlayers()) {
        if (p.isBot || p.lastClaimAt === undefined) {continue;}
        if (now - p.lastClaimAt < 90_000) {continue;}
        const ws = room.socketOf(id);
        this.removePlayerCompletely(room, id, 'afk demote');
        if (ws) {
          // begin() before seat() - the demote just deleted the session,
          // and seat-without-begin both spams the anomaly log and leaves a
          // room-less session that corrupts the next reclaim's room lookup.
          this.registry.begin(id, room.name);
          ws.data.gen = this.registry.seat(id, true, 'spectate');
          room.spectators.add(id);
          this.specRooms.set(id, room);
          room.connections.register(id, ws);
          room.markIntro(id);
          room.messages.handleSpectatorHandshake(id);
        }
      }
    }
  }

  /** Drain-deploys: armed via /admin/drain - SessionManager refuses new
   *  joins (reclaims still land), and the drain checker exits the process
   *  once every human has left. */
  draining = false;

  totalPlayers(): number { return opsTotalPlayers(this); }

  /** Humans only - bots are seats that exist to serve the humans, so a
   *  bot-populated room must not hold a drain open. */
  totalHumans(): number {
    let n = 0;
    for (const room of this.rooms.values()) {n += room.players.getHumanCount();}
    return n;
  }

  quickRoom(mode: string, map = '', bots?: number, mods: RoomMods = {}, preferHumans = false, mayMint = true): Room | null {
    return this.factory.quickRoom(mode, map, bots, mods, preferHumans, mayMint);
  }

  /** Route guard: does maps/<name>.json resolve? The catalog negative-
   *  caches misses, so a bogus-name flood costs a Map get, not a disk
   *  read + a throwaway Room per request. */
  hasMap(name: string): boolean { return this.maps.has(name); }

  listMaps(): { name: string; mode: string; modes: string[]; bots: number; t2: boolean }[] {
    return this.maps.list();
  }

  /** Spectator sockets aren't players - roomOfPlayer can't find them. */
  private specRooms = new Map<string, Room>();

  /** Unseated sockets per source IP: upgraded but not yet joined.
   *  Cap bounds the held-zombie flood the kernel SYN rate can't see. */
  private pendingByIp = new Map<string, Set<ServerWebSocket<WebSocketData>>>();
  private static readonly PENDING_PER_IP = 8;

  unseatAllow(ip: string | undefined): boolean {
    const s = ip === undefined ? undefined : this.pendingByIp.get(ip);
    return s === undefined || s.size < GameServer.PENDING_PER_IP;
  }

  onOpen(ws: ServerWebSocket<WebSocketData>): void {
    logger.debug('WebSocket connection opened', { remoteAddress: ws.remoteAddress });
    const pendIp = ws.data.clientIp ?? ws.remoteAddress;
    if (pendIp) {
      let s = this.pendingByIp.get(pendIp);
      if (!s) {s = new Set(); this.pendingByIp.set(pendIp, s);}
      s.add(ws);
    }
    // Join deadline: a socket that connects but never completes the join
    // handshake would otherwise sit forever (QUIC/RTC peers don't die on
    // their own quickly). 15s is generous - real clients join in ms.
    setTimeout((): void => {
      if (!ws.data.playerId && ws.readyState === 1) {
        // Name the socket's age - a ~ms close means the join raced off
        // generation (client-side churn), a real 15s close means the join
        // never arrived. The tunnel session proved these are indistinguishable
        // in the log otherwise.
        logger.info('join timeout close', { ageMs: Date.now() - ws.data.connectedAt });
        ws.close(1000, 'join timeout');
      }
    }, CONFIG.joinTimeoutMs).unref?.();
  }

  onMessage(ws: ServerWebSocket<WebSocketData>, message: string | ArrayBuffer | Uint8Array): void {
    const tRx = process.hrtime.bigint();
    // Seated sockets leave the pending ledger: the join handshake
    // stamps playerId deep in SessionManager, so the first message that
    // reads one is the seat signal.
    if (ws.data.playerId) {
      const ip = ws.data.clientIp ?? ws.remoteAddress;
      const s = ip ? this.pendingByIp.get(ip) : undefined;
      if (s?.delete(ws) && s.size === 0) {this.pendingByIp.delete(ip!);}
    }
    try {
    // Wrap first: the binary metering tag needs byte 1 - a DataView +
    // string per frame was ~50K throwaway allocs/s at load.
    const u8 = typeof message === 'string'
      ? undefined
      : message instanceof ArrayBuffer
        ? new Uint8Array(message)
        : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
    wireRx(ws.data.playerId, typeof message === 'string' ? Buffer.byteLength(message) : message.byteLength,
      u8 === undefined ? `j:${/^.{0,30}?"type":"?([a-zA-Z]+)/.exec(message as string)?.[1] ?? '?'}` : BIN_KIND[u8[1]!]!);
    // Binary hot path: [0x54] magic frames skip JSON entirely.
    // Currently only `position` (28B, replaces a ~140B JSON message at 20Hz).
    if (u8 !== undefined) {
      if (isWireFrame(u8)) {
        const existingId = ws.data.playerId;
        this.handleBinaryFrame(existingId, u8, ws, ws.data, (): void => ws.close(1011, 'server error'));
        return;
      }
      this.invalidWarn(ws.data.playerId, 'Unknown binary frame rejected');
      this.garbageStrike(ws);
      return;
    }
    this.onJsonText(ws, message as string);
    } finally {
      rxCost.count += 1;
      rxCost.ns += Number(process.hrtime.bigint() - tRx);
    }
  }

  /** Binary frames from ANY lane (ws binary, udp datagrams) - the decode
   *  is the validation, dispatch is the trusted path. `data` is the
   *  per-source decode-slot holder (ws.data or the lane's scratch bag);
   *  `onFatal` severs the source on a throwing handler. */
  private handleBinaryFrame(
    existingId: string | undefined,
    u8: Uint8Array,
    ws: ServerWebSocket<WebSocketData> | null,
    data: WebSocketData,
    onFatal: () => void,
  ): void {
    {
        const room = existingId ? this.roomOfPlayer(existingId) : undefined;
        if (!existingId || !room) {return;} // binary before join - ignore
        // JSON-over-binary: combat claims ride the position lane for
        // transit, then decode back into the ordinary text path - same
        // parse, same validation, same dispatch.
        if (u8[1] === WIRE_JSON) {
          // Reliable traffic doesn't ride the volatile lane - a udp-bound
          // datagram reaching here is a protocol violation, drop it.
          if (!ws) {return;}
          const text = decodeWireJson(u8);
          if (text === null) {this.invalidWarn(existingId, 'Malformed binary-JSON frame'); this.garbageStrike(ws); return;}
          this.onJsonText(ws, text);
          return;
        }
        // Per-socket decode slot: ~30Hz × n frames' worth of object churn
        // becomes zero-alloc. Every consumer copies field-wise inside the
        // handler - nothing may retain `pos` past this call.
        // The binary input path: inputMove edges ride the same lane as
        // position reports - the change-only journal lands ~50ms fresher
        // than the JSON stream it duplicates (edge timing = replay fidelity).
        // Binary claims - the decoders' bounded reads + finite checks
        // ARE the validation, same trusted dispatch as position frames.
        if (u8[1] === WIRE_JUMP || u8[1] === WIRE_JETPACK) {
          const c = decodePosClaim(u8, u8[1]!);
          if (c) {
            try {
              this.handleGameMessageTrusted(room, existingId, { type: u8[1] === WIRE_JUMP ? 'jump' : 'jetpack', position: c.position });
            } catch (error) {
              logger.error('Message handler failed', { playerId: existingId, type: 'posClaim(binary)', err: error instanceof Error ? error.stack ?? error.message : String(error) });
              try { onFatal(); } catch { /* socket already dying */ }
            }
          }
          return;
        }
        if (u8[1] === WIRE_SHOT) {
          const s = decodeShot(u8);
          if (s) {
            try {
              this.handleGameMessageTrusted(room, existingId, { type: 'shotFired', weaponType: s.weaponType, pos: s.pos, dir: s.dir, shotId: s.shotId, fireAt: s.fireAt });
            } catch (error) {
              logger.error('Message handler failed', { playerId: existingId, type: 'shotFired(binary)', err: error instanceof Error ? error.stack ?? error.message : String(error) });
              try { onFatal(); } catch { /* socket already dying */ }
            }
          }
          return;
        }
        if (u8[1] === WIRE_INPUTMOVE) {
          const im = decodeInputMove(u8);
          if (im) {
            try {
              this.handleGameMessageTrusted(room, existingId, im);
            } catch (error) {
              logger.error('Message handler failed', { playerId: existingId, type: 'inputMove(binary)', err: error instanceof Error ? error.stack ?? error.message : String(error) });
              try { onFatal(); } catch { /* socket already dying */ }
            }
          }
          return;
        }
        const pos = decodePosition(u8, data.posScratch ??= {
          type: 'position',
          position: { x: 0, y: 0, z: 0 },
          rotation: { yaw: 0, pitch: 0 },
          velocity: { x: 0, y: 0, z: 0 },
          seq: 0, ping: 0,
        });
        if (pos) {
          // Same containment as the JSON lane - a throwing handler drops
          // this socket, not the process.
          try {
            this.handleGameMessageTrusted(room, existingId, pos);
          } catch (error) {
            logger.error('Message handler failed', { playerId: existingId, type: 'position(binary)', err: error instanceof Error ? error.stack ?? error.message : String(error) });
            try { onFatal(); } catch { /* socket already dying */ }
          }
        }
        return;
    }
  }

  /** The text/JSON path - WS strings and WIRE_JSON frames share it. */
  private onJsonText(ws: ServerWebSocket<WebSocketData>, text: string): void {
    const message = text;
    // Pre-join CPU guard: an unseated socket's only legitimate frame is
    // the (small) join handshake - unlimited 1MB JSON parses are free DoS.
    if (!ws.data.playerId) {
      ws.data.preJoin = (ws.data.preJoin ?? 0) + 1;
      if (message.length > 64 * 1024 || ws.data.preJoin > 16) {
        ws.close(1008, 'pre-join flood');
        return;
      }
    }
    let raw!: unknown; // oxlint-disable-line init-declarations -- assigned in try/catch below
    try {
      raw = JSON.parse(text);
    } catch {
      this.invalidWarn(ws.data.playerId, 'Failed to parse JSON');
      this.garbageStrike(ws);
      return;
    }

    const existingPlayerId = ws.data.playerId;
    let room = existingPlayerId ? this.roomOfPlayer(existingPlayerId) : undefined;
    if (existingPlayerId && !room) {
      // Spectators are read-only EXCEPT the verbs that serve them too:
      // ping/pong (their RTT probe), clientStats, snapshotRequest/resync
      // (a gapped spec otherwise desyncs permanently), tickNack (scoped
      // to their own intro window by nackFor, not room-wide).
      room = this.specRooms.get(existingPlayerId);
      // A still-connecting seat (join deferred on terrainReady) has no
      // room yet - join/switchRoom from it are re-intents, not noise.
      // Swallowing them here locks the client to whatever room the stale
      // deferred seat lands in (the hop-during-load hole).
      if (!room && this.registry.state(existingPlayerId) === 'connecting') {
        const t = (raw as { type?: string }).type;
        if (t === 'join') {this.handleHandshake(ws, raw); return;}
        if (t === 'switchRoom') {this.switcher.switchRoom(ws, existingPlayerId, raw); return;}
      }
      if (!room || !GameServer.SPEC_VERBS.has((raw as { type?: string }).type ?? '')) {return;}
    }

    // A bad message must only cost its own sender - anything downstream
    // that throws (handler bug, malformed fields the shape checks missed)
    // logs the player + message type and drops that socket, not the process.
    try {
    if (!existingPlayerId || !room) {
      this.handleHandshake(ws, raw);
      return;
    }

    // A room hop crosses room ownership - handle it at the dispatcher, not
    // inside one room's MessageHandler.
    const probe = raw as { type?: string };
    if (probe.type === 'switchRoom') {
      this.switcher.switchRoom(ws, existingPlayerId, raw);
      return;
    }

    this.handleGameMessage(room, existingPlayerId, raw, ws);
    } catch (error) {
      const t = (raw as { type?: string })?.type ?? '?';
      logger.error('Message handler failed', { playerId: existingPlayerId, type: t, err: error instanceof Error ? error.stack ?? error.message : String(error) });
      try { ws.close(1011, 'server error'); } catch { /* socket already dying */ }
    }
  }

  private reconnectGraceMs = CONFIG.reconnectGraceMs; // Grace period for F5 reconnect

  onClose(ws: ServerWebSocket<WebSocketData>, code?: number, _reason?: string): void {
    if (code !== undefined) {this.ops.closeCodes.set(code, (this.ops.closeCodes.get(code) ?? 0) + 1);}
    const {playerId} = ws.data;
    // Leave the unseated ledger unconditionally: a socket that seated on
    // its join frame and sent nothing since still holds a pending entry.
    {
      const ip = ws.data.clientIp ?? ws.remoteAddress;
      const s = ip ? this.pendingByIp.get(ip) : undefined;
      if (s?.delete(ws) && s.size === 0) {this.pendingByIp.delete(ip!);}
    }
    if (!playerId) {return;}
    // Throttle entries keyed by playerId must die with the socket -
    // otherwise they linger until the 4096 wholesale clear, which also
    // resets the gate for live spammers.
    this.invalidWarnAt.delete(playerId);
    if (this.departSpectator(playerId, 'spectator left')) {return;}
    const room = this.roomOfPlayer(playerId);
    if (!room) {
      // Closed mid-handshake (connecting, never seated) - no room entry
      // exists to tear down, but the session record must not leak.
      this.ops.closesUnseated += 1;
      this.registry.terminate(playerId, 'closed before seat');
      return;
    }

    // A stale socket's close must not detach a re-seated session: RTC
    // adapters close both datachannels asynchronously, so the old
    // socket's onClose can land AFTER a reclaim already handed the seat
    // to a new socket - marking a live player disconnected and flapping
    // the connection every reconnect cycle. The seat generation makes it
    // a no-op by construction; the map check stays as belt-and-suspenders
    // for sockets seated before the registry existed (adapters).
    if (room.connections.getConnection(playerId) !== ws) {return;}
    if (ws.data.gen !== undefined && ws.data.gen !== this.registry.gen(playerId)) {return;}

    // The grace countdown arms inside the session itself - reclaim and
    // terminate clear it, so the timer can't outlive the seat.
    this.registry.disconnect(playerId, 'socket closed', this.reconnectGraceMs,
      (): void => this.removePlayerCompletely(room, playerId, 'grace period'));
    room.connections.unregister(playerId);
    room.rateLimiter.removePlayer(playerId);
    room.messages.onPlayerDisconnected(playerId);

    logger.info('Player disconnected, grace period started', { playerId, room: room.name, graceMs: this.reconnectGraceMs });
  }

  onDrain(ws: ServerWebSocket<WebSocketData>): void {
    logger.debug('Backpressure drain', { playerId: ws.data.playerId });
  }

  /** Display name for a player id, scanning live rooms - ops paths only,
   *  called per-conn on admin endpoints, not per-tick. */
  playerName(id: string): string | undefined {
    for (const room of this.rooms.values()) {
      const p = room.players.getPlayer(id);
      if (p) {return p.name;}
    }
    return undefined;
  }

  /** Lobby listing - live matches a client can join by name. `withNames`
   *  (ops callers only) adds the per-player id→name roster. */
  listRooms(withNames = false) {
    return [...this.rooms.values()].filter((r): boolean => r.mods.unlisted !== true).map(r => ({
      name: r.name,
      mode: r.mode || undefined,
      // Terrain name is what "map" means to a browser - duel-1 and
      // headhunt-1 both run rimrock.bin, their spec files just carry the
      // rules. mapNameOf stays spec-source (reload/matchmaker key on it).
      map: r.spec.terrain?.split('/').pop()?.replace(/\.bin$/, '') ?? this.maps.mapNameOf(r.name),
      players: r.playerCount(),
      humans: r.players.getHumanCount(),
      // Humans actually playing - a position claim within 90s. A parked
      // hidden-tab client keeps its seat (humans) but isn't counted
      // here, so a ghost doesn't read as "someone online".
      active: r.players.getActiveHumanCount(90_000),
      names: withNames
        ? [...r.players.getAllPlayers().values()].map(p => ({ id: p.id, name: p.name }))
        : undefined,
      maxPlayers: r.maxPlayers,
      spectators: r.spectators.size > 0 ? r.spectators.size : undefined,
      // Live match state so the lobby row shows more than occupancy.
      scores: r.modeSpec?.teams ? (Object.assign({}, r.scores)) : undefined,
      ffaLeader: r.modeSpec?.ffa
        ? [...r.ffaScores.entries()].toSorted((a, b): number => b[1] - a[1])[0]
        : undefined,
      winAt: r.modeSpec?.winAt,
      // Lobby countdown - ms until the horn; omitted when the clock isn't armed.
      timeLeftMs: r.matchTimeLeftMs() || undefined,
    }));
  }

  // ---- Admin API ----------------------------------------------------

  /** Re-read maps/<name>.json and hot-swap it into the live room. The
   *  room keeps its mode (locked at creation) and roster; only the
   *  layout - spawns, structures, arena, ball mix, bot fill - reloads. */
  reloadRoom(name: string): 'ok' | 'no-room' | 'no-spec' {
    const room = this.rooms.get(name);
    if (!room) {return 'no-room';}
    // The room's name isn't always its map's (ad-hoc room names, map= pick
    // in /join, post-rotation state) - reload whatever spec it's playing.
    const spec = this.maps.reloadSpec(this.maps.mapNameOf(name) ?? name);
    if (!spec) {return 'no-spec';}
    room.mapSrc = this.maps.mapNameOf(name) ?? name;
    // A .bin re-baked under the same filename isn't a 'terrainChanged'
    // key diff - evict the cached field and force re-attach or the
    // reload silently keeps the old heightmap.
    if (spec.terrain) {this.factory.invalidateField(spec.terrain);}
    room.applySpec(spec);
    if (spec.terrain) {this.factory.attachTerrain(room, spec);}
    logger.info('Room spec reloaded', { room: name });
    return 'ok';
  }

  /** Boot a player out of their room - the wire sees a normal playerLeft. */
  kickPlayer(playerId: string): boolean {
    const room = this.roomOfPlayer(playerId);
    if (!room) {return false;}
    room.socketOf(playerId)?.close(1000, 'kicked');
    this.removePlayerCompletely(room, playerId, 'adminKick');
    logger.info('Player kicked', { playerId });
    return true;
  }

  /** Close a room outright: humans get kicked (they reconnect through
   *  the matchmaker into a live room - bare rejoins can't re-mint),
   *  bots die with the room. For draining twin rooms / zombie arenas. */
  closeRoom(name: string): string {
    const room = this.rooms.get(name);
    if (!room) {return 'no room';}
    for (const [id, p] of room.players.getAllPlayers()) {
      if (!p.isBot) {room.socketOf(id)?.close(1000, 'room closed'); this.removePlayerCompletely(room, id, 'roomClosed');}
    }
    room.dispose();
    this.rooms.delete(name);
    this.tickLoop.forgetRoom(name);
    logger.info('Room closed by admin', { room: name });
    return 'ok';
  }

  /** Socket-only kill - the seat record survives so grace + the
   *  reconnect/reclaim path fire (vs kickPlayer's full removal). The
   *  test-op for "real socket dropped mid-match". */
  dropSocket(playerId: string): boolean {
    const room = this.roomOfPlayer(playerId);
    if (!room) {return false;}
    const ws = room.socketOf(playerId);
    if (!ws) {return false;}
    try { ws.close(4321, 'dropsock'); } catch { return false; }
    logger.info('Socket dropped (seat kept for reclaim)', { playerId });
    return true;
  }

  /** End the room's current match with the standing leader (or draw). */
  forceEndMatch(roomName: string): 'ok' | 'no-room' | 'no-mode' {
    const room = this.rooms.get(roomName);
    if (!room) {return 'no-room';}
    return room.forceEndMatch() ? 'ok' : 'no-mode';
  }

  /** Flush a room's authoritative demo capture to disk (live - no
   *  teardown). Needs FPS_DEMO so the room has a recorder attached. */
  dumpDemo(roomName: string): 'ok' | 'no-room' | 'no-demo' | { file: string } {
    const room = this.rooms.get(roomName);
    if (!room) {return 'no-room';}
    const dir = process.env.FPS_DEMO;
    if (!room.demo || !dir) {return 'no-demo';}
    return { file: room.demo.flush(dir, '-live') };
  }

  /** Server-browser card: what a master list / LAN browser displays per
   *  host. Cheap to poll - one row per room, no per-player data. */
  getServerInfo() { return opsGetServerInfo(this); }

  getHealthStatus() { return opsGetHealthStatus(this); }

  /** Ops snapshot for /metrics. */
  getMetrics() { return opsGetMetrics(this); }

  setBunServer(server: Server<WebSocketData>): void {
    this.bunServer = server;
    // uWS topic fanout: reliable broadcast frames publish once to every
    // subscribed ws instead of a send-per-conn loop (send was ~25% of
    // CPU at 64 sockets). Per-conn paths (ticks, sendToPlayer, excludes)
    // stay direct.
    ConnectionManager.publishFns.add((topic: string, data: string | Uint8Array): void => { server.publish(topic, data as string | Uint8Array<ArrayBuffer>); });
  }

  /** Dev-restart seat snapshot - humans only, bots re-mint from spec.bots.
   *  Handed to the dev-watch parent (in-memory, no disk) so a respawned
   *  child can re-seat reconnecting clients where they were. */
  exportRestore(): RestoreState {
    const rooms: RestoreRoom[] = [];
    for (const room of this.rooms.values()) {
      const players: RestoreSeat[] = [];
      for (const [id, p] of room.players.getAllPlayers()) {
        if (p.isBot) {continue;}
        const token = room.sessionTokens.get(id);
        if (!token) {continue;} // pre-seat or bot - nothing to reclaim with
        players.push({
          id, name: p.name, team: p.team, perk: p.perk, armorClass: p.armorClass,
          pendingClass: p.pendingClass, pendingPerk: p.pendingPerk,
          pos: Object.assign({}, p.position), vel: Object.assign({}, p.velocity),
          yaw: p.rotation.yaw, pitch: p.rotation.pitch,
          health: p.health, isDead: p.isDead, token,
        });
      }
      if (players.length > 0) {
        rooms.push({ name: room.name, mode: room.mode, map: room.mapSrc, bots: room.spec.bots,
          unlisted: room.mods.unlisted || undefined, noCreatures: room.mods.noCreatures || undefined,
          noBalls: room.mods.noBalls || undefined, instagib: room.mods.instagib || undefined,
          gungame: room.mods.gungame || undefined, igun: room.mods.igun || undefined, players });
      }
    }
    return { v: 1, rooms };
  }

  /** Re-seat the exported snapshot: rebuild rooms, drop each human body
   *  back at its saved spot, park the session in grace - the client's
   *  normal reconnect then walks the existing reclaim path (token check,
   *  resumeSeq replay, respawn re-arm) untouched. */
  restoreFrom(raw: unknown): void {
    const s = raw as RestoreState | null;
    if (!s || s.v !== 1 || !Array.isArray(s.rooms)) {return;}
    let seated = 0;
    for (const rs of s.rooms) {
      if (!rs || typeof rs.name !== 'string' || !Array.isArray(rs.players)) {continue;}
      const room = this.factory.roomFor(rs.name, rs.mode ?? '', rs.map ?? '', rs.bots,
        roomModsOf(rs as RoomMods));
      if (!room) {continue;}
      for (const ps of rs.players) {
        if (!ps || typeof ps.id !== 'string' || typeof ps.token !== 'string') {continue;}
        // A corrupt blob must not seed NaN bodies into a live room.
        if (!ps.pos || !Number.isFinite(ps.pos.x) || !Number.isFinite(ps.pos.y) || !Number.isFinite(ps.pos.z)) {continue;}
        if (ps.vel && !(Number.isFinite(ps.vel.x) && Number.isFinite(ps.vel.y) && Number.isFinite(ps.vel.z))) {continue;}
        if (ps.health !== undefined && !Number.isFinite(ps.health)) {continue;}
        if (room.players.getPlayer(ps.id)) {continue;}
        const p = room.players.addPlayer(ps.id, ps.team, ps.perk ?? 'none', room.mods.instagib === true ? 'light' : (room.mods.igun === true ? 'medium' : (ps.armorClass ?? 'medium')));
        p.position = Object.assign({}, ps.pos);
        p.velocity = Object.assign({}, ps.vel);
        p.rotation.yaw = ps.yaw ?? 0;
        p.rotation.pitch = ps.pitch ?? 0;
        p.lastValidPosition = Object.assign({}, ps.pos);
        if (typeof ps.health === 'number') {p.health = ps.health;}
        p.isDead = ps.isDead === true;
        p.pendingRespawn = p.isDead;
        p.name = ps.name;
        // Banked mid-match picks ride the blob - a restart must not eat
        // the classUpdate/perkUpdate the player was owed at next life.
        p.pendingClass = room.mods.instagib !== true && room.mods.igun !== true && (ps.pendingClass === 'light' || ps.pendingClass === 'medium' || ps.pendingClass === 'heavy') ? ps.pendingClass : undefined;
        p.pendingPerk = ps.pendingPerk;
        // A mid-fight seat, not a fresh spawn - no protection bubble.
        p.protectedUntil = simMs(0);
        room.sessionTokens.set(ps.id, ps.token);
        this.playerRoom.set(ps.id, room);
        this.registry.seedGrace(ps.id, room.name, this.reconnectGraceMs,
          (): void => this.removePlayerCompletely(room, ps.id, 'grace period'));
        room.messages.onPlayerDisconnected(ps.id);
seated += 1;
      }
      logger.info('Restored seats across restart', { room: room.name, players: rs.players.length });
    }
    if (seated) {logger.info('Restart restore complete', { seats: seated });}
  }

  stop(): void {
    this.tickLoop.stop();
    // Deliver real close frames first - server.stop(true) severs sockets
    // mid-flight, so without this every player sees a mystery drop on
    // both the banner and their logs rather than 'server restarting'.
    for (const room of this.rooms.values()) {room.connections.closeAll(1001, 'server restarting');}
    for (const room of this.specRooms.values()) {room.connections.closeAll(1001, 'server restarting');}
    // Flush authoritative demos BEFORE the process dies - a graceful
    // shutdown is the last chance to land the room's capture.
    const demoDir = process.env.FPS_DEMO;
    if (demoDir) {
      for (const room of this.rooms.values()) {
        if (!room.demo) {continue;}
        try { logger.info('server demo written', { room: room.name, path: room.demo.flush(demoDir, '-shutdown') }); }
        catch (error) { logger.warn('server demo flush failed', { room: room.name, err: String(error) }); }
      }
    }
    if (this.bunServer) {
      this.bunServer.stop(true).catch((): void => { /* shutdown path - exit owns the outcome */ });
      logger.info('Server stopped');
    }
  }

  private handleHandshake(ws: ServerWebSocket<WebSocketData>, raw: unknown): void {
    this.sessions.handle(ws, raw);
  }

  // Garbage-flood bound: every bad message is counted, but warning about
  // each one trades a wire flood for a log-IO flood - one warn per
  // player per window keeps the abuse visible without the write cost.
  private readonly invalidWarnAt = new Map<string, number>();
  private static readonly INVALID_WARN_GAP_MS = 5000;

  /** Garbage-frame strikes: a legit client emits zero invalid frames
   *  (the validator accepts everything it sends), so the cap is pure
   *  headroom for a buggy one. Past it the socket is a garbage pumper,
   *  not a player: close it or the parse loop is free DoS. */
  private static readonly GARBAGE_FRAME_CAP = 64;
  private garbageStrike(ws: ServerWebSocket<WebSocketData>): void {
    const n = (ws.data.badFrames = (ws.data.badFrames ?? 0) + 1);
    if (n >= GameServer.GARBAGE_FRAME_CAP) {
      logger.warn('Closing garbage-flood socket', { playerId: ws.data.playerId, badFrames: n });
      try { ws.close(1008, 'garbage flood'); } catch { /* already dying */ }
    }
  }

  /** One warn per sender per window for every garbage-frame path -
   *  parse/binary rejects arrive before validation, so they share this
   *  throttle or a malformed flood bypasses the bound entirely. */
  private invalidWarn(playerId: string | undefined, msg: string, data?: Record<string, unknown>): void {
    const key = playerId ?? 'prejoin';
    const now = wallNow();
    if (now - (this.invalidWarnAt.get(key) ?? 0) >= GameServer.INVALID_WARN_GAP_MS) {
      this.invalidWarnAt.set(key, now);
      if (this.invalidWarnAt.size > 4096) {evictEldest(this.invalidWarnAt);}
      logger.warn(msg, Object.assign({playerId}, data));
    }
  }

  /** Binary-decoded frames arrive pre-shaped and range-checked inside
   *  decodePosition/decodeInputMove - the JSON validator would re-walk
   *  ~30Hz×players of known-good objects for nothing. */
  private handleGameMessageTrusted(room: Room, playerId: string, msg: ClientMessage): void {
    this.dispatchMessage(room, playerId, msg, true);
  }

  private handleGameMessage(room: Room, playerId: string, raw: unknown, ws?: ServerWebSocket<WebSocketData>): void {
    const result = validateMessage(raw);
    if (!result.success) {
this.ops.msgsRejected += 1;
      this.invalidWarn(playerId, 'Invalid message rejected', { room: room.name, error: result.error });
      if (ws) {this.garbageStrike(ws);}
      return;
    }
    this.dispatchMessage(room, playerId, result.data);
  }

  private dispatchMessage(room: Room, playerId: string, data: ClientMessage, trusted = false): void {
this.ops.msgsIn += 1;
    // Backstop bound: legit traffic is ~20 reports + a few actions per
    // player per tick (~500 for a full room) - a flooding client would
    // otherwise grow this array unboundedly between drains and stall the
    // cmd phase for everyone. Excess counts as rejected (the metric is
    // the observability surface - a per-drop log would spam, since a
    // flooded queue parks at the cap until the next drain).
    if (room.commands.length >= 2000) {
this.ops.msgsRejected += 1;
      return;
    }
    // FAST_MSG_TYPES carries the ordering rationale - see its declaration.
    const fast = data.type;
    if (FAST_MSG_TYPES.has(fast)) {
      try { room.messages.handleMessage(playerId, data, wallNow(), trusted); }
      catch (error) { logger.warn('Telemetry handler threw', { playerId, type: data.type, error }); }
      return;
    }
    // shotFired stays parked (fireAt-ordered adjudication), but the
    // cosmetic muzzle relay emits on arrival - observers see the flash
    // ~a queue-tick earlier; the drain skips its own re-emit via shotId.
    if (fast === 'shotFired') {
      try { room.earlyShotRelay?.(playerId, data); }
      catch (error) { logger.warn('earlyShotRelay threw', { playerId, error }); }
    }
    // Command buffer: effects land at phase 0 of the next room tick, in
    // arrival order - sims never see a mid-frame mutation order. The
    // arrival stamp feeds the rate limiter: a stalled tick draining a
    // backlog must not count every queued report inside one window.
    room.commands.push({ playerId, msg: data, at: wallNow() });
  }

  // Full teardown shared by grace expiry and idle reap - the five stores
  // and the broadcast must move together or a stale slot/token leaks.
  /** Single spectator exit path - onClose and SessionManager's id-claim
   *  both route here so the room roster, connection, specRooms index and
   *  session record always die together. closeCode closes the spectator's
   *  socket first when its departure is server-initiated (id claim). */
  departSpectator(playerId: string, reason: string, closeCode?: number): boolean {
    const specRoom = this.specRooms.get(playerId);
    if (!specRoom) {return false;}
    if (closeCode !== undefined) {specRoom.connections.getConnection(playerId)?.close(closeCode, reason);}
    specRoom.spectators.delete(playerId);
    specRoom.connections.unregister(playerId);
    this.specRooms.delete(playerId);
    this.registry.terminate(playerId, reason);
    logger.info('Spectator left', { playerId, room: specRoom.name });
    return true;
  }

  private removePlayerCompletely(room: Room, playerId: string, reason: string): void {
    this.registry.terminate(playerId, reason);
    room.removePlayerCompletely(playerId, reason, (m, o): void => logger.info(m, o));
    this.playerRoom.delete(playerId);
this.ops.leaves += 1;
  }

}