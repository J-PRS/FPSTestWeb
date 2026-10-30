// Close-up verify: park the camera next to a remote's merged body.
import { launchClient, closeClient } from './browser.ts';
const client = await launchClient('http://localhost:5400/?mode=headhunt&map=rimrock&bots=16');
try {
  await client.page.waitForFunction('window.__test && window.__test.player', { timeout: 120000 });
  await new Promise(r => setTimeout(r, 10000));
  const pos = await client.page.evaluate(`(() => {
    const t = window.__test; const scene = t.scene;
    let target = null;
    scene.traverse((o) => { if (!target && o.isSkinnedMesh && o.name === 'atlas-body') { target = o; } });
    if (!target) { return 'no atlas-body'; }
    const v = new (Object.getPrototypeOf(scene.position).constructor)();
    target.getWorldPosition(v);
    // Camera near the remote — move the LOCAL player view (game reads camera quat/pos per frame; easiest: move the camera + let the frame render it).
    const cam = t.camera || (t.player && t.player.camera);
    if (cam) {
      cam.position.set(v.x + 4, v.y + 1.6, v.z + 4);
      cam.lookAt(v.x, v.y + 1, v.z);
      cam.updateMatrixWorld(true);
      if (cam.fov) { cam.fov = 40; cam.updateProjectionMatrix(); }
    }
    return JSON.stringify({ x: v.x, y: v.y, z: v.z });
  })()`);
  console.log('remote at', pos);
  await new Promise(r => setTimeout(r, 800));
  // Re-aim — the game loop may have reset the camera; apply then shoot fast.
  await client.page.evaluate(`(() => {
    const t = window.__test; const scene = t.scene;
    let target = null;
    scene.traverse((o) => { if (!target && o.isSkinnedMesh && o.name === 'atlas-body') { target = o; } });
    if (!target) { return; }
    const v = new (Object.getPrototypeOf(scene.position).constructor)();
    target.getWorldPosition(v);
    const cam = t.camera || (t.player && t.player.camera);
    if (cam) { cam.position.set(v.x + 4, v.y + 1.6, v.z + 4); cam.lookAt(v.x, v.y + 1, v.z); }
  })()`);
  await client.page.screenshot({ path: '_atlas_close.png' });
} finally { await closeClient(client); }
