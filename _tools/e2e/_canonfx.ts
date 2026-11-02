/* oxlint-disable no-console */
// Cannon direct-hit FX validation: classic-mode client fires a real cannon
// at a bot; count world.explosions around impact. ghostBodyPop bug = 0.
import { launchClient, closeClient } from './browser.ts';

const c = await launchClient(`http://localhost:5400/?mode=headhunt&soloBots=8`);
await c.waitFor(`window.__test && window.__test.player && window.__test.world.remotePlayers.entities.size > 0`, 30000);
console.log('seated');

const res = await c.page.evaluate(`(async () => {
  const t = window.__test; const p = t.player;
  const rp = [...t.world.remotePlayers.entities.values()].find(r => !r.isDead);
  // Park the victim dead ahead and aim.
  rp.position.set(p.pos.x, p.pos.y, p.pos.z - 20); rp.vel.set(0, 0, 0);
  const d = rp.position.clone().sub(p.pos);
  p.yaw = Math.atan2(-d.x, -d.z); p.pitch = Math.asin(d.y / d.length());
  // Equip cannon through the real kit path (Cannon=14).
  p.loadout[0] = 14; p.weaponIndex = 0;
  p.armory.emitWeaponSwitch(14);
  const n0 = t.world.explosions.length;
  const hp0 = rp.hp ?? -1;
  document.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
  await new Promise(r => setTimeout(r, 2500));
  return { n0, n1: t.world.explosions.length, ghost: t.world.projectiles.filter(q => q.ghostBodyPop).length,
    hp0, hp1: rp.hp, stillDead: rp.isDead };
})()`);
console.log(JSON.stringify(res));
await closeClient(c);
