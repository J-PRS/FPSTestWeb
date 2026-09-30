// Two node-datachannel peers hole-punch over the /rtc relay.
//   bun tools/_punchtest.ts --url accommodate-rna-pads-fired   (tunnel)
//   bun tools/_punchtest.ts                                   (localhost)
const arg = (k: string, d: string): string => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const normUrl = (u: string): string => {
  if (!u.includes('://')) u = `wss://${u.includes('.') ? u : u + '.trycloudflare.com'}`;
  return u.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:').replace(/\/(ws|rtc|rtcs).*$/, '');
};
const URL_ = `${normUrl(arg('url', 'ws://localhost:8000'))}/rtc?room=${arg('room', 'punch7')}`;
const nd = await import('node-datachannel');
const PeerConnection = (nd.default ?? nd).PeerConnection;
const ICE = { iceServers: [{ hostname: 'stun.l.google.com', port: 19302 }] };
const log = (m: string) => console.log('[punch]', m);

function sig(): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(URL_);
    ws.onopen = () => res(ws); ws.onerror = () => rej(new Error('sig fail'));
  });
}
function member(ws: WebSocket) {
  const box = { ws, msgs: [] as { t: string; sdp?: string; ice?: any; host?: boolean }[], waiters: [] as ((m: any) => void)[] };
  ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); const w = box.waiters.shift(); if (w) w(m); else box.msgs.push(m); };
  box.wait = () => new Promise<any>((res) => { const m = box.msgs.shift(); if (m) res(m); else box.waiters.push(res); });
  box.send = (m: any) => ws.send(JSON.stringify(m));
  return box as any;
}
const wsA = member(await sig());
const wsB = member(await sig());
const roleA = await wsA.wait(); const roleB = await wsB.wait();
log(`roles: A=${JSON.stringify(roleA)} B=${JSON.stringify(roleB)}`);
// host makes the offer on 'peer'
const pcA = new PeerConnection('A', ICE); const pcB = new PeerConnection('B', ICE);
pcA.onLocalCandidate((c: any) => wsA.send({ t: 'ice', ice: { candidate: c.candidate, sdpMid: c.mid } }));
pcB.onLocalCandidate((c: any) => wsB.send({ t: 'ice', ice: { candidate: c.candidate, sdpMid: c.mid } }));
const dc = pcA.createDataChannel('game');
const done = new Promise<boolean>((res) => { pcB.onDataChannel((d: any) => d.onOpen(() => res(true))); dc.onOpen(() => res(true)); });
// signal pump loops
async function pump(ws: any, pc: any) {
  for (;;) { const m = await ws.wait();
    if (m.t === 'offer') { pc.setRemoteDescription(m.sdp, 'offer'); pc.setLocalDescription(); ws.send({ t: 'answer', sdp: pc.localDescription().sdp.replace('a=setup:actpass','a=setup:active') }); }
    else if (m.t === 'answer') pc.setRemoteDescription(m.sdp, 'answer');
    else if (m.t === 'ice') pc.addRemoteCandidate(m.ice.candidate, m.ice.sdpMid);
    else if (m.t === 'peer') { pc.setLocalDescription(); ws.send({ t: 'offer', sdp: pc.localDescription().sdp }); }
  }
}
void pump(wsA, pcA); void pump(wsB, pcB);
const ok = await Promise.race([done, new Promise<boolean>((r) => setTimeout(() => r(false), 15000))]);
log(ok ? 'HOLE PUNCH OK — datachannel open' : 'PUNCH FAILED');
process.exit(ok ? 0 : 1);
