/**
 * prodprobe.ts — observe remote bot movement on a live server.
 * Samples remote entities ~2Hz, then reports:
 *   - locomotion: speed profile, facing-vs-velocity divergence (sliding),
 *     still fraction, yaw jitter (turn smoothness), render-vs-wire Δ
 *   - path-vs-displacement (high ratio = circling, not traveling)
 *   - cluster dispersion (bots packed around one spot = AoE fodder)
 *
 *   E2E_GPU=1 bun _tools/e2e/prodprobe.ts [--secs 60] [--room headhunt-1]
 *     [--server https://play.jprice.app] [--client http://127.0.0.1:5500]
 *     [--hz 0.5]   (sample interval seconds)
 */
import { launchClient, closeClient } from './browser.ts';

const arg = (name: string, dflt: string): string =>
  process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1]! : dflt;
const SECS = Number(arg('secs', '60'));
const SERVER = arg('server', 'https://play.jprice.app');
const ROOM = arg('room', 'headhunt-1');
const CLIENT = arg('client', 'http://127.0.0.1:5500');
const HZ = Number(arg('hz', '0.5')); // seconds between samples

const client = await launchClient(
  `${CLIENT}/?debug&server=${encodeURIComponent(SERVER)}&room=${encodeURIComponent(ROOM)}&net=ws`);
try {
  await client.waitFor(`t.networkManager && t.networkManager.isConnected()`, 60000);
  await client.waitFor(`t.world.remotePlayers.entities.size >= 3`, 45000);
  const tier = await client.test<string>(`t.networkManager.getTransportTier() ?? 'unknown'`);
  console.log(`probing ${ROOM} (${tier}) for ${SECS}s @ ${HZ}s`);

  // id -> ordered samples: [renderX,renderY,renderZ, wireX,wireY,wireZ, velX,velY,velZ, yaw, sim]
  type Sample = [number, number, number, number, number, number, number, number, number, number, number];
  const trails = new Map<string, Sample[]>();
  const deadline = Date.now() + SECS * 1000;
  while (Date.now() < deadline) {
    const snap = await client.test<Sample[]>(
      `[...t.world.remotePlayers.entities.values()].map(e => [
        e.playerId, e.pos.x, e.pos.y, e.pos.z,
        e.wirePosition.x, e.wirePosition.y, e.wirePosition.z,
        e.vel.x, e.vel.y, e.vel.z, e.rotation.yaw, e.isSimulating ? 1 : 0
      ])`);
    for (const s of snap ?? []) {
      const id = String(s[0]);
      const tr = trails.get(id) ?? [];
      tr.push(s);
      trails.set(id, tr);
    }
    await new Promise((r) => setTimeout(r, HZ * 1000));
  }

  const pct = (xs: number[], p: number): number => {
    if (!xs.length) {return 0;}
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
  };

  console.log(`\n=== ${trails.size} entities sampled ===`);
  const centroids: [number, number, number][] = [];
  for (const [id, tr] of trails) {
    if (tr.length < 5) {continue;}
    let path = 0;
    const speeds: number[] = [];
    const faceOffs: number[] = [];
    const rDeltas: number[] = [];
    const yawRates: number[] = [];
    let still = 0, simFrames = 0;
    for (let i = 0; i < tr.length; i += 1) {
      const s = tr[i]!;
      const spd = Math.hypot(s[7], s[8], s[9]);
      speeds.push(spd);
      rDeltas.push(Math.hypot(s[1] - s[4], s[2] - s[5], s[3] - s[6]));
      if (spd < 1) {still += 1;}
      if (s[11] === 1) {simFrames += 1;}
      if (spd > 3) {
        // yaw forward = (sin(yaw), cos(yaw)) vs velocity heading — sliding reads >25°.
        const velYaw = Math.atan2(s[7], s[9]);
        let d = Math.abs(s[10] - velYaw);
        if (d > Math.PI) {d = 2 * Math.PI - d;}
        faceOffs.push(d * 180 / Math.PI);
      }
      if (i > 0) {
        const p = tr[i - 1]!;
        path += Math.hypot(s[4] - p[4], s[5] - p[5], s[6] - p[6]);
        let yd = Math.abs(s[10] - p[10]);
        if (yd > Math.PI) {yd = 2 * Math.PI - yd;}
        yawRates.push(yd / HZ);
      }
    }
    const first = tr[0]!, last = tr[tr.length - 1]!;
    const disp = Math.hypot(last[4] - first[4], last[5] - first[5], last[6] - first[6]);
    const cx = tr.reduce((a, s) => a + s[4], 0) / tr.length;
    const cy = tr.reduce((a, s) => a + s[5], 0) / tr.length;
    const cz = tr.reduce((a, s) => a + s[6], 0) / tr.length;
    centroids.push([cx, cy, cz]);
    const spread = Math.sqrt(tr.reduce((a, s) => a + (s[4] - cx) ** 2 + (s[6] - cz) ** 2, 0) / tr.length);
    console.log(
      `${id.padEnd(16)} spd p50=${pct(speeds, 0.5).toFixed(1).padStart(5)} p95=${pct(speeds, 0.95).toFixed(1).padStart(5)} ` +
      `faceOff p95=${pct(faceOffs, 0.95).toFixed(0).padStart(3)}° yawRate p95=${pct(yawRates, 0.95).toFixed(1).padStart(4)}r/s ` +
      `still=${Math.round(still / tr.length * 100)}% rΔ p95=${pct(rDeltas, 0.95).toFixed(1).padStart(5)}m ` +
      `sim=${Math.round(simFrames / tr.length * 100)}% ratio=${(disp > 1 ? path / disp : 99).toFixed(1).padStart(5)} rmsR=${spread.toFixed(1)}m`,
    );
  }
  if (centroids.length >= 3) {
    const hx = centroids.reduce((a, c) => a + c[0], 0) / centroids.length;
    const hy = centroids.reduce((a, c) => a + c[1], 0) / centroids.length;
    const hz = centroids.reduce((a, c) => a + c[2], 0) / centroids.length;
    const within30 = centroids.filter((c) => Math.hypot(c[0] - hx, c[1] - hy, c[2] - hz) < 30).length;
    console.log(`\nherd centroid=(${hx.toFixed(0)},${hy.toFixed(0)},${hz.toFixed(0)}) — ${within30}/${centroids.length} bots within 30m`);
  }
} finally {
  await closeClient(client);
}
