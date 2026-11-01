/* oxlint-disable no-console */
// C4 replay duo — two real clients. A emits real inputMove edges on the wire
// (alternating forward on/off so the change-only stream produces edges); B
// samples A's remote: does the relayed-edge replay own the body, do seqs
// progress, and does the rendered body track wire truth.
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const stack = await upStack();
const url = stack.clientUrl('&room=replayduo&bots=0');
const [a, b] = await Promise.all([launchClient(url), launchClient(url)]);
let failures = 0;
const ok = (cond: boolean, label: string) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) {failures++;} };

try {
  for (const c of [a, b]) {
    await c.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
    await c.waitFor(`t.networkManager.lastTickSeq >= 0`, 20000);
  }
  const aId = await a.test<string>(`t.networkManager.localPlayerId`);
  const bId = await b.test<string>(`t.networkManager.localPlayerId`);
  await b.waitFor(`t.world.remotePlayers.entities.has('${aId}')`, 20000).catch(() => null);
  console.log(`peers a=${aId} b=${bId}`);

  // A drives real edges: forward toggles every 250ms for 10s (change-only
  // stream → each toggle is a wire edge the server consumes + relays).
  await a.page.evaluate(`(() => {
    const nm = window.__test.networkManager;
    let f = 0;
    window.__edgeTimer = setInterval(() => {
      f = f ? 0 : 1;
      nm.sendInputMove({ forward: f, right: 0, jump: 0, ski: 1, jet: f }, { yaw: 0, pitch: 0 });
    }, 250);
  })()`);

  const rows = await b.page.evaluate(`(async () => {
    const out = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 10000) {
      const rp = window.__test.world.remotePlayers.entities.get('${aId}');
      const it = rp?.interp; const r = it?.replay;
      const wire = it?.lastServerPosition;
      const drift = rp && wire && wire.lengthSq() > 0
        ? Math.hypot(rp.position.x - wire.x, rp.position.y - wire.y, rp.position.z - wire.z) : -1;
      out.push({ t: Date.now() - t0, hasReplay: !!r, seq: r?.lastSeq ?? -1,
        fresh: r ? Date.now() < r.freshUntil : false, sim: it?._simulating ?? null,
        drift: Number(drift.toFixed(2)) });
      await new Promise(r2 => setTimeout(r2, 500));
    }
    return out;
  })()`);
  await a.page.evaluate(`clearInterval(window.__edgeTimer)`);

  interface Row { hasReplay: boolean; seq: number; fresh: boolean; sim: boolean; drift: number; }
  const rs = rows as Row[];
  const replayed = rs.filter(r => r.hasReplay).length;
  const fresh = rs.filter(r => r.fresh).length;
  const seqs = rs.map(r => r.seq).filter(s => s > 0);
  const simming = rs.filter(r => r.sim).length;
  const drifts = rs.map(r => r.drift).filter(d => d >= 0);
  console.log('samples:', rs.map(r => `seq${r.seq}/d${r.drift}${r.fresh ? 'F' : ''}`).join(' '));
  ok(replayed > 0, `replay sim seeded on B for A (${replayed}/${rs.length} samples)`);
  ok(fresh > 0, `replay fresh (edge relay reaching B)`);
  ok(seqs.length > 1 && seqs[seqs.length - 1]! > seqs[0]!, `edge seqs progressing (${seqs[0]}→${seqs[seqs.length - 1]})`);
  ok(simming > 0, `replay owns the body (${simming}/${rs.length} samples simulating)`);
  ok(Math.max(...drifts, 0) < 10, `drift bounded (max ${Math.max(...drifts, 0)}m)`);

  // --- Phase 2: distance gate — teleport A ~500m from B; the relay is
  // gated ~400m XZ so edges stop arriving and replay must hand the body
  // back to interp/DR rather than free-running forever.
  await a.page.evaluate(`(() => {
    const p = window.__test.player;
    p.pos.set(p.pos.x + 500, 60, p.pos.z);
    p.vel.set(0, 0, 0); p.syncMovement(); p.markTeleport();
  })()`);
  const far = await b.page.evaluate(`(async () => {
    const out = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      const rp = window.__test.world.remotePlayers.entities.get('${aId}');
      const it = rp?.interp; const r = it?.replay;
      const wire = it?.lastServerPosition;
      const drift = rp && wire && wire.lengthSq() > 0
        ? Math.hypot(rp.position.x - wire.x, rp.position.y - wire.y, rp.position.z - wire.z) : -1;
      out.push({ seq: r?.lastSeq ?? -1, drift });
      await new Promise(r2 => setTimeout(r2, 500));
    }
    return out;
  })()`);
  // The gate kills EDGE relay; records may still arrive and refresh the
  // freshness gate (that's the held-input design) — so the observable is
  // seq stall + record snaps bounding drift, not freshness.
  const fseqs = (far as { seq: number; drift: number }[]).map(r => r.seq).filter(s => s > 0);
  const fdrift = (far as { drift: number }[]).map(r => r.drift).filter(d => d >= 0);
  const seqStall = fseqs.length < 2 || fseqs[fseqs.length - 1]! - fseqs[0]! <= 2;
  ok(seqStall, `distance gate: edge seqs stall past ~400m (${fseqs[0]}→${fseqs[fseqs.length - 1]})`);
  ok(Math.max(...fdrift, 0) < 15, `far drift bounded by record snaps (max ${Math.max(...fdrift, 0)}m)`);

  // --- Phase 3: teleport BACK inside the gate; relay must resume and the
  // replay must resync to the new truth (record snap), not stay warped.
  await a.page.evaluate(`(() => {
    const p = window.__test.player;
    const b = window.__test.world.remotePlayers.entities.get('${bId}');
    p.pos.set(b.position.x + 5, b.position.y + 1, b.position.z);
    p.vel.set(0, 0, 0); p.syncMovement(); p.markTeleport();
  })()`);
  const near = await b.page.evaluate(`(async () => {
    const out = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      const rp = window.__test.world.remotePlayers.entities.get('${aId}');
      const it = rp?.interp; const r = it?.replay;
      const wire = it?.lastServerPosition;
      const drift = rp && wire && wire.lengthSq() > 0
        ? Math.hypot(rp.position.x - wire.x, rp.position.y - wire.y, rp.position.z - wire.z) : -1;
      out.push({ fresh: r ? Date.now() < r.freshUntil : false, drift });
      await new Promise(r2 => setTimeout(r2, 500));
    }
    return out;
  })()`);
  const nearFresh = (near as { fresh: boolean; drift: number }[]).filter(r => r.fresh).length;
  const lastDrift = (near as { drift: number }[]).map(r => r.drift).filter(d => d >= 0).pop() ?? -1;
  ok(nearFresh > 0, `relay resumes inside the gate (fresh ${nearFresh}/${near.length})`);
  ok(lastDrift >= 0 && lastDrift < 5, `replay resynced after teleport back (drift ${lastDrift}m)`);
} finally {
  await a.page.evaluate(`clearInterval(window.__edgeTimer)`).catch(() => null);
  await closeClient(a); await closeClient(b); await stack.down();
}
process.exit(failures ? 1 : 0);
