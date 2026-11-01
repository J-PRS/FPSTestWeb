/* oxlint-disable no-console */
// C4 replay probe — joins a bot room and samples, per remote: whether the
// relayed-edge replay owns the body, edge seq progression, and drift of the
// rendered body from the latest wire record. Proves the relay reaches a real
// client and the sim tracks truth over a live window.
import { launchClient, closeClient } from './browser.ts';

const SECS = Number(process.argv[process.argv.indexOf('--secs') + 1] || 20);
const c = await launchClient(`http://localhost:5400/s/replayprobe?server=localhost:8000&mode=ctf&bots=8`);
await c.waitFor(`window.__test && window.__test.networkManager && window.__test.networkManager.isConnected()`, 45000);
console.log(`seated — sampling ${SECS}s`);

const samples = await c.page.evaluate(`(async () => {
  const w = window.__test.world ?? window.__test;
  const out = [];
  const t0 = Date.now();
  while (Date.now() - t0 < ${SECS * 1000}) {
    const row = { t: Date.now() - t0, remotes: [] };
    for (const [id, rp] of w.remotePlayers) {
      const it = rp.interp;
      const r = it?.replay;
      const wire = it?.lastServerPosition;
      const drift = wire && wire.lengthSq() > 0
        ? Math.hypot(rp.position.x - wire.x, rp.position.y - wire.y, rp.position.z - wire.z) : -1;
      row.remotes.push({
        id,
        hasReplay: !!r,
        seq: r?.lastSeq ?? -1,
        fresh: r ? Date.now() < r.freshUntil : false,
        sim: it?._simulating ?? null,
        drift: Number(drift.toFixed(2)),
        spd: rp.velocity ? Math.hypot(rp.velocity.x, rp.velocity.y, rp.velocity.z) | 0 : 0,
      });
    }
    out.push(row);
    await new Promise(r => setTimeout(r, 500));
  }
  return out;
})()`);

interface Row { t: number; remotes: { id: string; hasReplay: boolean; seq: number; fresh: boolean; sim: boolean; drift: number; spd: number }[]; }
const rows = samples as Row[];
const byId = new Map<string, { replay: number; fresh: number; sim: number; n: number; seqs: number[]; drifts: number[]; movers: number }>();
for (const row of rows) {
  for (const r of row.remotes) {
    const a = byId.get(r.id) ?? { replay: 0, fresh: 0, sim: 0, n: 0, seqs: [], drifts: [], movers: 0 };
    a.n++; if (r.hasReplay) {a.replay++;} if (r.fresh) {a.fresh++;} if (r.sim) {a.sim++;}
    if (r.seq > 0) {a.seqs.push(r.seq);} if (r.drift >= 0) {a.drifts.push(r.drift);} if (r.spd > 5) {a.movers++;}
    byId.set(r.id, a);
  }
}
console.log(`\n${rows.length} samples, ${byId.size} remotes:`);
for (const [id, a] of byId) {
  const mx = Math.max(...a.drifts, 0), med = a.drifts.sort((x, y) => x - y)[a.drifts.length >> 1] ?? -1;
  const seqProg = a.seqs.length > 1 ? a.seqs[a.seqs.length - 1]! - a.seqs[0]! : 0;
  console.log(`  ${id}: replay ${a.replay}/${a.n} fresh ${a.fresh}/${a.n} sim ${a.sim}/${a.n} | edges +${seqProg} | drift med ${med}m max ${mx}m | moving ${a.movers}/${a.n}`);
}
await closeClient(c);
