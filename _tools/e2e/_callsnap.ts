// Single-frame ground truth: renderer.info reflects the LAST completed
// frame (autoReset), so a direct read is the real calls/tris count.
// Reports camera pos, spawn state, and per-pass breakdown if available.
//   E2E_GPU=1 bun _tools/e2e/_callsnap.ts [bots]
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const bots = Number(process.argv[2] ?? 16);
const stack = await upStack();
const c = await launchClient(stack.clientUrl(`&room=callsnap&bots=${bots}`));
await c.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
await new Promise((r) => setTimeout(r, 8000));

const snap = await c.page.evaluate(`(() => {
  const r = window.__renderer, t = window.__test;
  const cam = t.camera ?? r.xr?.getCamera?.();
  const p = t.player;
  return {
    calls: r.info.render.calls, tris: r.info.render.triangles,
    geoms: r.info.memory.geometries, tex: r.info.memory.textures,
    progs: r.info.programs?.length,
    cam: cam ? {x:+cam.position.x.toFixed(1), y:+cam.position.y.toFixed(1), z:+cam.position.z.toFixed(1)} : null,
    spawned: !!(p && p.alive !== false && (p.playerId ?? t.playerId)),
    sceneKids: t.scene?.children?.length,
    url: location.href,
  };
})()`);
console.log(JSON.stringify(snap, null, 1));
await closeClient(c); stack.down();
