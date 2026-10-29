// structSurface verification: is the injected GLSL in the live programs,
// and does a close-range kit piece show the detail? Bastion, near the
// katastand face.
import { upStack } from './env.ts';
import { launchClient, closeClient } from './browser.ts';

const stack = await upStack();
try {
  const c = await launchClient(stack.clientUrl('&room=sver&map=bastion&bots=0&net=ws'),
    { preload: "localStorage.setItem('fps-autoq','false')" });
  await c.waitFor('window.__test && window.__test.networkManager && window.__test.networkManager.isConnected()', 90000);
  await c.waitFor('window.__test.terrain && isFinite(window.__test.terrain.getHeight(0,0))', 60000);
  await new Promise(r => setTimeout(r, 5000));
  // Program-level proof: any compiled shader containing our ssFbm?
  const prog = await c.page.evaluate(`(() => {
    const r = window.__test.renderer;
    const progs = (r && r.info && r.info.programs) ? r.info.programs : [];
    const hits = progs.filter((p) => p.fragmentShader && p.fragmentShader.includes('ssFbm')).length;
    const all = progs.length;
    // and material-level: does hullMat still chain terrainBlend too?
    let kit = null;
    window.__test.scene.traverse((o) => {
      if (kit || !o.userData.kitPiece) return;
      const ms = [];
      o.traverse((m) => { if (m.isMesh && m.material?.onBeforeCompile) { ms.push('patched'); } });
      kit = { piece: 'found', patchedMats: ms.length };
    });
    return { programs: all, ssFbmPrograms: hits, kit }; })()`);
  console.log('programs:', JSON.stringify(prog));
  // Close on the katastand (-500,60 scale2): stand 8m south of it.
  const h = await c.page.evaluate(`window.__test.terrain.getHeight(-500, 72)`);
  await c.page.evaluate(`(() => { const p = window.__test.player;
    p.pos.set(-500, ${h + 3.5}, 72); p.vel.set(0,0,0); p.yaw = Math.PI; p.pitch = -0.05;
    p.syncMovement && p.syncMovement(); p.markTeleport && p.markTeleport(); })()`);
  await new Promise(r => setTimeout(r, 2000));
  await c.page.screenshot({ path: '_tools/e2e/shots/struct_kata.png' });
  console.log('done');
  await closeClient(c);
} finally { await stack.down(); }
