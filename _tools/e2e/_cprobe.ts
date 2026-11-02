import { launchClient, closeClient } from './browser.ts';
const c = await launchClient(`http://localhost:5400/?mode=headhunt&soloBots=8`);
await c.waitFor(`window.__test && window.__test.player`, 30000);
for (let i = 0; i < 6; i += 1) {
  const s = await c.page.evaluate(`(() => { const w = window.__test.world;
    return { rp: w.remotePlayers ? w.remotePlayers.entities.size : -1,
      proj: w.projectiles.length, exp: w.explosions.length, bots: window.__test.entities?.teamBots?.size ?? 'n/a' }; })()`);
  console.log(i, JSON.stringify(s));
  if (s.rp > 0) {break;}
  await new Promise(r => setTimeout(r, 2000));
}
await closeClient(c);
