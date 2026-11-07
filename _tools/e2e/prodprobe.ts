/**
 * prodprobe.ts — observe remote bot movement on a live server.
 * Samples remote entity positions every ~2s, then reports:
 *   - per-entity path-vs-displacement (high ratio = circling, not traveling)
 *   - cluster dispersion (bots packed around one spot = AoE fodder)
 *
 *   E2E_GPU=1 bun _tools/e2e/prodprobe.ts [--secs 60] [--room headhunt-1]
 *     [--server https://play.jprice.app] [--client http://127.0.0.1:5500]
 */
import { launchClient, closeClient } from './browser.ts';

const arg = (name: string, dflt: string): string =>
  process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1]! : dflt;
const SECS = Number(arg('secs', '60'));
const SERVER = arg('server', 'https://play.jprice.app');
const ROOM = arg('room', 'headhunt-1');
const CLIENT = arg('client', 'http://127.0.0.1:5500');

const client = await launchClient(
  `${CLIENT}/?debug&server=${encodeURIComponent(SERVER)}&room=${encodeURIComponent(ROOM)}&net=ws`);
try {
  await client.waitFor(`t.networkManager && t.networkManager.isConnected()`, 60000);
  await client.waitFor(`t.world.remotePlayers.entities.size >= 3`, 45000);
  const tier = await client.test<string>(`t.networkManager.getTransportTier() ?? 'unknown'`);
  console.log(`probing ${ROOM} (${tier}) for ${SECS}s`);

  // id -> ordered position trail
  const trails = new Map<string, [number, number, number][]>();
  const deadline = Date.now() + SECS * 1000;
  while (Date.now() < deadline) {
    const snap = await client.test<[string, number, number, number][]>(
      `[...t.world.remotePlayers.entities.values()].map(e => [e.playerId, e.pos.x, e.pos.y, e.pos.z])`);
    const t = Date.now();
    for (const [id, x, y, z] of snap ?? []) {
      const tr = trails.get(id) ?? [];
      const last = tr[tr.length - 1];
      if (!last || Math.hypot(x - last[0], z - last[2]) > 0.05) {tr.push([x, y, z]);}
      trails.set(id, tr);
    }
    void t;
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log(`\n=== ${trails.size} entities sampled ===`);
  const centroids: [number, number, number][] = [];
  for (const [id, tr] of trails) {
    if (tr.length < 3) {continue;}
    let path = 0;
    for (let i = 1; i < tr.length; i += 1) {
      path += Math.hypot(tr[i]![0] - tr[i - 1]![0], tr[i]![1] - tr[i - 1]![1], tr[i]![2] - tr[i - 1]![2]);
    }
    const disp = Math.hypot(tr[tr.length - 1]![0] - tr[0]![0], tr[tr.length - 1]![1] - tr[0]![1], tr[tr.length - 1]![2] - tr[0]![2]);
    const cx = tr.reduce((s, p) => s + p[0], 0) / tr.length;
    const cy = tr.reduce((s, p) => s + p[1], 0) / tr.length;
    const cz = tr.reduce((s, p) => s + p[2], 0) / tr.length;
    centroids.push([cx, cy, cz]);
    // Spread around own centroid — a circler rings a small area.
    const spread = Math.sqrt(tr.reduce((s, p) => s + (p[0] - cx) ** 2 + (p[2] - cz) ** 2, 0) / tr.length);
    console.log(`${id.padEnd(16)} path=${path.toFixed(0).padStart(5)}m disp=${disp.toFixed(0).padStart(4)}m ratio=${(disp > 1 ? path / disp : 99).toFixed(1).padStart(5)} rmsRadius=${spread.toFixed(1)}m y=${cy.toFixed(0)}`);
  }
  // Swarm metric: mean pairwise centroid distance + share within 30m of herd centroid.
  if (centroids.length >= 3) {
    const hx = centroids.reduce((s, c) => s + c[0], 0) / centroids.length;
    const hy = centroids.reduce((s, c) => s + c[1], 0) / centroids.length;
    const hz = centroids.reduce((s, c) => s + c[2], 0) / centroids.length;
    const within30 = centroids.filter((c) => Math.hypot(c[0] - hx, c[1] - hy, c[2] - hz) < 30).length;
    console.log(`\nherd centroid=(${hx.toFixed(0)},${hy.toFixed(0)},${hz.toFixed(0)}) — ${within30}/${centroids.length} bots within 30m`);
  }
} finally {
  await closeClient(client);
}
