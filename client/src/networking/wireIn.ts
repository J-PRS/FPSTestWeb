// Inbound wire dispatch — the receive half of the wire seam.
//
// WireIn owns everything between "bytes/parsed frame arrive" and "world
// event fires": the handler table, the v3 wire-id roster + tick decode
// pool, and the per-room sequence watermarks (ev / tickSeq / hitSeq) that
// guard stale and re-delivered frames. What it does NOT own lives behind
// the host: NetworkManager keeps transport, the outbound claim/journal
// path, the remote-player roster store, and the onX event surface — the
// small host methods below are the whole back-channel.

import { ChildLogger } from '../core/Logger.js';
import {
  isWireFrame, decodeTickFrame, decodeBallSegment,
  WIRE_BALLSEG, SERVER_TICK_MS,
  type TickDecodePool,
} from '../../../shared/wire.js';
import type { ServerMessage, TickUpdatePlayer } from '../../../shared/protocol.js';
import { PROTOCOL_VERSION } from '../../../shared/protocol.js';
import { WeaponType } from '../../../shared/weapons.js';
import { claim as netProbeClaim } from '../debug/netProbe.js';
import { rejectCensus, dedupCensus, dropCensus } from './claimLedger.js';
import type { NetworkManager } from './NetworkManager.js';

const logger = new ChildLogger('Wire');

export class WireIn {
  /** v3 tick-frame roster: u16 -> playerId, fed by 'wireIds' events that
   *  always precede the first frame referencing them (same socket). */
  private readonly wireIds = new Map<number, string>();
  /** Decode slots reused every tick — upsert deep-fills roster vecs so
   *  rostered values never alias a slot (see decodeTickFrame pool docs). */
  private readonly tickPool: TickDecodePool = { slots: [], resolveId: (id) => this.wireIds.get(id) };

  private lastTickSeq = -1; // highest server tickSeq applied — stale frames drop
  /** Last processed reliable `ev` seq — the host presents it as
   *  resumeSeq on a token-carrying join so the server replays only the
   *  missed frames. */
  private lastEv = 0;
  /** Reconnect grace lets the server replay in-flight playerHit events —
   *  seq is per-room monotonic so a stale re-delivery can't double-apply.
   *  Reset on disconnect/gameState: a new room's seq restarts at 1, and a
   *  retained high watermark would silently drop every hit for the whole
   *  session — the "half my damage instances don't work" desync. */
  private lastHitSeq = 0;

  /** Ring of recent health-affecting events — read by the desync dump so a
   *  hash mismatch says WHICH event diverged, not just that one did. */
  private readonly recentHealthEvents: { type: string; t: number; detail: string }[] = [];
  private static readonly HEALTH_EVENT_TYPES = new Set(['playerHit', 'playerKill', 'playerRespawn', 'buff', 'heal']);

  constructor(private readonly h: NetworkManager) {}

  /** Reliable-side watermark for the join handshake's resumeSeq. */
  get evWatermark(): number { return this.lastEv; }

  recentEvents(): readonly { type: string; t: number; detail: string }[] {
    return this.recentHealthEvents;
  }

  /** A disconnect starts fresh per-room seq spaces — a retained high
   *  watermark would silently drop every hit/tick of the next session. */
  resetForReconnect(): void {
    this.lastTickSeq = -1;
    this.lastHitSeq = 0;
  }

  /** Wire-feed seam — one message through the live dispatch path, so
   *  recorded streams (.rec replays) and sockets are indistinguishable. */
  dispatch(data: ServerMessage | Uint8Array): void {
    if (typeof data === 'object' && !(data instanceof Uint8Array)) this.message(data);
    else this.binary(data as Uint8Array);
  }

