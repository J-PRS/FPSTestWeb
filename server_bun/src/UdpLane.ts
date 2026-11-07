import { logger } from './logger.ts';
import { wireRx, wireTx, BIN_KIND } from './wireMeter.ts';

/**
 * Raw-UDP volatile lane (native-shell clients). The ws session owns the
 * reliable lane — this is ONLY the volatile path: seq'd binary frames
 * up (position/input claims), tick frames down. Datagrams never mutate
 * session state — they carry the same wire frames the ws binary lane
 * decodes, fed into the same trusted dispatch.
 *
 * Session bind: join over ws issues a 16B token (in gameState). Every
 * datagram is [token:16][frame]; the first datagram from an addr binds
 * addr→session, later ones must match. A datagram whose token doesn't
 * map to a live session is dropped — the lane can't mint sessions.
 */
const TOKEN_BYTES = 16;

type UdpSock = {
  send(buf: Uint8Array, port: number, host: string): void;
};

export class UdpLane {
  private sock: UdpSock | null = null;
  private tokenToPid = new Map<string, string>();
  private pidToToken = new Map<string, string>();
  private addrOf = new Map<string, { port: number; host: string }>();
  /** pid → wall ms of the last inbound datagram — staleness decides
   *  whether the down-lane is still real. */
  private lastRx = new Map<string, number>();
  /** Lane silence budget: no datagram in this window = the client-side
   *  shim is dead or the NAT blackholed the path — starving their tick
   *  stream on a corpse lane is the silent-failure mode. ~2 claim beats. */
  private static readonly STALE_MS = 2500;
  /** pid -> inbound frame hook, set by GameServer once the lane exists. */
  onFrame?: (playerId: string, frame: Uint8Array) => void;

  get port(): number { return this.portNum; }
  private portNum = 0;

  async listen(port: number): Promise<void> {
    this.sock = await Bun.udpSocket({
      port,
      socket: {
        data: (_s, buf, port, addr): void => this.onData(buf, port, addr),
      },
    }) as UdpSock;
    this.portNum = port;
    logger.info('udp lane listening', { port });
  }

  /** Mint a session token — called when gameState goes out. */
  issue(playerId: string): string {
    const token = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
    const hex = [...token].map((b): string => b.toString(16).padStart(2, '0')).join('');
    this.tokenToPid.set(hex, playerId);
    this.pidToToken.set(playerId, hex);
    return hex;
  }

  /** Session end — drop both maps so a stale token dies with it. */
  unbind(playerId: string): void {
    const token = this.pidToToken.get(playerId);
    if (token !== undefined) { this.tokenToPid.delete(token); }
    this.pidToToken.delete(playerId);
    this.addrOf.delete(playerId);
    this.lastRx.delete(playerId);
  }

  /** Bound AND alive — the send router consults this per frame: a stale
   *  lane falls back to ws ticks and self-heals on the next datagram. */
  live(playerId: string): boolean {
    const at = this.lastRx.get(playerId);
    return at !== undefined && Date.now() - at < UdpLane.STALE_MS;
  }

  bound(playerId: string): boolean { return this.addrOf.has(playerId); }

  /** Volatile lane send — tick frames to a bound session's addr. */
  sendTo(playerId: string, bytes: Uint8Array): void {
    const a = this.addrOf.get(playerId);
    if (a && this.sock) { wireTx(playerId, bytes.byteLength, BIN_KIND[bytes[1]!]!); this.sock.send(bytes, a.port, a.host); }
  }

  /** Per-source datagram budget: forged floods pay a counter read, not
   *  the token decode. Legit input peaks ~30/s; 200/s is far past it. */
  private static readonly RX_BUDGET = 200;
  private rxCounts = new Map<string, { n: number; reset: number }>();

  private onData(buf: Uint8Array, port: number, addr: string): void {
    if (buf.byteLength <= TOKEN_BYTES) {return;}
    const key = `${addr}:${port}`;
    const now = Date.now();
    let c = this.rxCounts.get(key);
    if (c === undefined) {
      if (this.rxCounts.size > 4096) {return;} // addr-flood: cap the map itself
      c = { n: 0, reset: now + 1000 };
      this.rxCounts.set(key, c);
    } else if (now >= c.reset) {
      c.n = 0; c.reset = now + 1000;
    }
    if (++c.n > UdpLane.RX_BUDGET) {return;}
    // Token is the map key — a datagram that doesn't carry a live token
    // can't reach a session (bind tokens are 128-bit, issued per join).
    let hex = '';
    for (let i = 0; i < TOKEN_BYTES; i += 1) { hex += buf[i]!.toString(16).padStart(2, '0'); }
    const pid = this.tokenToPid.get(hex);
    if (pid === undefined) {return;}
    const bound = this.addrOf.get(pid);
    if (!bound) {
      this.addrOf.set(pid, { port, host: addr });
      logger.info('udp lane bound', { playerId: pid, addr, port });
    } else if (bound.port !== port || bound.host !== addr) {
      // Addr migration: drop for now — a spoofed source can't rebind a
      // live session without the token anyway, and real NAT rebind
      // windows are a hardening pass, not the spike.
      return;
    }
    this.lastRx.set(pid, Date.now());
    const frame = buf.subarray(TOKEN_BYTES);
    wireRx(pid, frame.byteLength, BIN_KIND[frame[1]!]!);
    this.onFrame?.(pid, frame);
  }
}
