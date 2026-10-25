// Real-socket nugget test: join localhost:8000, deploy a nugget, walk
// onto the gem, verify it collects (pickupGone + belt credit).
const ws = new WebSocket('ws://127.0.0.1:8000/ws');
const id = `probe-${Math.floor(Math.random() * 1e6)}`;
let pickups: { id: number; pos: { x: number; y: number; z: number }; kind: string }[] = [];
let me: { x: number; y: number; z: number } | null = null;
let gone: number[] = [];
let walletMsg: unknown = null;
let seq = 0;
let binCount = 0;

const log = (s: string): void => { console.log(`[${(performance.now() / 1000).toFixed(1)}s] ${s}`); };

ws.onmessage = (e): void => {
  if (typeof e.data !== 'string') { binCount++; return; } // binary lane — count, decode elsewhere
  const m = JSON.parse(e.data as string);
  if (m.type === 'gameState') {
    if (m.localPlayerState?.position) { me = m.localPlayerState.position; }
    for (const p of m.pickups ?? []) { pickups.push(p); }
    log(`gameState room=${m.room} mode=${m.mode} keys=${JSON.stringify(Object.keys(m))} local=${JSON.stringify(m.localPlayerState)}`);
  } else if (m.type === 'pickupSpawn') {
    pickups.push({ id: m.id, pos: m.pos, kind: m.kind });
    log(`pickupSpawn #${m.id} ${m.kind} @ ${JSON.stringify(m.pos)}`);
  } else if (m.type === 'pickupGone') {
    gone.push(m.id);
    log(`pickupGone #${m.id} by=${m.by}`);
  } else if (m.type === 'deploySpawn' || m.type === 'deployGone' || m.type === 'claimAck' || m.type === 'serverWarn' || m.type === 'reject' || m.type === 'shotRejected') {
    log(`${m.type}: ${JSON.stringify(m)}`);
  } else if (m.type === 'wallet' || m.type === 'beltCharges' || m.beltCharges !== undefined) {
    walletMsg = m;
    log(`wallet-ish: ${JSON.stringify(m)}`);
  } else if (m.type !== 'gameState' && m.type !== 'snapshot' && m.type !== 'ping' && m.type !== 'srvPing' && m.type !== 'stateHash' && m.type !== 'matchNotice' && m.type !== 'teamUpdate' && m.type !== 'playerJoined') {
    log(`unhandled ${m.type}: ${JSON.stringify(m).slice(0, 200)}`);
  }
};

ws.onopen = (): void => {
  ws.send(JSON.stringify({ type: 'join', playerId: id, room: 'nugget-probe', mode: 'headhunt', bots: 0 }));
  setTimeout(() => {
    if (!me) { log('no position yet'); process.exit(2); }
    // Deploy nugget 4m ahead.
    // At the player's feet — MAX_PLANT_DIST is 3D and spawn y is ~60.
    ws.send(JSON.stringify({ type: 'deploy', kind: 'nugget', position: { x: me.x + 4, y: me.y - 1, z: me.z }, claimSeq: ++seq }));
    log('deploy nugget sent');
  }, 800);
  // Teleport onto the gem once it exists.
  const walk = setInterval(() => {
    const gem = pickups.find((p) => p.kind === 'gem');
    if (gem && !gone.includes(gem.id)) {
      ws.send(JSON.stringify({ type: 'teleport', pos: { x: gem.pos.x, y: gem.pos.y + 0.5, z: gem.pos.z }, seq: ++seq }));
      log(`teleport onto gem #${gem.id}`);
      clearInterval(walk);
    }
  }, 300);
  setTimeout(() => {
    const gems = pickups.filter((p) => p.kind === 'gem');
    console.log('\n=== RESULT ===');
    console.log(`gems spawned: ${gems.length}  gone: ${gone.length}  binFrames: ${binCount}`);
    console.log(`wallet msg: ${JSON.stringify(walletMsg)}`);
    const ok = gems.length >= 1 && gone.length >= 1;
    console.log(ok ? 'PASS — nugget landed, persisted, and collected' : 'FAIL — gem vanished or never collected');
    process.exit(ok ? 0 : 1);
  }, 6000);
};
ws.onerror = (e): void => { console.log('WS error', e); process.exit(3); };