  message(data: ServerMessage): void {
    this.h.noteRx(JSON.stringify(data).length); // rx approximation — JSON events are sparse
    // Offset cursor: every reliable frame carries a room-scoped `ev`.
    // Replays only ever carry seq > our watermark, so tracking the max
    // doubles as the dup guard if a transport ever re-delivers.
    const ev = (data as ServerMessage & { ev?: number }).ev;
    if (ev !== undefined && ev > this.lastEv) this.lastEv = ev;
    // Capture the server-issued session token for future reconnects.
    // gameState also re-seeds the ev watermark: `ev` is room-scoped, so a
    // room hop or fresh join must adopt THIS room's seq, not max() against
    // a stale watermark from the old room.
    if (data?.type === 'gameState') {
      if (ev !== undefined) this.lastEv = ev;
      if (typeof data.sessionToken === 'string') this.h.acceptSessionToken(data.sessionToken);
    }
    if (WireIn.HEALTH_EVENT_TYPES.has(data.type)) {
      if (this.recentHealthEvents.length >= 24) this.recentHealthEvents.shift();
      const d = data as Record<string, unknown>;
      this.recentHealthEvents.push({ type: data.type, t: Date.now(), detail: `${d.shooterId ?? d.playerId ?? ''}→${d.targetId ?? ''} ${d.damage ?? ''}` });
    }
    // Avoid JSON.stringify on every message — tickUpdate arrives at 20Hz
    const handler = this.handlers[data.type] as ((d: ServerMessage) => void) | undefined;
    if (handler) {
      // A malformed-but-parseable message mustn't reach the connection's
      // onError path — one bad packet shouldn't cost a reconnect.
      try { handler(data); }
      catch (e) { logger.warn(`Handler threw for ${data.type}`, e); }
    } else {
      logger.warn(`Unknown message type: ${data.type}`);
    }
  }

  binary(data: Uint8Array): void {
    this.h.noteRx(data.length);
    if (!isWireFrame(data)) {
      logger.debug(`Received non-wire binary message: ${data.length} bytes`);
      return;
    }
    // Binary ball segments decode straight into the JSON message's shape —
    // netBallSegment sees one type regardless of transport.
    if (data[1] === WIRE_BALLSEG) {
      const seg = decodeBallSegment(data);
      if (seg) this.h.onBallSegment?.({
        type: 'ballSegment',
        id: seg.id, kind: seg.kind,
        position: seg.position, velocity: seg.velocity,
        enraged: seg.enraged, targetId: seg.targetId,
        tp: seg.tp, et: seg.et, slowT: seg.slowT, damp: seg.damp, t: seg.t,
      });
      return;
    }
    const tick = decodeTickFrame(data, this.tickPool);
    if (!tick) return;
    // Stale-drop: under an unordered transport a late frame carries an older
    // tickSeq — interpolating it would rewind remotes. On TCP this never
    // trips (frames can't reorder); it exists for the UDP tiers.
    if (tick.tickSeq <= this.lastTickSeq) return;
    this.lastTickSeq = tick.tickSeq;
    this.handleTickUpdate(tick);
  }

