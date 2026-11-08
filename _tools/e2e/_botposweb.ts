/* oxlint-disable no-console */
// Browser-side check: does the rendered RemotePlayer entity track wire
// motion for SERVER bots? Samples __gameDump rows (pos via remotePlayers)
// twice, 8s apart, in an online headhunt room. Netbot _botpos already
// proved wire+sim move; this isolates the client render/integration leg.
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const stack = await upStack();
const client = await launchClient(stack.clientUrl(`&room=bpweb&map=rimrock&bots=15&mode=headhunt&net=ws`));
try {
  await client.waitFor(`t.networkManager && t.networkManager.isConnected()`, 60000);
  await client.waitFor(`[...t.world.remotePlayers.entities.keys()].filter(id => id.startsWith('BOT-')).length >= 8`, 30000);
  await new Promise(r => setTimeout(r, 6000));
  const snap = `(() => {
    const out = {};
    for (const [id, rp] of window.__test.world.remotePlayers.entities) {
      if (id.startsWith('BOT-')) {out[id] = [rp.position.x, rp.position.y, rp.position.z];}
    }
    return out; })()`;
  // Instrument the decode boundary: count onPlayerUpdate calls per bot id
  // and snapshot the decoded roster positions (nm.players) alongside.
  await client.test(`(() => {
    window.__botUpd = {};
    const nm = window.__test.networkManager;
    const orig = nm.onPlayerUpdate;
    nm.onPlayerUpdate = (id, pos, rot, ms, vel) => { if (id?.startsWith('BOT-')) {window.__botUpd[id] = (window.__botUpd[id] ?? 0) + 1;} return orig?.(id, pos, rot, ms, vel); };
    return true; })()`);
  const a = await client.test<Record<string, number[]>>(snap);
  const ra = await client.test(`(() => { const m = {}; for (const [id, p] of window.__test.networkManager.getPlayers()) { if (id.startsWith('BOT-')) {m[id] = [p.position?.x ?? 0, p.position?.y ?? 0, p.position?.z ?? 0];} } return m; })()`);
  await new Promise(r => setTimeout(r, 8000));
  const b = await client.test<Record<string, number[]>>(snap);
  const rb = await client.test(`(() => { const m = {}; for (const [id, p] of window.__test.networkManager.getPlayers()) { if (id.startsWith('BOT-')) {m[id] = [p.position?.x ?? 0, p.position?.y ?? 0, p.position?.z ?? 0];} } return m; })()`);
  const upd = await client.test<Record<string, number>>(`window.__botUpd`);
  const wids = await client.test<number>(`window.__test.networkManager.wireIn?.wireIds?.size ?? -1`);
  console.log(`wireIds=${wids} onPlayerUpdateCalls=${JSON.stringify(upd)}`);
  const interp = await client.test(`(() => {
    const out = {};
    const now = Date.now();
    for (const [id, rp] of window.__test.world.remotePlayers.entities) {
      if (!id.startsWith('BOT-')) {continue;}
      out[id] = { pos: [rp.position.x, rp.position.y, rp.position.z].map(v => +v.toFixed(0)),
        wire: [rp.wirePosition.x, rp.wirePosition.y, rp.wirePosition.z].map(v => +v.toFixed(0)),
        updAgeMs: now - (rp.lastUpdateTime ?? 0), sim: rp.isSimulating, delayMs: Math.round(rp.renderDelayMs),
        underruns: rp.interpUnderruns, lagMs: Math.round(rp.viewLagMs ?? -1), ld: rp.localDriven };
    }
    return out; })()`);
  console.log(JSON.stringify(interp, null, 0).slice(0, 3000));
  // Second sample 2s later: is lastServerUpdateMs advancing (stamps OK)
  // and is the snapshot buffer filling?
  await new Promise(r => setTimeout(r, 2000));
  const deep = await client.test(`(() => {
    const out = {};
    for (const [id, rp] of window.__test.world.remotePlayers.entities) {
      if (!id.startsWith('BOT-') || Object.keys(out).length >= 4) {continue;}
      const it = rp.interp, n = it.net;
      out[id] = {
        srvMs: it.lastServerUpdateMs, tgt: [it.targetPosition.x, it.targetPosition.y, it.targetPosition.z].map(v => +v.toFixed(0)),
        lastSrv: [it.lastServerPosition.x, it.lastServerPosition.y, it.lastServerPosition.z].map(v => +v.toFixed(0)),
        bufN: n?.samples?.length ?? n?.buffer?.length ?? -1, underruns: n?.underruns, atCap: n?.atExtCap,
        arrMs: Math.round(n?.arrivalInterval ?? -1), starveMs: Math.round(n?.starveMs ?? -1),
        convT: +it.convergeTimer?.toFixed(2), convTot: +it.convergeTotal?.toFixed(2),
        simVel: [it.simulatedVelocity.x, it.simulatedVelocity.y, it.simulatedVelocity.z].map(v => +v.toFixed(1)),
      };
    }
    return out; })()`);
  console.log(JSON.stringify(deep, null, 1));
  console.log('id                 entityDrift8s  rosterDrift8s');
  for (const [id, p] of Object.entries(b)) {
    const q = a[id];
    const rq = ra[id], rr = rb[id];
    if (!q) {continue;}
    const d = Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!);
    const rd = rq && rr ? Math.hypot(rr[0]! - rq[0]!, rr[1]! - rq[1]!, rr[2]! - rq[2]!) : -1;
    console.log(`${id.padEnd(20)} ${d.toFixed(1).padStart(10)} ${rd.toFixed(1).padStart(12)}`);
  }
} finally {
  await closeClient(client);
  stack.down();
}
