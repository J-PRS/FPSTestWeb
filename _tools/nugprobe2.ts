import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:8000/ws');
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
let me: { x: number; y: number; z: number } | null = null;
let seq = 0;
ws.onmessage = (e): void => {
  if (typeof e.data !== 'string') {return;}
  const m = JSON.parse(e.data as string);
  if (m.type === 'gameState') { me = m.localPlayerState?.position ?? null; log('seated', JSON.stringify(me)); }
  else if (m.type === 'pickupSpawn' && m.kind === 'gem') { log(`GEM #${m.id} @ ${JSON.stringify(m.pos)} vel=${JSON.stringify(m.vel)}`); }
  else if (m.type === 'claimAck') { log(`claimAck seq=${m.seq} ok=${m.ok} reason=${m.reason ?? '-'}`); }
  else if (m.type === 'pickupGone') { log(`gone #${m.id} by=${m.by}`); }
  else if (m.type !== 'srvPing' && m.type !== 'ping' && m.type !== 'stateHash' && m.type !== 'ballRoster' && m.type !== 'crawlRoster' && m.type !== 'snapshot' && m.type !== 'playerJoined' && m.type !== 'playerHeld' && m.type !== 'teamUpdate' && m.type !== 'serverWarn' && m.type !== 'inputSync' && m.type !== 'wireIds' && m.type !== 'matchNotice' && m.type !== 'sessionToken' && m.type !== 'protocolInfo' && m.type !== 'pickupSpawn') {
    log(`other ${m.type}: ${JSON.stringify(m).slice(0, 150)}`);
  }
};
ws.onopen = (): void => {
  ws.send(JSON.stringify({ type: 'join', playerId: `np2-${Date.now() % 1e6}`, room: 'np2', mode: 'headhunt', bots: 0, map: 'rimrock' }));
  setTimeout(() => {
    if (!me) { log('no seat'); process.exit(2); }
    ws.send(JSON.stringify({ type: 'deploy', kind: 'nugget', position: { x: me.x + 2, y: me.y, z: me.z }, claimSeq: ++seq }));
    log('bare deploy sent');
  }, 800);
  setTimeout(() => { log('done — exiting'); process.exit(0); }, 6000);
};
ws.onerror = (): void => { log('err'); };
