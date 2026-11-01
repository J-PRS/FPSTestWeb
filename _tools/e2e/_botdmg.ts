// Solo headhunt bot-damage probe: launch offline client (no room param),
// check remotePlayers constructor names, fire a real shot at a bot, diff hp.
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const stack = await upStack();
const c = await launchClient(stack.clientUrl('&mode=headhunt&bots=4&map=rimrock'));
await c.waitFor(`t.world.remotePlayers.entities.size >= 1`, 30000);
await new Promise((r) => setTimeout(r, 2000));

const info = await c.page.evaluate(`(() => {
  const t = window.__test;
  const es = t.world.remotePlayers.entities;
  const first = es.values().next().value;
  const out = {
    ctor: first?.constructor?.name,
    isGB: first?.takeDamageLocal !== undefined,
    hp: first?.botHp,
    id: first?.playerId ?? first?.id,
    count: es.size,
  };
  return out;
})()`);
console.log('BOT INFO', JSON.stringify(info));

// Now simulate a real hit via the funnel used by direct hits:
const hit = await c.page.evaluate(`(() => {
  const t = window.__test;
  const es = [...t.world.remotePlayers.entities.values()];
  const b = es[0];
  const before = b.botHp ?? -999;
  // Direct-hit path: deps.botHit → teamBots.hit — call the same entry:
  const tb = t.world.teamBots ?? t.teamBots;
  const fn = tb?.hit?.bind(tb) ?? (b.takeDamageLocal ? (id,d,f,a)=>{b.takeDamageLocal(d,f,a);return true;} : null);
  if (!fn) return { err: 'no hit path' };
  const r = fn(b.playerId ?? b.id, 25, { x: b.position.x, y: b.position.y, z: b.position.z }, 'local', { weapon: 0, air: 0 });
  return { r, before, after: b.botHp };
})()`);
console.log('HIT RESULT', JSON.stringify(hit));

// Outline/fresnel check: does the bot's model have hull/fresnel meshes?
const vis = await c.page.evaluate(`(() => {
  const t = window.__test;
  const b = [...t.world.remotePlayers.entities.values()][0];
  const names = [];
  b.traverse?.((o) => { if (o.isMesh) names.push(o.name + '|' + (o.material?.type ?? '?')); });
  return { meshes: names.slice(0, 20), n: names.length };
})()`);
console.log('MESHES', JSON.stringify(vis));

await closeClient(c); stack.down();
