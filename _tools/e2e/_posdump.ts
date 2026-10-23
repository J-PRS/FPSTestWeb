/**
 * _posdump.ts — remote-position relationship probe.
 *
 *   E2E_GPU=1 bun _tools/e2e/_posdump.ts [--secs 30] [--bots 8] [--map dm]
 *
 * One headless client in a bot room. Every poll dumps each remote's three
 * position truths — render pos, lastServerPosition, newest snapshot — plus
 * the distances between them (render↔newest, render↔server, newest↔server),
 * so interp drift vs wire lag vs sim-vs-net divergence are visible as
 * separate numbers instead of one muddled gap.
 */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const arg = (name: string, dflt: string): string =>
  process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1]! : dflt;
const SECS = Number(arg('secs', '30'));
const BOTS = arg('bots', '8');
const MAP = arg('map', 'dm');

const stack = await upStack();
const client = await launchClient(stack.clientUrl(`&room=posdump&map=${MAP}&bots=${BOTS}`));

const dump = async (): Promise<void> => {
  const s = await client.page.evaluate(`(() => {
    const w = window.__test.world;
    const rs = [...w.remotePlayers.entities.entries()].map(([id, rp]) => {
      const it = rp.interp;
      const snaps = it?.net?.snapshots ?? [];
      const nw = snaps[snaps.length - 1];
      const d = (a, b) => +Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]).toFixed(1);
      const v = (p) => p ? [p.x | 0, p.y | 0, p.z | 0] : null;
      const pos = v(rp.position);
      const srv = v(it?.lastServerPosition);
      // The delayed ghost the shooter actually sees — buffer sample at the
      // current view epoch (interpDelay back from the wire head).
      const gv = rp.position.clone();
      const gok = it?.net && it.sampleGhostAt
        ? it.sampleGhostAt(it.viewEpochT, gv) : false;
      const ghost = gok ? v(gv) : null;
      return {
        id, pos, srv, ghost,
        delay: it?.net?.interpDelay ?? -1,
        lagMs: rp.viewLagMs ?? -1,
        sim: it?._simulating ?? null,
        conv: it?.convergeTimer != null ? +it.convergeTimer.toFixed(2) : null,
        renderVsGhost: ghost ? d(pos, ghost) : -1,
        renderVsSrv: srv ? d(pos, srv) : -1,
        ghostVsSrv: (ghost && srv) ? d(ghost, srv) : -1,
        nSnaps: snaps.length,
      };
    });
    return { rs };
  })()`);
  const t = new Date().toISOString().slice(11, 19);
  for (const r of s.rs)
    console.log(`${t} ${r.id} pos=${r.pos} ghost=${r.ghost} srv=${r.srv} | r-g=${r.renderVsGhost} r-s=${r.renderVsSrv} g-s=${r.ghostVsSrv} lag=${r.lagMs}ms sim=${r.sim} conv=${r.conv} snaps=${r.nSnaps}`);
};

try {
  await client.waitFor(`t.networkManager && t.networkManager.isConnected()`, 45000);
  await client.waitFor(`t.world.remotePlayers.entities.size >= 3`, 45000);
  const n = await client.test<number>(`t.world.remotePlayers.entities.size`);
  console.log(`seated, ${n} remotes — polling every 3s for ${SECS}s`);
  const t0 = Date.now();
  while (Date.now() - t0 < SECS * 1000) {
    await dump();
    await new Promise((r) => setTimeout(r, 3000));
  }
} finally {
  await closeClient(client);
  stack.down();
}
