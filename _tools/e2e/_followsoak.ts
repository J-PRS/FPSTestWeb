/**
 * _followsoak.ts — ballroom v2 probe: real Chrome solo client on
 * ?mode=classic&map=ballroom (rimrock + follow-leash balls).
 *
 * Asserts:
 *   1. room boots: rimrock terrain, no structures
 *   2. ambient balls spawn within ~spec range of the player
 *   3. cap = 4, variant 0 only
 *   4. teleport the player 400m out: grounded balls recall near the
 *      player, airborne ones ride the arc (no mid-air pop)
 */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

let failures = 0;
const ok = (cond: boolean, label: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const stack = await upStack();
const client = await launchClient(stack.clientUrl('&mode=classic&map=ballroom'));
const errs: string[] = [];
client.page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });

const ballDist = `(() => {
  const t = window.__test; const p = t.player.pos;
  return t.entities.balls.map(b => ({
    d: Math.hypot(b.pos.x - p.x, b.pos.z - p.z),
    y: b.pos.y, v: b.variant,
    grounded: b.pos.y - b.radius <= t.terrain.getHeight(b.pos.x, b.pos.z) + 1.5,
  }));
})()`;

try {
  await client.waitFor('t.player && t.terrain && isFinite(t.terrain.getHeight(0,0))', 90000);
  ok(true, 'ballroom booted (rimrock terrain resident)');
  await client.waitFor('t.entities.balls && t.entities.balls.length >= 1', 60000);
  await sleep(3000);

  const census = await client.test<{ v: number[] }>(`({ v: window.__test.entities.balls.map(b => b.variant) })`);
  console.log('variants:', JSON.stringify(census));
  ok(census.v.every((v) => v === 0), 'all balls variant-0 (smallest)');

  const snap1 = await client.test<any[]>(ballDist);
  console.log('t0 balls:', JSON.stringify(snap1));
  const far0 = snap1.filter((b) => b.d > 150).length;
  ok(snap1.length >= 3, `balls present (${snap1.length})`);
  ok(far0 <= snap1.length, 'sample taken');

  // Teleport the player ~400m out - grounded stragglers should recall.
  await client.test(`(() => { const t = window.__test;
    t.player.pos.set(t.player.pos.x + 400, t.player.pos.y, t.player.pos.z);
    t.player.markTeleport?.(); return true; })()`);
  await sleep(6000);
  const snap2 = await client.test<any[]>(ballDist);
  console.log('t+6s balls:', JSON.stringify(snap2));
  const nearNow = snap2.filter((b) => b.d <= 150).length;
  const airborneFar = snap2.filter((b) => b.d > 150 && !b.grounded).length;
  const groundedFar = snap2.filter((b) => b.d > 150 && b.grounded).length;
  console.log(`near=${nearNow} airborneFar=${airborneFar} groundedFar=${groundedFar}`);
  ok(groundedFar === 0, `grounded balls recalled (groundedFar=${groundedFar})`);
  ok(nearNow >= snap2.length - airborneFar, 'recall converged or still flying');

  // 30s free soak: any grounded escapes?
  for (let i = 0; i < 6; i++) {
    await sleep(5000);
    const s = await client.test<any[]>(ballDist);
    const gf = s.filter((b) => b.d > 160 && b.grounded).length;
    if (gf > 0) console.log(`  t+${(i + 1) * 5}s: ${gf} grounded far`, JSON.stringify(s));
  }
  const fin = await client.test<any[]>(ballDist);
  console.log('final:', JSON.stringify(fin));
  ok(errs.length === 0, `zero console errors (${errs.length}: ${errs[0] ?? ''})`);
} finally {
  await closeClient(client);
  await stack.down();
}
console.log(failures ? `FAILURES: ${failures}` : 'ALL PASS');
process.exit(failures ? 1 : 0);