  private readonly handlers: { [K in ServerMessage['type']]: (data: Extract<ServerMessage, { type: K }>) => void } = {
    gameState: (data) => this.handleGameState(data),
    tickUpdate: (data) => this.handleTickUpdate(data),
    playerJoined: (data) => this.handlePlayerJoined(data),
    playerLeft: (data) => this.handlePlayerLeft(data),
    wireIds: (data) => {
      for (const [id, pid] of Object.entries(data.add)) this.wireIds.set(Number(id), pid);
      for (const id of data.remove ?? []) this.wireIds.delete(id);
    },
    teamUpdate: (data) => this.h.upsertRemotePlayer(data.playerId, { team: data.team }),
    playerRespawn: (data) => this.handlePlayerRespawn(data),
    playerHit: (data) => this.handlePlayerHit(data),
    buff: (data) => this.h.onBuff?.(data),
    yourHealth: (data) => this.h.onYourHealth?.(data.health),
    yourCharge: (data) => this.h.onYourCharge?.(data.charge),
    playerKill: (data) => this.handlePlayerKill(data),
    knockback: (data) => this.h.onKnockback?.(data.position, data.force, data.pull),
    jump: (data) => this.h.onPlayerJump?.(data.playerId, data.position),
    jetpack: (data) => this.h.onPlayerJetpack?.(data.playerId, data.position),
    projectileCreated: (data) => this.h.onProjectileCreated?.(data.projectileId, data.ownerId, data.position, data.velocity, data.weaponType, data.shotId),
    playerShot: (data) => this.h.onPlayerShot?.(data.id, data.weaponType, data.pos, data.dir),
    projectileDestroyed: (data) => this.h.onProjectileDestroyed?.(data.projectileId, data.shotId),
    snapshot: (data) => this.h.onSnapshot?.(data.players || [], data.timestamp || Date.now()),
    stateHash: (data) => this.h.onStateHash?.(data.hash, data.tick, data.playerCount, data.timestamp, data.ballHash, data.creatureHash, data.deployHash, data.flagHash, data.pickupHash, data.creatureFields, data.deployFields),
    correction: (data) => this.handleCorrection(data),
    inputSync: (data) => this.h.resendInputs(data.lastSeq),
    claimAck: (data) => this.h.ackClaim(data),
    teleport: (data) => this.h.onRemoteTeleport?.(data.playerId, data.position, data.velocity),
    ballSpawn: (data) => this.h.onBallSpawn?.(data),
    ballSegment: (data) => this.h.onBallSegment?.(data),
    ballDie: (data) => this.h.onBallDie?.(data),
    ballRoster: (data) => this.h.onBallRoster?.(data),
    crawlSpawn: (data) => this.h.onCrawlSpawn?.(data),
    crawlEvt: (data) => this.h.onCrawlEvt?.(data),
    crawlDie: (data) => this.h.onCrawlDie?.(data),
    crawlRoster: (data) => this.h.onCrawlRoster?.(data),
    pong: (data) => this.h.pongReceived(data.timestamp),
    chat: (data) => this.h.onChat?.(data.playerId, data.text, data.team === true, typeof data.vgs === 'string' ? data.vgs : undefined, data.muted === true),
    flagUpdate: (data) => this.h.onFlagUpdate?.(data.flags),
    matchNotice: (data) => this.h.onMatchNotice?.(data.text),
    serverWarn: (data) => this.h.onServerWarn?.(data.text),
    // WT/RTC path of the 1008 identity reject — the close code is lost
    // on those tiers, so the server sends this before closing.
    sessionRejected: (data) => this.h.rejectSession(data.reason),
    pickupSpawn: (data) => this.h.onPickupSpawn?.(data.id, data.pos, data.kind),
    pickupGone: (data) => this.h.onPickupGone?.(data.id, data.by ?? null),
    teamScore: (data) => this.h.onTeamScore?.(data.scores, data.winAt),
    ffaScore: (data) => this.h.onFfaScore?.(data.scores, data.winAt),
    ffaMatchEnd: (data) => this.h.onFfaMatchEnd?.(data.winner, data.scores),
    matchEnd: (data) => this.h.onMatchEnd?.(data.winner, data.scores),
    matchStart: (data) => this.h.onMatchStart?.(data.mode, data.scores),
    mapUpdate: (data) => this.h.onMapUpdate?.(data),
    deploySpawn: (data) => this.h.onDeploySpawn?.(data.id, data.owner, data.kind, data.pos, data.team),
    deployGone: (data) => this.h.onDeployGone?.(data.id),
    deployDown: (data) => this.h.onDeployDown?.(data.id, data.kind, data.team, data.respawnS),
    deployUp: (data) => this.h.onDeployUp?.(data.id),
    sensorPing: (data) => this.h.onSensorPing?.(data.id, data.team, data.targets),
    turretShot: (data) => this.h.onTurretShot?.(data.id, data.owner, data.targetId),
    sentryShot: (data) => this.h.onSentryShot?.(data.id, data.owner, data.x, data.y, data.z),
    mineBoom: (data) => this.h.onMineBoom?.(data.id, data.pos),
    deployHp: (data) => this.h.onDeployHp?.(data.id, data.hp, data.armor, data.src),
    // Server refused a hit claim — worth surfacing: a healthy client
    // should basically never see this, so it's a desync tell.
    shotRejected: (data) => {
      rejectCensus.total++;
      rejectCensus.byReason.set(data.reason, (rejectCensus.byReason.get(data.reason) ?? 0) + 1);
      rejectCensus.last = `${data.reason}${data.targetId ? ` →${data.targetId}` : ''}`;
      if (data.targetId || data.shotId) this.h.confirmClaimHit(data.targetId ?? '', data.shotId);
      const wName = data.weaponType !== undefined ? String(WeaponType[data.weaponType] ?? data.weaponType) : undefined;
      netProbeClaim('reject', data.reason, wName, data.targetId, this.h.getPing());
      logger.error(`shot rejected — predicted damage never applied`, {
        reason: data.reason,
        targetId: data.targetId,
        weapon: wName,
        pingMs: this.h.getPing(),
      });
      this.h.onShotRejected?.(data.reason, data.targetId, data.weaponType, data.health);
    },
    // Honest-lag discard (dead shooter/target) — not a reject, but the
    // predicted hit still needs clearing or the ledger warns phantom.
    claimDropped: (data) => {
      dropCensus.total++;
      dropCensus.byReason.set(data.reason, (dropCensus.byReason.get(data.reason) ?? 0) + 1);
      dropCensus.last = `${data.reason}${data.targetId ? ` →${data.targetId}` : ''}`;
      if (data.targetId || data.shotId) this.h.confirmClaimHit(data.targetId ?? '', data.shotId);
      netProbeClaim('drop', data.reason, data.weaponType !== undefined ? String(WeaponType[data.weaponType] ?? data.weaponType) : undefined, data.targetId, this.h.getPing());
      logger.warn(`claim dropped — predicted damage never applied`, {
        reason: data.reason, targetId: data.targetId,
        weapon: data.weaponType !== undefined ? WeaponType[data.weaponType] ?? data.weaponType : undefined,
        pingMs: this.h.getPing(),
      });
      this.h.onShotRejected?.(data.reason, data.targetId, data.weaponType, data.health);
    },
  };

