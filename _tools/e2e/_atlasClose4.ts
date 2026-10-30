// Close-up verify v2: teleport LOCAL player next to a remote (same remote
// enumeration that worked in _atlasClose2).
import { launchClient, closeClient } from './browser.ts';
const client = await launchClient('http://localhost:5400/?mode=headhunt&map=rimrock&bots=16');
try {
  await client.page.waitForFunction('window.__test && window.__test.player', { timeout: 120000 });
  await new Promise(r => setTimeout(r, 10000));
  const info = await client.page.evaluate(`(() => {
    const t = window.__test;
    const cands = [];
    for (const src of [t.world?.remotes, t.world?.remotePlayers, t.netWorld?.remotes]) {
      if (!src) { continue; }
      for (const r of src.values ? src.values() : []) { cands.push(r); }
    }
    const r = cands[0];
    if (!r) { return 'no remote'; }
    const rp = r.position ?? r.pos;
    const p = t.player.position ?? t.player.pos;
    p.set(rp.x + 3, rp.y, rp.z + 1);
    return 'teleported near ' + (r.playerId ?? '?') + ' at ' + rp.x.toFixed(0) + ',' + rp.y.toFixed(0) + ',' + rp.z.toFixed(0);
  })()`);
  console.log(info);
  await new Promise(r => setTimeout(r, 500));
  // yaw player toward the remote
  await client.page.evaluate(`(() => {
    const t = window.__test;
    const cands = [];
    for (const src of [t.world?.remotes, t.world?.remotePlayers, t.netWorld?.remotes]) {
      if (!src) { continue; }
      for (const r of src.values ? src.values() : []) { cands.push(r); }
    }
    const r = cands[0];
    if (!r) { return; }
    const rp = r.position ?? r.pos;
    const p = t.player.position ?? t.player.pos;
    if (t.player.yaw !== undefined) { t.player.yaw = Math.atan2(p.x - rp.x, p.z - rp.z); }
    if (t.player.pitch !== undefined) { t.player.pitch = 0; }
  })()`);
  await new Promise(r => setTimeout(r, 300));
  await client.page.screenshot({ path: '_atlas_close.png' });
} finally { await closeClient(client); }
