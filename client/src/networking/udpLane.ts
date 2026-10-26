/**
 * Native-shell volatile lane (client side). A running Electrobun/Tauri
 * shell exposes ws://127.0.0.1:8787 — a loopback ws→UDP relay in its main
 * process. The game session (join, match, edges) stays on the normal
 * ws/wt transport; ONLY volatile binary frames (position/input/shot
 * claims up, tick frames down) route through the shim.
 *
 * Adopt-don't-race: the ws session connects normally; when gameState
 * carries `udp:{token,port}` the lane opens the shim and every binary
 * send flips to it once it reports open. The shim's first datagram
 * (token-prefixed) binds the session on the server.
 */
const SHIM_URL = 'ws://127.0.0.1:8787/udp';
const TOKEN_BYTES = 16;

export class UdpLane {
  private ws: WebSocket | null = null;
  private token: Uint8Array | null = null;
  private open = false;

  /** gameState carried a bind — open the shim. Idempotent per session. */
  adopt(bind: { token: string; port: number }, onBinary: (b: Uint8Array) => void): void {
    if (this.ws !== null || !bind || typeof bind.token !== 'string') {return;}
    const token = new Uint8Array(TOKEN_BYTES);
    for (let i = 0; i < TOKEN_BYTES; i += 1) {token[i] = Number.parseInt(bind.token.slice(i * 2, i * 2 + 2), 16);}
    this.token = token;
    let ws: WebSocket;
    try { ws = new WebSocket(SHIM_URL); } catch { return; }
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', (): void => { this.open = true; });
    ws.addEventListener('close', (): void => { this.open = false; this.ws = null; });
    ws.addEventListener('error', (): void => { /* loopback shim absent — stay on ws */ });
    ws.addEventListener('message', (ev): void => {
      if (ev.data instanceof ArrayBuffer) {onBinary(new Uint8Array(ev.data));}
    });
    this.ws = ws;
  }

  /** Volatile send — [token][frame] through the shim. false = stay on ws. */
  send(frame: Uint8Array): boolean {
    if (!this.open || this.ws === null || this.token === null) {return false;}
    const dg = new Uint8Array(TOKEN_BYTES + frame.length);
    dg.set(this.token);
    dg.set(frame, TOKEN_BYTES);
    this.ws.send(dg);
    return true;
  }

  get live(): boolean { return this.open; }

  close(): void {
    this.open = false;
    this.token = null;
    const { ws } = this;
    this.ws = null;
    try { ws?.close(); } catch { /* gone */ }
  }
}
