/* oxlint-disable no-console */
// One-off: are ONLINE server bots actually moving? Sample wire remote
// positions + reported velocity twice, 12s apart, headhunt rimrock.
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const stack = await upStack();
const client = await launchClient(stack.clientUrl(`&room=aswprobe&map=rimrock&bots=15&mode=headhunt&net=ws`));
const snap = `(() => {
  const nm = window.__test.networkManager;
  const meta = { tickSeq: nm.lastTickSeq, liveRxMs: Math.round(nm.msSinceLiveRx()), wids: nm.wireIn?.wireIds?.size ?? -1 };
  // Roster-side truth: does the decoded wire state move even when the
  // rendered entity doesn't?
  const roster = [];
  for (const [pid, st] of nm.players ?? []) {
    if (!pid.startsWith('BOT-')) {continue;}
    roster.push({ id: pid, x: st.position?.x, y: st.position?.y, z: st.position?.z,
      vx: st.velocity?.x, vy: st.velocity?.y, vz: st.velocity?.z,
      posAgeMs: Date.now() - (st.posAt ?? 0) });
  }
  const out = { meta, players: [], roster, updCalls: (globalThis as any).__updCalls ?? -1 };
  for (const [id, rp] of window.__test.world.remotePlayers.entities) {
    out.players.push({ id, x: rp.position.x, y: rp.position.y, z: rp.position.z,
      vx: rp.serverVelocity?.x ?? 0, vy: rp.serverVelocity?.y ?? 0, vz: rp.serverVelocity?.z ?? 0,
      feetY: rp.feetY, dead: rp.isDead });
  }
  return out; })()`;
try {
  await client.waitFor(`t.networkManager && t.networkManager.isConnected()`, 60000);
  await client.waitFor(`t.world.remotePlayers.entities.size >= 5`, 30000);
  // Count RemotePlayer.update() calls - separates "wire never reaches the
  // entity" from "entity gets updates but its render stays frozen".
  await client.test(`(() => {
    window.__updCalls = 0;
    for (const rp of window.__test.world.remotePlayers.entities.values()) {
      const orig = rp.update.bind(rp);
      rp.update = (...a) => { window.__updCalls++; return orig(...a); };
    }
    return window.__updCalls;
  })()`);
  await new Promise(r => setTimeout(r, 12000));
  const a = await client.test<any>(snap);
  await new Promise(r => setTimeout(r, 12000));
  const b = await client.test<any>(snap);
  console.log(`tickSeq a=${a.meta.tickSeq} b=${b.meta.tickSeq} liveRxMs=${b.meta.liveRxMs} wids=${b.meta.wids} updCalls=${b.updCalls}`);
  for (const r of b.roster.slice(0, 6)) {console.log(`  roster ${r.id} pos=(${r.x?.toFixed(0)},${r.y?.toFixed(0)},${r.z?.toFixed(0)}) vel=(${r.vx?.toFixed(1)},${r.vy?.toFixed(1)},${r.vz?.toFixed(1)}) posAge=${r.posAgeMs}ms`);}
  // Server-side park autopsy: parkedDebug names dest/goal/brain per bot.
  const murl = `http://127.0.0.1:${stack.serverPort}/metrics?key=${process.env.FPS_ADMIN_TOKEN ?? 'testadmin'}`;
  const m1 = await fetch(murl).then(r => r.json()).catch(e => ({ err: String(e) }));
  await new Promise(r => setTimeout(r, 8000));
  const status = await fetch(murl).then(r => r.json()).catch(e => ({ err: String(e) }));
  // Diff sim xz between the two scrapes — separates "sim frozen" from
  // "sim moving but record/wire stale".
  const xz1 = new Map<string, string>();
  for (const room of (m1 as any).rooms ?? []) {for (const r of room.botParked ?? []) {const m = /xz=([-\d.]+),([-\d.]+)/.exec(r.mv ?? ''); if (m) {xz1.set(`${room.name}/${r.id}`, `${m[1]},${m[2]}`);}}}
  for (const room of (status as any).rooms ?? []) {
    console.log(`room ${room.name}: botIdle=${JSON.stringify(room.botIdle)}`);
    for (const r of (room.botParked ?? []).slice(0, 16)) {
      const m = /xz=([-\d.]+),([-\d.]+)/.exec(r.mv ?? '');
      const prev = m ? xz1.get(`${room.name}/${r.id}`) : undefined;
      const d = m && prev ? Math.hypot(parseFloat(m[1]!) - parseFloat(prev.split(',')[0]!), parseFloat(m[2]!) - parseFloat(prev.split(',')[1]!)) : -1;
      console.log(`  ${r.id} sp=${r.sp} simDrift8s=${d.toFixed(1)} dest=${r.dest} goal=${r.goal} brain=${r.brain} mv=${r.mv}`);
    }
  }
  const bm = new Map(b.players.map(r => [r.id, r]));
  console.log('id                 moved12s  speed  feetY  dead');
  for (const r of a.players) {
    const q = bm.get(r.id);
    if (!q) {continue;}
    const moved = Math.hypot(q.x - r.x, q.y - r.y, q.z - r.z);
    const sp = Math.hypot(q.vx, q.vy, q.vz);
    console.log(`${r.id.padEnd(20)} ${moved.toFixed(1).padStart(7)} ${sp.toFixed(1).padStart(6)} ${q.feetY.toFixed(1).padStart(6)} ${String(q.dead).padStart(5)}`);
  }
} finally {
  await closeClient(client);
  stack.down();
}
