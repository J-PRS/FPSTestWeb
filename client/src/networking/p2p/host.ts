/**
 * P2P host authority — the real server modules running in the host's
 * browser. PlayerManager + CombatHandler + validation are reused verbatim
 * from server_bun/ (they're pure TS), so hit-claim validation, damage
 * clamps, respawn timers, and the wire codec are IDENTICAL to dedicated-
 * server rules — only the transport differs: links are a loopback (the
 * host's own client) or a WebRTC DataChannel (the guest).
 *
 * Deliberately absent vs GameServer: grace-period reconnects (a dropped
 * DataChannel rejoins fresh), ball sim (guests run client-side balls),
 * state-hash + idle reaper (two sockets, nothing to reap at scale).
 */

import { PlayerManager } from '../../../../server_bun/src/PlayerManager.js';
import { MessageHandler } from '../../../../server_bun/src/MessageHandler.js';
import { RateLimiter } from '../../../../server_bun/src/RateLimiter.js';
import { validateMessage } from '../../../../server_bun/src/wire.js';
import { validatePlayerId } from '../../../../server_bun/src/validation.js';
import { isWireFrame, decodePosition, encodeTickPlayer, encodeTickFrame } from '../../../../shared/wire.js';
import type { ServerMessage } from '../../../../shared/protocol.js';
import { ChildLogger } from '../../core/Logger.js';

const logger = new ChildLogger('P2PHost');

/** One peer's pipe into the authority — loopback or DataChannel-backed.
 *  send() takes the same frames a socket would: JSON text or binary wire. */
export interface P2PLink {
  send(data: string | Uint8Array): void;
  close(): void;
}

export class P2PHost {
  private playerManager = new PlayerManager();
  private rateLimiter = new RateLimiter();
  private messageHandler: MessageHandler;
  private links = new Map<P2PLink, string>(); // link → playerId
  private byPlayer = new Map<string, P2PLink>();
  private tickTimer: ReturnType<typeof setInterval>;
  private tickSeq = 0;

  constructor() {
    this.messageHandler = new MessageHandler(
      this.playerManager,
      this.rateLimiter,
      (msg, exclude) => this.broadcast(msg, exclude),
      (pid, msg) => this.sendJSON(pid, msg),
    );
    // 20Hz to match the dedicated server's tick cadence. With two players
    // there's no interest management — every frame carries the one peer.
    this.tickTimer = setInterval(() => this.tick(), 50);
  }

  /** Wire a guest's DataChannel in as a link — same treatment as the
   *  host's own loopback after this point. */
  attachDataChannel(dc: RTCDataChannel): void {
    dc.binaryType = 'arraybuffer';
    const link: P2PLink = {
      send: (data) => {
        if (dc.readyState !== 'open') {return;}
        if (typeof data === 'string') {dc.send(data);}
        else {dc.send(new Uint8Array(data));}
      },
      close: () => { try { dc.close(); } catch { /* gone */ } },
    };
    dc.addEventListener('message', (ev) => {
      const data = ev.data;
      this.onData(link, data instanceof ArrayBuffer ? new Uint8Array(data) : data as string);
    });
    dc.addEventListener('close', () => this.onClose(link));
    logger.info('Guest DataChannel attached');
  }

  /** A peer's outbound message (JSON string or binary position frame). */
  onData(link: P2PLink, data: string | Uint8Array): void {
    if (typeof data !== 'string') {
      if (!isWireFrame(data)) {return;}
      const playerId = this.links.get(link);
      if (!playerId) {return;} // binary before join — ignore
      const pos = decodePosition(data);
      if (pos) {this.dispatch(playerId, pos);}
      return;
    }

    let raw: unknown;
    try { raw = JSON.parse(data); } catch { return; }

    const playerId = this.links.get(link);
    if (!playerId) {
      // First message on a link must be the join handshake
      const msg = raw as { type?: string; playerId?: unknown };
      if (msg.type === 'join') {this.handleJoin(link, msg.playerId);}
      return;
    }
    this.dispatch(playerId, raw);
  }

  onClose(link: P2PLink): void {
    const playerId = this.links.get(link);
    if (!playerId) {return;}
    this.links.delete(link);
    this.byPlayer.delete(playerId);
    // No grace period on P2P — a dead socket is a leave, full stop.
    this.messageHandler.onPlayerDisconnected(playerId);
    this.messageHandler.onPlayerRemoved(playerId);
    this.rateLimiter.removePlayer(playerId);
    this.playerManager.removePlayer(playerId);
    this.broadcast({ type: 'playerLeft', playerId });
    logger.info('P2P peer left', { playerId });
  }

  private handleJoin(link: P2PLink, rawId: unknown): void {
    const res = validatePlayerId(rawId);
    if (!res.success) { link.close(); return; }
    const playerId = res.data;

    // Same id rejoining on a fresh link (guest reloaded): evict the old
    // one so the roster doesn't double.
    const stale = this.byPlayer.get(playerId);
    if (stale) { this.onClose(stale); stale.close(); }

    this.playerManager.addPlayer(playerId);
    this.links.set(link, playerId);
    this.byPlayer.set(playerId, link);
    // Session tokens are a server concept — P2P links are already
    // mutually authenticated by the room code, so a static token suffices.
    this.messageHandler.handleHandshake(playerId, 'p2p', false);
    logger.info('P2P peer joined', { playerId });
  }

  private dispatch(playerId: string, raw: unknown): void {
    const result = validateMessage(raw);
    if (!result.success) {return;}
    this.messageHandler.handleMessage(playerId, result.data);
  }

  private broadcast(msg: ServerMessage, excludePlayerId?: string): void {
    const text = JSON.stringify(msg);
    for (const [link, pid] of this.links) {
      if (pid === excludePlayerId) {continue;}
      try { link.send(text); } catch { /* one dead pipe mustn't sink the tick */ }
    }
  }

  private sendJSON(playerId: string, msg: ServerMessage): void {
    const link = this.byPlayer.get(playerId);
    if (!link) {return;}
    try { link.send(JSON.stringify(msg)); } catch { /* dead pipe */ }
  }

  private tick(): void {
    if (this.byPlayer.size < 2) {return;}
    const players = this.playerManager.getAllPlayers();
    for (const [recipientId] of players) {
      const link = this.byPlayer.get(recipientId);
      if (!link) {continue;}
      const records: Uint8Array[] = [];
      for (const [pid, p] of players) {
        if (pid === recipientId) {continue;}
        records.push(encodeTickPlayer({
          playerId: pid,
          position: p.position,
          rotation: p.rotation,
          velocity: p.velocity,
          health: p.health,
          isDead: p.isDead,
          ping: p.ping > 0 ? p.ping : undefined,
          ski: p.skiing,
        }));
      }
      if (records.length === 0) {continue;}
      // inputAck=0: the P2P host tracks no per-player input seqs — clients
      // ignore 0 (never prune on it).
      try { link.send(encodeTickFrame(this.playerManager.getLastSeq(recipientId), this.tickSeq++, 0, records)); } catch { /* dead pipe */ }
    }
  }

  stop(): void {
    clearInterval(this.tickTimer);
  }
}
