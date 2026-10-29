// lagoon shader-cost A/B/C: same island vantage, three terrain paths —
//   A: baked albedo + splat detail (current spec)
//   C: baked albedo only (mats off)
//   B: procedural preset 6 (the pre-rework path)
// GPU ms per composer pass via ?gpuperf (EXT_disjoint_timer_query_webgl2).
import { upStack } from './env.ts';
import { launchClient, closeClient } from './browser.ts';

const SECS = 8;
const stack = await upStack();
try {
  const c = await launchClient(stack.clientUrl('&room=lagperf&map=lagoon&bots=0&gpuperf=1&net=ws'),
    { preload: "localStorage.setItem('fps-autoq','false')" });
  await c.waitFor('window.__test && window.__test.networkManager && window.__test.networkManager.isConnected()', 90000);
  await c.waitFor('window.__test.terrain && isFinite(window.__test.terrain.getHeight(0,0))', 60000);
  await new Promise(r => setTimeout(r, 5000));
  // Terrain-dominant vantage: island fills the frame.
  await c.page.evaluate(`(() => { const p = window.__test.player;
    const h = window.__test.terrain.getHeight(100, 60);
    p.pos.set(100, h + 420, 60); p.vel.set(0,0,0); p.yaw = 0.0; p.pitch = -1.5;
    p.syncMovement && p.syncMovement(); p.markTeleport && p.markTeleport(); })()`);
  await new Promise(r => setTimeout(r, 2000));

  const snap = () => c.page.evaluate(`(window.__gpuPass ? window.__gpuPass() : [])`);
  const setPath = (useAlbedo: boolean, useMats: boolean) => c.page.evaluate(`(() => {
    let n = 0;
    window.__test.scene.traverse((o) => {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m && m.uniforms && 'useAlbedo' in m.uniforms) {
          m.uniforms.useAlbedo.value = ${useAlbedo};
          m.uniforms.useMats.value = ${useMats};
          n += 1;
        }
      }
    });
    return n; })()`);

  const modes = [['A baked+mats', true, true], ['C baked only', true, false], ['B procedural', false, false]] as const;
  for (const [label, ua, um] of modes) {
    const n = await setPath(ua, um);
    const t0 = await snap(), w0 = Date.now();
    await new Promise(r => setTimeout(r, SECS * 1000));
    const t1 = await snap(), w1 = Date.now();
    const wall = w1 - w0;
    console.log(`\n== ${label} (uniforms on ${n} materials, ${wall}ms) ==`);
    const by = new Map((t0 as any[]).map((r: any) => [r.pass, r]));
    const rows = (t1 as any[]).map((r: any) => {
      const p = by.get(r.pass);
      const dn = r.n - (p?.n ?? 0), dsum = r.avgMs * r.n - (p ? p.avgMs * p.n : 0);
      return { pass: r.pass, avgMs: dn > 0 ? dsum / dn : 0, n: dn };
    }).filter((r: any) => r.n > 0).sort((a: any, b: any) => b.avgMs - a.avgMs);
    for (const r of rows) {console.log(`  ${r.pass} avg=${r.avgMs.toFixed(3)}ms n=${r.n}`);}
  }
  await closeClient(c);
} finally { await stack.down(); }