  private handleGameState(data: Extract<ServerMessage, { type: 'gameState' }>): void {
    // Protocol handshake: a stale bundle can't parse a new wire format —
    // force-reload once (cache-busted) instead of silently desyncing. The
    // sessionStorage counter caps it at 2 attempts so a genuinely newer
    // server can't reload-loop the tab.
    // A new gameState means a new room instance — both seq spaces
    // restart at 1 (hitSeq and tickSeq are per-room), so the prior
    // room's high watermarks must not gate it. A room hop without
    // reconnect would otherwise freeze every remote for the session.
    this.lastHitSeq = 0;
    this.lastTickSeq = -1;
    this.h.dropClaims(false);
    this.h.clearResyncQuiet(); // truth landed — position claims are judged fresh
    const serverProto = data.protocolVersion ?? 0;
    if (serverProto !== PROTOCOL_VERSION) {
      // Storage can throw (private mode / disabled embeds) — treat a dead
      // counter as budget spent: warn + bail, never crash the handler.
      let tries = 2;
      try { tries = Number(sessionStorage.getItem('fps-proto-reload') ?? '0'); } catch { /* fall through */ }
      logger.warn(`Protocol mismatch: client=${PROTOCOL_VERSION} server=${serverProto} (attempt ${tries + 1})`);
      // Browser-only escape: headless harnesses (vitest, e2e replays) have
      // no location to reload — they get the warn + early return only.
      if (tries < 2 && typeof location !== 'undefined') {
        try {
          sessionStorage.setItem('fps-proto-reload', String(tries + 1));
          const url = new URL(location.href);
          url.searchParams.set('pv', String(Date.now())); // cache-buster vs CDN staleness
          location.href = url.toString();
        } catch { /* storage/nav both optional — warn already logged */ }
      }
      return;
    }
    try { sessionStorage.removeItem('fps-proto-reload'); } catch { /* no budget to reset */ } // clean connect — reset the budget

    // gameState is the authoritative roster on (re)connect — clear stale
    // entries for players who left during our disconnect, then add the
    // current set. v3 ids are per-room: the snapshot replaces, not merges.
    this.wireIds.clear();
    if (data.wireIds) for (const [id, pid] of Object.entries(data.wireIds)) this.wireIds.set(Number(id), pid);
    this.h.remoteReset(data.players);
    logger.debug(`raw gameState map: ${data.map ? JSON.stringify(data.map).slice(0, 300) : 'none'}`);
    this.h.onGameState?.(data.players || [], data.localPlayerState, { room: data.room, mode: data.mode, mapName: data.mapName, team: data.team, scores: data.scores, ffaScores: data.ffaScores, pickups: data.pickups, flags: data.flags, matchEndsAt: data.matchEndsAt, respawnMs: data.respawnMs, deployables: data.deployables, map: data.map });
  }

