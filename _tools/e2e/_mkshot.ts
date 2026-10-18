// _mkshot.ts — frame the nearest remote and screenshot marker-vs-model.
import { upStack } from './env.ts';
import { launchClient, closeClient } from './browser.ts';

const stack = await upStack();
try {
  const client = await launchClient(stack.clientUrl('&room=mk&map=lagoon&bots=4&mode=dm&net=ws'),
    { preload: "localStorage.setItem('fps-autoq','false')" });
  await client.waitFor('t.world && t.world.remotePlayers', 30000);
  await client.waitFor('t.world.remotePlayers.entities.size >= 2', 30000).catch(() => {});
  // Wait for bots to get close-ish, then aim the camera at the nearest.
  await new Promise(r => setTimeout(r, 20000));
  const info = await client.page.evaluate(`(() => {
    const t = window.__test;
    const me = t.player;
    const mx = me.pos ? me.pos.x : me.position.x, my = me.pos ? me.pos.y : me.position.y, mz = me.pos ? me.pos.z : me.position.z;
    let best = null, bd = 1e9;
    for (const [id, rp] of t.world.remotePlayers.entities) {
      const d = rp.position.distanceTo({x:mx,y:my,z:mz, distanceTo: undefined}) || Math.hypot(rp.position.x-mx, rp.position.y-my, rp.position.z-mz);
      const dd = Math.hypot(rp.position.x-mx, rp.position.y-my, rp.position.z-mz);
      if (dd < bd) { bd = dd; best = rp; }
    }
    if (!best) return { err: 'no remotes' };
    // Stand 6m south of the remote, eye at their chest height, face it.
    const px = best.position.x, py = best.position.y, pz = best.position.z + 6;
    if (me.pos) { me.pos.x = px; me.pos.y = py; me.pos.z = pz; }
    else { me.position.x = px; me.position.y = py; me.position.z = pz; }
    me.vel.x = 0; me.vel.y = 0; me.vel.z = 0;
    const dx = best.position.x - px, dy = best.position.y - py, dz = best.position.z - pz;
    const yaw = Math.atan2(-dx, -dz), pitch = Math.atan2(dy, Math.hypot(dx, dz));
    me.yaw = yaw; me.pitch = pitch;
    return { dist: +bd.toFixed(1), id: best.playerId, variant: best.model?.variant,
      pos: [best.position.x, best.position.y, best.position.z].map(v=>+v.toFixed(1)),
      yaw: +yaw.toFixed(2), pitch: +pitch.toFixed(2) };
  })()`);
  console.log('aim:', JSON.stringify(info));
  await new Promise(r => setTimeout(r, 1500));
  await client.page.screenshot({ path: '_tools/e2e/shots/marker.png' });
  console.log('shot saved');
  await closeClient(client);
} finally { await stack.down(); }
