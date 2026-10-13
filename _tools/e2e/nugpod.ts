/**
 * nugpod.ts — offline nugget-pack probe: throw the pod, then sample the
 * pod and the minted nugget state for ~8s. Float/unpickable bug shows as
 * a pod that never lands or a nugget that never settles/collects.
 *   bun _tools/e2e/nugpod.ts
 */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const stack = await upStack();
const client = await launchClient(stack.clientUrl('&bots=0&net=ws'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
try {
  await client.waitFor(`t.player && t.player.pos`, 30000);
  await sleep(1500);

  await client.page.evaluate(`(() => {
    const t = window.__test;
    const p = t.player;
    p.pos.set(0, t.terrain.getHeight(0, 0) + 1.6, 0);
    // Throw far ahead and stand still — keep the landing spot outside
    // the 7m magnet radius so the nugget has to actually come to rest.
    p.yaw = 0; p.pitch = 0.5;
    p.packItem = 'nugget';
    p.beltCharges = 9;
    t.entities.deployables.deploy();
  })()`);

  // Phase 1: watch pod land + nugget settle (~4s)
  for (let i = 0; i < 12; i += 1) {
    await sleep(350);
    const snap = await client.page.evaluate(`(() => {
      const t = window.__test;
      const d = t.entities.deployables;
      const pods = d.pods.map((p) => ({ ttl: +p.ttl.toFixed(2), landed: p.landed,
        pos: p.pos.toArray().map((v) => +v.toFixed(2)), vel: p.vel.toArray().map((v) => +v.toFixed(2)) }));
      const nugs = t.entities.nuggets.map((n) => ({
        pos: n.pos.toArray().map((v) => +v.toFixed(2)), vel: n.vel.toArray().map((v) => +v.toFixed(2)),
        settled: n.settled, collected: n.collected, age: +n.age.toFixed(2), serverOwned: n.serverOwned }));
      const ng = nugs[0];
      const under = ng ? t.terrain.getHeight(ng.pos.x, ng.pos.z) : null;
      const underR = ng && t.terrain.getRenderedHeight ? t.terrain.getRenderedHeight(ng.pos.x, ng.pos.z) : null;
      return { pods, nugs,
        nugGround: under === null ? null : +under.toFixed(2),
        nugGroundR: underR === null ? null : +underR.toFixed(2) };
    })()`);
    console.log(`t=${(i * 0.35).toFixed(2)}`, JSON.stringify(snap));
  }
  // Phase 2: walk to the nugget and watch it collect
  const collected = await client.page.evaluate(`(async () => {
    const t = window.__test;
    const n = t.entities.nuggets[0];
    if (!n) {return 'no-nugget';}
    // stand next to it — magnet radius 7m pulls it in
    t.player.pos.set(n.pos.x - 2, n.pos.y + 1.2, n.pos.z);
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      if (!t.entities.nuggets.includes(n) || n.collected) {return 'collected';}
    }
    return 'never-collected';
  })()`);
  console.log('pickup:', collected);
  // Verdict: pod must have landed, nugget must rest on the drawn
  // surface (rendered height + NUGGET_RADIUS 0.3, +bob ~0.06) and collect.
  const check = await client.page.evaluate(`(() => {
    const t = window.__test;
    const d = t.entities.deployables;
    const podLanded = d.pods.length === 0 || d.pods.every((p) => p.landed || p.ttl <= 0);
    const nugGone = t.entities.nuggets.length === 0;
    // If the nugget was already collected, the pickup proof is the verdict.
    if (nugGone) {return { podLanded, collected: true, restErr: null };}
    const n = t.entities.nuggets[0];
    if (n.collected) {return { podLanded, collected: true, restErr: null };}
    const restY = t.terrain.getRenderedHeight(n.pos.x, n.pos.z) + 0.3;
    return { podLanded, collected: n.collected, settled: n.settled,
      restY: +restY.toFixed(2), posY: +n.pos.y.toFixed(2),
      restErr: +(n.pos.y - restY).toFixed(2) };
  })()`);
  console.log('verdict:', JSON.stringify(check));
  const ok = check.podLanded && check.collected
    && (check.restErr === null || Math.abs(check.restErr) < 0.4);
  console.log(ok ? 'NUGPOD: PASS' : 'NUGPOD: FAIL');
  if (!ok) {process.exitCode = 1;}
} finally {
  await closeClient(client);
}
