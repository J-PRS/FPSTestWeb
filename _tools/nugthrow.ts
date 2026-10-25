/** Real-socket nugget throw on the live localhost server: join, send a
 *  release-style deploy claim (pos+vel), watch the gem spawn, tumble,
 *  settle, and confirm it stays collectable. */
import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:8000/ws');
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
let me: { x: number; y: number; z: number } | null = null;
let seq = 0;
const pickups = new Map<number, { pos: { x: number; y: number; z: number }; vel?: { x: number; y: number; z: number }; kind?: string }>();
const events: string[] = [];

ws.onmessage = (e): void => {
  if (typeof e.data !== 'string') {return;}
  const m = JSON.parse(e.data as string);
  if (m.type === 'gameState') {
    if (m.localPlayerState?.position) { me = m.localPlayerState.position; }
    for (const p of m.pickups ?? []) { pickups.set(p.id, p); }
    log(`gameState room=${m.room} me=${JSON.stringify(me)} pickups=${m.pickups?.length ?? 0}`);
  } else if (m.type === 'pickupSpawn') {
    pickups.set(m.id, m);
    log(`pickupSpawn #${m.id} ${m.kind} pos=${JSON.stringify(m.pos)} vel=${JSON.stringify(m.vel)}`);
  } else if (m.type === 'pickupGone') {
    pickups.delete(m.id); events.push(`gone#${m.id}`);
    log(`pickupGone #${m.id} by=${m.by}`);
  } else if (m.type === 'claimAck') {
    log(`claimAck kind=${m.kind} seq=${m.seq} ok=${m.ok} reason=${m.reason ?? '-'}`);
    events.push(`ack:${m.ok}`);
  } else if (m.type === 'shotRejected' || m.type === 'serverWarn') {
    log(`${m.type}: ${m.reason ?? m.text}`);
  }
};

ws.onopen = (): void => {
  ws.send(JSON.stringify({ type: 'join', playerId: `nugthrow-${Date.now() % 1e6}`, room: 'nugthrow', mode: 'headhunt', bots: 0, map: 'rimrock' }));
  setTimeout(() => {
    if (!me) { log('no seat'); process.exit(2); }
    // Release-style claim: chest position + a forward lob — server sims the flight.
    ws.send(JSON.stringify({
      type: 'deploy', kind: 'nugget',
      position: { x: me.x + 1, y: me.y + 0.4, z: me.z },
      vel: { x: 18, y: 6, z: 0 }, claimSeq: ++seq,
    }));
    log('deploy nugget sent (release+vel)');
  }, 800);
  setTimeout(() => {
    const gem = [...pickups.values()].find((p) => p.kind === 'gem');
    if (!gem) { log('FAIL — no gem spawned'); process.exit(1); }
    log(`gem rest at ${JSON.stringify(gem.pos)} — teleporting onto it`);
    // Walk onto the gem to collect.
    ws.send(JSON.stringify({ type: 'teleport', position: { x: gem.pos.x, y: gem.pos.y + 0.5, z: gem.pos.z }, claimSeq: ++seq }));
    setTimeout(() => {
      if (pickups.size === 0 && events.some((e) => e.startsWith('gone'))) {
        log('PASS — gem spawned, settled, and was collected');
        process.exit(0);
      }
      log(`FAIL — gem still live or never collected (pickups=${pickups.size})`);
      process.exit(1);
    }, 2500);
  }, 6000);
};
ws.onerror = (e): void => { log('ws error', (e as Error).message); };
setTimeout(() => { log('timeout'); process.exit(1); }, 15000);
