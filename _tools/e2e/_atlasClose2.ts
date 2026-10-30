// Teleport a remote next to the local player, then screenshot the body.
import { launchClient, closeClient } from './browser.ts';
const client = await launchClient('http://localhost:5400/?mode=headhunt&map=rimrock&bots=16');
try {
  await client.page.waitForFunction('window.__test && window.__test.player', { timeout: 120000 });
  await new Promise(r => setTimeout(r, 10000));
  const moved = await client.page.evaluate(`(() => {
    const t = window.__test;
    const p = t.player.position ?? t.player.pos;
    // find a remote entity object with a position/vel — the wire remotes map
    const w = t.world;
    const cands = [];
    if (w && w.remotes) { for (const r of w.remotes.values ? w.remotes.values() : []) { cands.push(r); } }
    if (w && w.remotePlayers) { for (const r of w.remotePlayers.values ? w.remotePlayers.values() : []) { cands.push(r); } }
    // fallback: walk scene for atlas-body owners via netWorld
    if (!cands.length && t.netWorld && t.netWorld.remotes) { for (const r of t.netWorld.remotes.values()) { cands.push(r); } }
    const r = cands[0];
    if (!r) { return 'no remote found — keys: ' + Object.keys(w || {}).join(','); }
    const pos = r.position ?? r.pos;
    pos.set(p.x + 3, p.y, p.z);
    return 'moved ' + (r.name ?? r.playerId ?? '?') + ' to ' + pos.x.toFixed(0) + ',' + pos.y.toFixed(0) + ',' + pos.z.toFixed(0);
  })()`);
  console.log(moved);
  await new Promise(r => setTimeout(r, 400));
  await client.page.screenshot({ path: '_atlas_close.png' });
} finally { await closeClient(client); }
