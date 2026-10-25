import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:8000/ws');
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
let me: { x: number; y: number; z: number } | null = null;
let seq = 0;
ws.onmessage = (e): void => {
  if (typeof e.data !== 'string') { log(`BIN ${(e.data as ArrayBuffer).byteLength ?? '?'}B`); return; }
  const m = JSON.parse(e.data as string);
  if (m.type === 'gameState') { me = m.localPlayerState?.position ?? null; log('seated', JSON.stringify(me)); }
  else if (m.type === 'srvPing' || m.type === 'ping' || m.type === 'stateHash' || m.type === 'snapshot' || m.type === 'ballRoster' || m.type === 'crawlRoster' || m.type === 'wireIds') { /* quiet */ }
  else { log(m.type + ': ' + JSON.stringify(m).slice(0, 180)); }
};
ws.onopen = (): void => {
  ws.send(JSON.stringify({ type: 'join', playerId: `np3-${Date.now() % 1e6}`, room: 'np3', mode: 'headhunt', bots: 0, map: 'rimrock' }));
  setTimeout(() => {
    if (!me) { log('no seat'); process.exit(2); }
    ws.send(JSON.stringify({ type: 'deploy', kind: 'nugget', position: { x: me.x + 2, y: me.y, z: me.z }, claimSeq: ++seq }));
    log('bare deploy sent');
  }, 800);
  setTimeout(() => { log('done'); process.exit(0); }, 7000);
};
