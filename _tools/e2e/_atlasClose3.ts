// Close-up verify: teleport the LOCAL player next to a remote.
import { launchClient, closeClient } from './browser.ts';
const client = await launchClient('http://localhost:5400/?mode=headhunt&map=rimrock&bots=16');
try {
  await client.page.waitForFunction('window.__test && window.__test.player', { timeout: 120000 });
  await new Promise(r => setTimeout(r, 10000));
  const info = await client.page.evaluate(`(() => {
    const t = window.__test;
    let remote = null;
    for (const r of (t.world.remotes?.values?.() ?? [])) { remote = r; break; }
    if (!remote) { return 'no remote'; }
    const rp = remote.position ?? remote.pos;
    const p = t.player.position ?? t.player.pos;
    p.set(rp.x + 3, rp.y, rp.z + 1);
    return 'teleported to ' + p.x.toFixed(0) + ',' + p.y.toFixed(0) + ',' + p.z.toFixed(0) + ' near ' + (remote.playerId ?? '?');
  })()`);
  console.log(info);
  await new Promise(r => setTimeout(r, 600));
  // face it — yaw the player toward the remote
  await client.page.evaluate(`(() => {
    const t = window.__test;
    let remote = null;
    for (const r of (t.world.remotes?.values?.() ?? [])) { remote = r; break; }
    if (!remote) { return; }
    const rp = remote.position ?? remote.pos;
    const p = t.player.position ?? t.player.pos;
    if (t.player.yaw !== undefined) { t.player.yaw = Math.atan2(rp.x - p.x, rp.z - p.z); }
    if (t.player.pitch !== undefined) { t.player.pitch = 0; }
  })()`);
  await new Promise(r => setTimeout(r, 300));
  await client.page.screenshot({ path: '_atlas_close.png' });
} finally { await closeClient(client); }