  private handleTickUpdate(data: { updates: TickUpdatePlayer[]; count?: number; ackSeq?: number; inputAck?: number; tickSeq?: number }): void {
    this.h.tickArrived();
    // Batched player updates from server (delta compressed)
    if (data.ackSeq !== undefined && data.ackSeq > 0) {
      this.h.ackPositionSeq(data.ackSeq);
    }
    // Tick-set confirm: the server consumed inputs ≤ inputAck — those
    // journal entries are dead weight and only matter to replay.
    if (data.inputAck !== undefined && data.inputAck > 0) {
      this.h.ackInputs(data.inputAck);
    }
    if (!data.updates || !Array.isArray(data.updates)) return;
    const now = Date.now();
    // Snapshots must carry the SERVER timeline (tickSeq×50), not arrival
    // wall time — arrival stamps fold transport jitter into the rendered
    // path itself, which is the rubberband mechanism. The JSON path has
    // no tickSeq and keeps the arrival fallback (host/loopback: jitter≈0).
    const serverMs = data.tickSeq !== undefined ? data.tickSeq * SERVER_TICK_MS : now;
    // Pooled decode hands back its whole slots array + a live count —
    // entries past it are stale from earlier, larger frames.
    const n = data.count ?? data.updates.length;
    for (let i = 0; i < n; i++) {
      const u = data.updates[i]!;
      // v3 record ahead of its roster — can't build a body without an
      // identity, so it drops; the next record for that id resolves.
      if (!u.playerId) continue;
      this.applyTickPlayerUpdate(u, serverMs);
    }
  }

  private applyTickPlayerUpdate(u: TickUpdatePlayer, serverMs: number): void {
    // Defense-in-depth: server already excludes self from tickUpdate,
    // but skip local player here too in case of any server-side regression
    if (u.playerId === this.h.getLocalPlayerId()) return;
    this.h.upsertRemotePlayer(u.playerId, {
      internalId: u.internalId || undefined,
      position: u.position,
      rotation: u.rotation,
      velocity: u.velocity,
      isDead: u.isDead,
      health: u.health,
      ping: u.ping,
      ski: u.ski,
      status: u.status,
      sheep: u.sheep,
    });
    this.h.onPlayerUpdate?.(u.playerId, u.position, u.rotation, serverMs, u.velocity);
  }

