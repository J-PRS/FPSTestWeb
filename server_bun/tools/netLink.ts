/**
 * netLink — transport negotiation for wire-level test bots.
 *
 * Mirrors the browser client's tier order: RTC datachannel first
 * (unreliable lane kills head-of-line stutter), WS as the floor.
 * WebTransport has no client stack in Bun — skipped like a Firefox
 * client. node-datachannel is the same native lib the server answers
 * offers with — lazy-loaded so --net ws runs don't need it at all.
 */

/** Minimal socket shape — WebSocket and the RTC adapter both satisfy it. */
export interface Link {
  send(data: string | Uint8Array): void;
  close(): void;
  open(): boolean;
}

type NdcPc = {
  createDataChannel(label: string): NdcDc;
  setRemoteDescription(sdp: string, type: string): void;
  setLocalDescription(type?: string): void;
  localDescription(): { sdp: string; type: string } | undefined;
  onGatheringStateChange(cb: (s: string) => void): void;
  gatheringState(): string;
  close(): void;
};
type NdcDc = {
  sendMessage(m: string): void; sendMessageBinary(m: Uint8Array): void;
  onMessage(cb: (m: string | Uint8Array) => void): void;
  onOpen(cb: () => void): void; onClosed(cb: () => void): void;
  isOpen(): boolean; close(): void;
};

/** Best-effort RTC connect: offer over the /rtcs signal socket, data over
 *  'ctrl' like every send on the server adapter. Returns null on any
 *  failure so the caller falls to WS. `wsUrl` is the /ws endpoint — the
 *  signal socket and /rtcconfig are derived from it. */
export async function connectRtc(
  wsUrl: string,
  onMsg: (d: string | ArrayBuffer) => void,
  onClose: () => void,
): Promise<Link | null> {
  let nd: { PeerConnection: new (n: string, cfg: { iceServers: { hostname: string; port: number }[] }) => NdcPc };
  try { nd = (await import('node-datachannel')) as never; } catch { return null; }
  const mod = (nd as unknown as { default?: unknown }).default ?? nd;
  const Nd = mod as { PeerConnection: new (n: string, cfg: { iceServers: { hostname: string; port: number }[] }) => NdcPc };
  try {
    const httpBase = wsUrl.replace(/^wss?:/, wsUrl.startsWith('wss') ? 'https:' : 'http:').replace(/\/ws$/, '');
    const iceRaw = await fetch(`${httpBase}/rtcconfig`).then((r) => r.json()).catch(() => ({})) as { iceServers?: unknown[] };
    const iceServers: { hostname: string; port: number }[] = [];
    for (const e of Array.isArray(iceRaw?.iceServers) ? iceRaw.iceServers : []) {
      const urls = typeof e === 'string' ? [e] : (Array.isArray((e as { urls?: unknown }).urls) ? (e as { urls: string[] }).urls : [String((e as { urls?: unknown }).urls ?? '')]);
      for (const u of urls) {
        const m = typeof u === 'string' && u.match(/^(stun|turn)s?:\/\/([^:/]+):?(\d+)?/);
        if (m) iceServers.push({ hostname: m[2]!, port: m[3] ? +m[3] : 3478 });
      }
    }
    const pc = new Nd.PeerConnection('nb', { iceServers });
    const game = pc.createDataChannel('game');
    const ctrl = pc.createDataChannel('ctrl');
    const route = (d: string | Uint8Array) => onMsg(typeof d === 'string' ? d : d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer);
    game.onMessage(route); ctrl.onMessage(route);
    const signal = new WebSocket(wsUrl.replace(/\/ws$/, '/rtcs'));
    pc.setLocalDescription();
    if (pc.gatheringState() !== 'complete') {
      await new Promise<void>((res) => {
        const t = setTimeout(res, 2500);
        pc.onGatheringStateChange((s) => { if (s === 'complete') { clearTimeout(t); res(); } });
      });
    }
    const sdp = pc.localDescription()?.sdp;
    if (!sdp) { pc.close(); return null; }
    const answer = await new Promise<{ sdp?: string }>((res, rej) => {
      const t = setTimeout(() => rej(new Error('rtc signal timeout')), 10000);
      signal.onmessage = (ev) => {
        try {
          const m = JSON.parse(String(ev.data));
          if (m.type === 'answer') { clearTimeout(t); res(m); }
        } catch { /* not ours */ }
      };
      signal.onerror = () => rej(new Error('rtc signal error'));
      const offer = () => signal.send(JSON.stringify({ type: 'offer', sdp }));
      if (signal.readyState === WebSocket.OPEN) offer();
      else signal.onopen = offer;
    }).catch(() => null);
    if (!answer?.sdp) { try { signal.close(); pc.close(); } catch { /* gone */ } return null; }
    pc.setRemoteDescription(answer.sdp, 'answer');
    try { signal.close(); } catch { /* gone */ }
    // Wait for ctrl (reliable lane the server actually uses) to open.
    const opened = await new Promise<boolean>((res) => {
      const t = setTimeout(() => res(false), 8000);
      const check = () => { if (ctrl.isOpen() || game.isOpen()) { clearTimeout(t); res(true); } };
      ctrl.onOpen(check); game.onOpen(check);
      check();
    });
    if (!opened) { try { pc.close(); } catch { /* gone */ } return null; }
    const lane = () => (ctrl.isOpen() ? ctrl : game);
    ctrl.onClosed(onClose);
    game.onClosed(() => { if (!ctrl.isOpen()) onClose(); });
    return {
      send(data: string | Uint8Array) {
        const dc = lane();
        if (typeof data === 'string') dc.sendMessage(data);
        else dc.sendMessageBinary(data);
      },
      close() { try { game.close(); ctrl.close(); pc.close(); } catch { /* gone */ } },
      open() { return ctrl.isOpen() || game.isOpen(); },
    };
  } catch { return null; }
}
