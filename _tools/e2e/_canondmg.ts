/* oxlint-disable no-console */
// Direct-hit damage validation: park a bot dead ahead, fire bolt at its
// chest, measure botHp delta + whether the sweep even scored contact.
import { launchClient, closeClient } from './browser.ts';

const c = await launchClient(`http://localhost:5400/?mode=headhunt&soloBots=8`);
await c.waitFor(`window.__test && window.__test.player && window.__test.world.remotePlayers.entities.size > 0`, 40000);

const res = await c.page.evaluate(`(async () => {
  const t = window.__test; const p = t.player;
  const rp = [...t.world.remotePlayers.entities.values()].find(r => !r.isDead);
  rp.position.set(p.pos.x, p.pos.y, p.pos.z - 20); rp.vel.set(0, 0, 0);
  const d = rp.position.clone().sub(p.pos);
  p.yaw = Math.atan2(-d.x, -d.z); p.pitch = Math.asin(d.y / d.length());
  p.loadout[0] = 14; p.weaponIndex = 0; p.armory.emitWeaponSwitch(14);
  const hp0 = rp.botHp ?? rp.hp ?? -1;
  const n0 = t.world.explosions.length;
  const projs0 = t.world.projectiles.length;
  document.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
  await new Promise(r => setTimeout(r, 2000));
  const hit = t.world.projectiles.find(q => q.hitPlayerId === rp.id);
  const gone = t.world.projectiles.filter(q => q.exploded);
  return { hp0, hp1: rp.botHp ?? rp.hp ?? -1, exp: t.world.explosions.length - n0,
    projs: t.world.projectiles.length - projs0,
    hits: gone.map(q => ({ hit: q.hitPlayerId, dir: q.directHit, ghost: q.ghostBodyPop, pop: q.popClass })) };
})()`);
console.log(JSON.stringify(res));
await closeClient(c);
