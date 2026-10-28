// Client-side WebRTC socket for netbot — same node-datachannel stack the
// server's /rtcs tier uses, but as the offerer. Produces the same 'game' +
// 'ctrl' datachannel pair the browser creates (RtcSocketAdapter expects
// both labels; everything real rides ctrl).
//
// Signaling rides a plain WebSocket to /rtcs: we gather candidates
// non-trickle (the server answers the same way), send {type:'offer',sdp},
// setRemote the {type:'answer'} back. ICE cannot cross cloudflared (it's
// HTTP/TCP only — the datachannel is direct UDP), so this transport is
// loopback/LAN coverage only.
//
// The PeerConnection class is INJECTED, not imported: 'node-datachannel'
// resolves under server_bun/node_modules, so the caller (a bun test or a
// script run from server_bun) hands the class in and this file stays
// dependency-free.
export interface NdDataChannel {
  sendMessage(msg: string): void;
  sendMessageBinary(msg: Uint8Array): void;
  onMessage(cb: (msg: string | Uint8Array) => void): void;
  onOpen(cb: () => void): void;
  onClosed(cb: () => void): void;
  isOpen(): boolean;
  close(): void;
}
export interface NdPeerConnection {
  createDataChannel(label: string): NdDataChannel;
  setLocalDescription(type?: string): void;
  setRemoteDescription(sdp: string, type: string): void;
  localDescription(): { sdp: string; type: string } | undefined;
  onGatheringStateChange(cb: (state: string) => void): void;
  close(): void;
}
export interface NdModule {
  PeerConnection: new (name: string, cfg: { iceServers: { hostname: string; port: number; relayer?: boolean }[] }) => NdPeerConnection;
}

/** The slice of the WebSocket surface NetClient actually uses — a real
 *  WebSocket satisfies it unchanged. */
export interface BotSocket {
  send(data: string): unknown;
  readyState: number;
  close(): void;
}

export class RtcGameSocket implements BotSocket {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;

  private constructor(
    private pc: NdPeerConnection,
    private game: NdDataChannel,
    private ctrl: NdDataChannel,
  ) {}

  static async dial(sigUrl: string, nd: NdModule, iceServers: { hostname: string; port: number; relayer?: boolean }[] = [], timeoutMs = 15_000): Promise<RtcGameSocket> {
    const pc = new nd.PeerConnection('bot', { iceServers });

    let fail!: (e: Error) => void;
    const dead = new Promise<never>((_, rej) => { fail = rej; });
    const timer = setTimeout(() => {
      try { pc.close(); } catch { /* gone */ }
      fail(new Error('rtc dial timeout'));
    }, timeoutMs);

    // Gather non-trickle: the offer carries all candidates, matching the
    // server's answer-side gather — no trickle messages on either end.
    // REGISTERED BEFORE createDataChannel: libdatachannel (0.33.x under
    // Bun) never invokes a gather callback installed after a datachannel
    // exists — verified empirically, the callback simply never fires.
    const gathering = new Promise<void>((res) => {
      pc.onGatheringStateChange((s) => { if (s === 'complete') {res();} });
    });
    const game = pc.createDataChannel('game');
    const ctrl = pc.createDataChannel('ctrl');
    const sock = new RtcGameSocket(pc, game, ctrl);

    // No-arg form — the server uses it for answers and libdatachannel
    // picks the type from signaling state (offer, since we haven't
    // received a remote description).
    pc.setLocalDescription();
    await Promise.race([gathering, dead]);
    const offer = pc.localDescription();
    if (!offer) { clearTimeout(timer); throw new Error('rtc: no local description'); }

    // One offer in, one answer out, then the signal socket is disposable —
    // same shape the browser uses.
    const signal = new WebSocket(sigUrl);
    const answer = await Promise.race([new Promise<{ sdp: string }>((res, rej) => {
      signal.onmessage = (ev) => {
        try {
          const m = JSON.parse(String(ev.data));
          if (m.type === 'answer') {res({ sdp: m.sdp });}
        } catch { /* not ours */ }
      };
      signal.onerror = () => rej(new Error('rtc signal error'));
      signal.onclose = (ev) => rej(new Error(`rtc signal closed ${ev.code}`));
      signal.onopen = () => signal.send(JSON.stringify({ type: 'offer', sdp: offer.sdp }));
    }), dead]);
    signal.close();
    pc.setRemoteDescription(answer.sdp, 'answer');

    const wire = (dc: NdDataChannel) => {
      dc.onOpen(() => sock.onopen?.());
      dc.onMessage((msg) => {
        const data = msg instanceof Uint8Array ? msg.buffer as ArrayBuffer : String(msg);
        sock.onmessage?.({ data });
      });
      dc.onClosed(() => {
        // The server counts the seat live while EITHER lane is open — only
        // declare dead when both are gone.
        if (!game.isOpen() && !ctrl.isOpen()) {sock.onclose?.({ code: 1000, reason: 'rtc lanes closed' });}
      });
    };
    wire(game);
    wire(ctrl);
    // The channels still have to OPEN — returning early would let the
    // caller arm its handshake against a socket that can never connect.
    await Promise.race([new Promise<void>((res) => {
      const orig = sock.onopen;
      sock.onopen = () => { orig?.(); res(); };
    }), dead]);
    clearTimeout(timer);
    return sock;
  }

  get readyState(): number { return this.game.isOpen() || this.ctrl.isOpen() ? 1 : 0; }

  send(data: string | Uint8Array): void {
    const dc = this.ctrl.isOpen() ? this.ctrl : this.game;
    if (typeof data === 'string') {dc.sendMessage(data);} else {dc.sendMessageBinary(data);}
  }

  close(): void {
    try { this.game.close(); } catch { /* gone */ }
    try { this.ctrl.close(); } catch { /* gone */ }
    try { this.pc.close(); } catch { /* gone */ }
  }
}
