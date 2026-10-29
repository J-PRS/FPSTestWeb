// terrperf — clean terrain-shader cost per map: bots=0, aerial vantage with
// terrain filling the frame, GPU ms on the RenderPass + uncapped fps.
// For baked maps also toggles useAlbedo/useMats to split shader branches.
//   bun _tools/e2e/_terrperf.ts <map> [x z up] [--uncap] [--secs 8]
import { upStack } from './env.ts';
import { launchClient, closeClient } from './browser.ts';

const MAP = process.argv[2] ?? 'lagoon';
const arg = (n: string, d = ''): string => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? (process.argv[i + 1] ?? d) : d; };
const SECS = Number(arg('secs', '8'));
const [vx, vz, up] = arg('pos', '0 0 400').split(' ').map(Number);
const UNCAP = process.argv.includes('--uncap');
if (UNCAP) {process.env.E2E_UNCAP = '1';}

const stack = await upStack();
try {
  const c = await launchClient(stack.clientUrl(`&room=terrperf&map=${MAP}&bots=0&gpuperf=1&net=ws`),
    { preload: "localStorage.setItem('fps-autoq','false')" });
  await c.waitFor('window.__test && window.__test.networkManager && window.__test.networkManager.isConnected()', 90000);
  await c.waitFor('window.__test.terrain && isFinite(window.__test.terrain.getHeight(0,0))', 60000);
  await new Promise(r => setTimeout(r, 4000));
  await c.page.evaluate(`(() => { const p = window.__test.player;
    const h = window.__test.terrain.getHeight(${vx}, ${vz});
    p.pos.set(${vx}, h + ${up}, ${vz}); p.vel.set(0,0,0); p.yaw = 0.0; p.pitch = -1.5;
    p.syncMovement && p.syncMovement(); p.markTeleport && p.markTeleport();
    window.__frames = []; let last = performance.now();
    const loop = (t) => { window.__frames.push(t - last); last = t; requestAnimationFrame(loop); };
    requestAnimationFrame(loop); })()`);
  await new Promise(r => setTimeout(r, 2000));

  const snap = () => c.page.evaluate(`(window.__gpuPass ? window.__gpuPass() : [])`);
  const setPath = (useAlbedo: boolean, useMats: boolean) => c.page.evaluate(`(() => {
    window.__test.scene.traverse((o) => {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m && m.uniforms && 'useAlbedo' in m.uniforms) {
          m.uniforms.useAlbedo.value = ${useAlbedo};
          m.uniforms.useMats.value = ${useMats};
        }
      }
    }); })()`);
  const hasAlbedo = await c.page.evaluate(`(() => { let f = false;
    window.__test.scene.traverse((o) => { const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of ms) {if (m?.uniforms?.useAlbedo?.value) {f = true;}} });
    return f; })()`);
  // --hidewater: the 3750m translucent sea plane — water maps pay a second
  // surface over every submerged pixel; toggle to isolate its share.
  const hideWater = process.argv.includes('--hidewater');
  if (hideWater) {
    await c.page.evaluate(`(() => { window.__test.scene.traverse((o) => {
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      if (ms.some((m) => m && m.uniforms && 'uLevel' in m.uniforms)) {o.visible = false;}
    }); })()`);
  }

  const modes: [string, boolean, boolean][] = hasAlbedo
    ? [['baked+mats', true, true], ['baked only', true, false], ['procedural', false, false]]
    : [['procedural', false, false]];

  for (const [label, ua, um] of modes) {
    await setPath(ua, um);
    await c.page.evaluate('window.__frames = []');
    const t0 = await snap();
    await new Promise(r => setTimeout(r, SECS * 1000));
    const t1 = await snap();
    const deltas = ((await c.page.evaluate('window.__frames')) as number[]).sort((a, b) => a - b);
    const n = deltas.length, q = (p: number) => deltas[Math.floor(n * p)]!;
    const fps = +(1000 / (deltas.reduce((s, d) => s + d, 0) / n)).toFixed(1);
    const by = new Map((t0 as any[]).map((r: any) => [r.pass, r]));
    const rows = (t1 as any[]).map((r: any) => {
      const p = by.get(r.pass);
      const dn = r.n - (p?.n ?? 0), dsum = r.avgMs * r.n - (p ? p.avgMs * p.n : 0);
      return { pass: r.pass, avgMs: dn > 0 ? dsum / dn : 0, n: dn };
    }).filter((r: any) => r.n > 0 && r.pass === 'RenderPass');
    const rp = rows[0];
    console.log(`${MAP} ${label}: fps=${fps} median=${q(0.5).toFixed(2)}ms p95=${q(0.95).toFixed(2)}ms | RenderPass=${rp ? rp.avgMs.toFixed(3) : '?'}ms n=${rp?.n ?? 0}`);
  }
  await closeClient(c);
} finally { await stack.down(); }
