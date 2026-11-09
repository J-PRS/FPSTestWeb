// Visual verify: q3conv-ported Quake map renders + collides.
import { launchClient, closeClient } from './browser.ts';
const client = await launchClient('http://localhost:5400/?room=q3dm5&map=oacmpdm5&bots=0&net=ws&debug');
try {
  await client.page.waitForFunction('window.__test && window.__test.player', { timeout: 120000 });
  await new Promise(r => setTimeout(r, 10000));
  await client.page.screenshot({ path: '_q3dm5_shot.png' });
  const info = await client.page.evaluate(`(() => {
    const t = window.__test || {};
    const p = t.player;
    const scene = t.scene;
    let interiors = null, meshes = 0, draws = 0;
    scene && scene.traverse((o) => {
      if (o.name === '__t2interiors') interiors = { children: o.children.length };
      if (o.isMesh || o.isInstancedMesh) { meshes++; }
    });
    const r = window.__renderer && window.__renderer.info ? window.__renderer.info.render : {};
    return JSON.stringify({
      pos: p && p.pos ? { x: +p.pos.x.toFixed(1), y: +p.pos.y.toFixed(1), z: +p.pos.z.toFixed(1) } : null,
      interiors, meshes,
      calls: r.calls, tris: r.triangles,
      mapStructs: t.world && t.world.mapSnapshot ? (t.world.mapSnapshot.structures||[]).length : 'n/a',
    });
  })()`);
  console.log(info);
} finally { await closeClient(client); }