  private handlePlayerJoined(data: Extract<ServerMessage, { type: 'playerJoined' }>): void {
    // Rejoins (grace-period reconnects) re-broadcast playerJoined — only the
    // FIRST sighting is a roster event. Upserting health/isDead on a rejoin
    // would stomp the server-truth values tickUpdate already delivered, and
    // re-firing onPlayerJoined spam-recreates/logs the remote every time.
    const isNew = !this.h.remoteHas(data.playerId);
    this.h.upsertRemotePlayer(data.playerId, {
      name: data.name,
      position: data.position,
      rotation: data.rotation,
      velocity: isNew ? { x: 0, y: 0, z: 0 } : undefined,
      // The announce carries real vitals — a grace rejoiner can return
      // wounded or dead; fabricating 100/alive was the tick-N desync.
      isDead: isNew ? (data.isDead ?? false) : undefined,
      health: isNew ? (data.health ?? 100) : undefined,
      team: data.team,
      transport: data.transport,
      armorClass: data.armorClass,
    });
    if (isNew) this.h.onPlayerJoined?.(data.playerId, data.position, data.rotation);
  }

  private handlePlayerLeft(data: Extract<ServerMessage, { type: 'playerLeft' }>): void {
    if (data.playerId) this.h.remoteDelete(data.playerId);
    this.h.onPlayerLeft?.(data.playerId);
  }

  private handlePlayerRespawn(data: Extract<ServerMessage, { type: 'playerRespawn' }>): void {
    // Update REMOTE player in storage (local player respawn handled by callback)
    if (data.position) {
      this.h.upsertRemotePlayer(data.playerId, {
        position: data.position,
        rotation: data.rotation,
        velocity: { x: 0, y: 0, z: 0 },
        isDead: false,
        health: 100,
      });
    }
    this.h.onPlayerRespawn?.(data.playerId, data.position, data.rotation, data.armorClass);
  }

  private handlePlayerHit(data: Extract<ServerMessage, { type: 'playerHit' }>): void {
    if (data.shooterId === this.h.getLocalPlayerId()) this.h.confirmClaimHit(data.targetId);
    if (data.seq !== undefined) {
      if (data.seq <= this.lastHitSeq) {
        dedupCensus.hitSeqDrops++;
        logger.warn(`playerHit dropped as stale seq ${data.seq} <= ${this.lastHitSeq}`);
        return;
      }
      this.lastHitSeq = data.seq;
    }
    // Update REMOTE player health in storage (local player health handled
    // by callback). A processed hit also proves the server holds the target
    // alive — it never lands a hit on a dead player — so a record still
    // marked dead from a lost respawn edge un-sticks here instead of
    // waiting for the hash-diff heal.
    this.h.upsertRemotePlayer(data.targetId, { health: data.health, isDead: false });
    this.h.onPlayerHit?.(data.shooterId, data.targetId, data.damage, data.health, data.armor);
  }

  private handlePlayerKill(data: Extract<ServerMessage, { type: 'playerKill' }>): void {
    // A kill IS the confirm — the fatal blow arrives as playerKill, not
    // playerHit, so the pending ledger would warn phantom otherwise.
    if (data.shooterId === this.h.getLocalPlayerId()) this.h.confirmClaimHit(data.targetId);
    // Update REMOTE player state (local player death handled by callback)
    this.h.upsertRemotePlayer(data.targetId, { isDead: true, health: 0 });
    this.h.onPlayerKill?.(data.shooterId, data.targetId, data.weapon, data.air);
  }

  private handleCorrection(data: Extract<ServerMessage, { type: 'correction' }>): void {
    // Server rejected our position — snap to last valid state
    logger.warn(`Server correction at seq ${data.seq}: pos=(${data.position.x.toFixed(1)},${data.position.y.toFixed(1)},${data.position.z.toFixed(1)})`);
    this.h.ackPositionSeq(data.seq);
    this.h.onCorrection?.(data.seq, data.position, data.velocity, data.rotation, data.inputSeq, data.grounded);
  }
}
