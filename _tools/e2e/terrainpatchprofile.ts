/**
 * Profile localized terrain-detail patches around remote bodies.
 * E2E_GPU=1 bun _tools/e2e/terrainpatchprofile.ts --bots 12 --secs 20 [--detail 0|1]
 */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const arg = (name: string, fallback: string): string =>
  process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1]! : fallback;
const bots = arg('bots', '12');
const secs = Number(arg('secs', '20'));
const detail = arg('detail', '1') === '1';
const stack = await upStack();
const client = await launchClient(stack.clientUrl(
  `&room=terrainprofile&map=lagoon&bots=${bots}&mode=ctf&terrainRemoteDetail=${detail ? '1' : '0'}`));

try {
  await client.waitFor(`t.networkManager && t.networkManager.isConnected()`, 60000);
  await client.waitFor(`t.world.remotePlayers.entities.size >= ${Math.max(1, Number(bots) - 1)}`, 30000);
  const phases = await client.page.evaluate(async (seconds): Promise<Record<string, number[]>> => {
    const t = (window as unknown as { __test: any }).__test;
    const renderer = t.rendererSetup.renderer;
    const terrain = t.terrain;
    renderer.info.autoReset = false;
    terrain.setRemoteDetailEnabled(true); // compile and warm the patch shader before either sample window
    await new Promise((r) => setTimeout(r, 2500));
    const rows: number[][] = [];
    let enabled = false;
    terrain.setRemoteDetailEnabled(enabled);
    renderer.info.reset();
    let last = performance.now();
    const end = last + seconds * 1000;
    while (performance.now() < end) {
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      const now = performance.now();
      const patch = terrain.remoteDetailStats();
      rows.push([enabled ? 1 : 0, now - last, renderer.info.render.calls, renderer.info.render.triangles,
        patch.active, patch.vertices, patch.cpuMs]);
      renderer.info.reset();
      last = now;
      enabled = !enabled; // adjacent-frame A/B minimizes match-state drift
      terrain.setRemoteDetailEnabled(enabled);
    }
    return { rows };
  }, secs);
  const pct = (values: number[], p: number): number => {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) * p)] ?? 0;
  };
  const summary = (samples: number[][]): Record<string, number> => ({
    n: samples.length,
    frameMsP50: pct(samples.map((s) => s[1]!), 0.5),
    frameMsP95: pct(samples.map((s) => s[1]!), 0.95),
    drawsP50: pct(samples.map((s) => s[2]!), 0.5),
    drawsP95: pct(samples.map((s) => s[2]!), 0.95),
    trisP50: pct(samples.map((s) => s[3]!), 0.5),
    trisP95: pct(samples.map((s) => s[3]!), 0.95),
    patchesP50: pct(samples.map((s) => s[4]!), 0.5),
    verticesP50: pct(samples.map((s) => s[5]!), 0.5),
    updateMsP50: pct(samples.map((s) => s[6]!), 0.5),
    updateMsP95: pct(samples.map((s) => s[6]!), 0.95),
    updateMsMax: Math.max(0, ...samples.map((s) => s[6]!)),
  });
  const report = {
    requestedDetail: detail,
    bots,
    remotes: await client.test<number>(`t.world.remotePlayers.entities.size`),
    off: summary(phases.rows.filter((s) => s[0] === 0)),
    on: summary(phases.rows.filter((s) => s[0] === 1)),
    pairedDeltaOnMinusOff: (() => {
      const off = phases.rows.filter((s) => s[0] === 0), on = phases.rows.filter((s) => s[0] === 1);
      const delta = (column: number): number[] => off.slice(0, Math.min(off.length, on.length))
        .map((row, i) => on[i]![column]! - row[column]!);
      return {
        frameMsP50: pct(delta(1), 0.5),
        frameMsP95: pct(delta(1), 0.95),
        drawsP50: pct(delta(2), 0.5),
        trianglesP50: pct(delta(3), 0.5),
      };
    })(),
  };
  await client.page.screenshot({ path: '_tools/e2e/shots/terrain_remote_detail.png' });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await closeClient(client);
  stack.down();
}
