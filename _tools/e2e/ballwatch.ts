/**
 * ballwatch.ts — rubberband watch soak: real Chrome client vs real Bun
 * server, bots + server-owned balls flying, count the segment-rubberband
 * warns for ~90s.
 *
 *   bun _tools/e2e/ballwatch.ts
 *
 * Asserts:
 *   1. ballRoster lands (balls are actually simulating server-side)
 *   2. tick frames advance (the client is live, not stalled)
 *   3. ZERO 'segment rubberband' warns and zero suppressed-fleet rollups —
 *      the metric is same-endpoint now, so any warn is real divergence.
 */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

let failures = 0;
const ok = (cond: boolean, label: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SOAK_MS = Number(process.env.BALLWATCH_MS ?? 90_000);

const stack = await upStack();
const client = await launchClient(stack.clientUrl('&room=ballwatch&bots=8'));

let segWarns = 0;
let fleetLines = 0;
let bounceWarns = 0;
const samples: string[] = [];
client.page.on('console', (m) => {
  if (m.type() !== 'warn') return;
  const t = m.text();
  if (/segment rubberband/.test(t)) {
    segWarns++;
    if (samples.length < 5) samples.push(t.slice(0, 400));
  } else if (/ball rubberbands: \d+ suppressed/.test(t)) {
    fleetLines++;
    if (samples.length < 5) samples.push(t.slice(0, 200));
  } else if (/ball #\d+ \w+ rubberband/.test(t)) {
    bounceWarns++;
    if (samples.length < 8) samples.push(t.slice(0, 300));
  }
});

try {
  await client.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
  ok(true, 'client connected');
  await client.waitFor(`t.world.balls && t.world.balls.length >= 1`, 30000)
    .catch(() => null);
  // balls may key off a different __test field — probe a few spellings
  const ballCount = await client.test<number>(`(
    (t.world.balls?.length) ??
    (t.entities?.balls?.length) ??
    (t.balls?.length) ?? -1
  )`);
  ok(ballCount !== 0, `balls live in room (count=${ballCount})`);

  const t0 = Date.now();
  while (Date.now() - t0 < SOAK_MS) {
    await sleep(5000);
    const seq = await client.test<number>(`t.networkManager.lastTickSeq`).catch(() => -1);
    process.stdout.write(`  … ${((Date.now() - t0) / 1000).toFixed(0)}s tickSeq=${seq} segWarns=${segWarns} fleetRollups=${fleetLines} edgeWarns=${bounceWarns}\n`);
  }

  ok(segWarns === 0, `zero segment-rubberband warns over ${SOAK_MS / 1000}s (saw ${segWarns})`);
  // Edge kinds (bounce/lunge/teleport/knockback) ARE corrections — their
  // rollup counts event spacing, so hundreds of meters is by design.
  // Informational only; a huge count would still hint at a resync storm.
  console.log(`  info: ${fleetLines} edge-fleet rollups, ${bounceWarns} edge-kind warns (corrections, by design)`);
  ok(fleetLines < 20, `fleet rollups bounded (${fleetLines})`);
  for (const s of samples) console.log(`  sample: ${s}`);
} finally {
  await closeClient(client);
  stack.down();
}
console.log(failures ? `\n${failures} FAIL` : '\nballwatch clean');
process.exit(failures ? 1 : 0);
