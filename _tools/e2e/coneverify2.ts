import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
const OUT = join(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'shots');
const stack = await upStack();
const client = await launchClient(stack.clientUrl('&room=coneverify&bots=0&net=ws'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
await client.waitFor(`t.player && t.player.pos`, 30000);
await sleep(1500);
const info = await client.page.evaluate(`(async () => {
  const t = window.__test;
  const { Projectile } = await import('/src/projectiles/Projectile.ts');
  const { DISC_CONFIG } = await import('/src/projectiles/discConfig.ts');
  const cam = t.player.camera;
  const V = cam.position.constructor;
  const fwd = new V(0,0,-1).applyQuaternion(cam.quaternion);
  const side = new V(1,0,0).applyQuaternion(cam.quaternion);
  const origin = cam.position.clone().addScaledVector(fwd, 15);
  const q = new Projectile(t.scene, origin, side.clone(), new V(0,0,0), DISC_CONFIG);
  q.vel.multiplyScalar(0.0);
  q.age = 3.0;
  t.world.projectiles.push(q);
  // find the glow|cone instanced mesh
  const found = [];
  t.scene.traverse(o => {
    if (o.isInstancedMesh && o.geometry && o.geometry.type === 'ConeGeometry') {
      const m = new o.instanceMatrix.constructor();
      o.instanceMatrix.needsUpdate = false;
      found.push({
        count: o.count, visible: o.visible, inFrustum: o.frustumCulled,
        mat: { hasMap: !!o.material.map, hasAlphaMap: !!o.material.alphaMap,
               blending: o.material.blending, transparent: o.material.transparent,
               opacity: o.material.opacity, depthWrite: o.material.depthWrite },
      });
    }
  });
  // run one sim tick so syncProjectileInstance fills the matrix
  await new Promise(r => setTimeout(r, 400));
  const mats = [];
  t.scene.traverse(o => {
    if (o.isInstancedMesh && o.geometry && o.geometry.type === 'ConeGeometry') {
      const M = o.instanceMatrix;
      for (let i = 0; i < o.count; i++) {
        const arr = Array.from(M.array.slice(i*16, i*16+16));
        mats.push({ i, worldPos: [arr[12], arr[13], arr[14]].map(v => +v.toFixed(1)),
                    scaleCol: Math.hypot(arr[0], arr[1], arr[2]).toFixed(2) });
      }
    }
  });
  return { found, mats, camPos: cam.position.toArray().map(v=>+v.toFixed(1)),
           projCount: t.world.projectiles.length };
})()`);
console.log(JSON.stringify(info, null, 1));
mkdirSync(OUT, { recursive: true });
await client.page.screenshot({ path: join(OUT, 'coneverify2.png') });
await closeClient(client);
stack.down();
