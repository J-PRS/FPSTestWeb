// _moffset.ts — per-skinned-mesh world bounds vs logical feet for each remote.
import { upStack } from './env.ts';
import { launchClient, closeClient } from './browser.ts';

const stack = await upStack();
try {
  const client = await launchClient(stack.clientUrl('&room=mo&map=lagoon&bots=6&mode=dm&net=ws'),
    { preload: "localStorage.setItem('fps-autoq','false')" });
  await client.waitFor('t.world && t.world.remotePlayers', 30000);
  await client.waitFor('t.world.remotePlayers.entities.size >= 2', 30000).catch(() => {});
  await new Promise(r => setTimeout(r, 20000));
  const info = await client.page.evaluate(`(() => {
    const t = window.__test;
    const out = [];
    for (const [id, rp] of t.world.remotePlayers.entities) {
      const m = rp.model;
      if (!m || !m.model || !m.skinnedMeshes) { out.push({ id, variant: rp.variant, err: 'no model' }); continue; }
      m.model.updateMatrixWorld(true);
      const feetY = m.model.position.y - m.feetOffsetY;
      const meshes = m.skinnedMeshes.map((sm, i) => {
        sm.computeBoundingBox();
        const bb = sm.boundingBox.clone().applyMatrix4(sm.matrixWorld);
        const bones = sm.skeleton.bones;
        let minBoneY = Infinity;
        for (const b of bones) { const y = b.matrixWorld.elements[13]; if (y < minBoneY) minBoneY = y; }
        return { i, vis: sm.visible, nb: bones.length, sk0: bones[0].uuid.slice(0, 6),
          bbMinY: +bb.min.y.toFixed(2), bbMaxY: +bb.max.y.toFixed(2),
          minBoneY: +minBoneY.toFixed(2), boneVsFeet: +(minBoneY - feetY).toFixed(2),
          bbVsFeet: +(bb.min.y - feetY).toFixed(2) };
      });
      out.push({ id, variant: m.variant, clip: m.anim?.currentClipName, feetY: +feetY.toFixed(2), meshes });
    }
    return out;
  })()`);
  console.log(JSON.stringify(info, null, 1));
  await closeClient(client);
} finally {
  await stack.down();
}
