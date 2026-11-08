// Scratch: hero-overdrive proof in a REAL full match. One bravo bot is
// a natural menace - NORMAL body, but takes 0.1x damage and deals 4x
// (patched at the two funnels: projectiles.spawn directBonus for dealt,
// players.applyDamage for taken). No staged scoreboard: he earns his
// dominance organically while enemy resolve ramps on results.
// Prints the men's kills + the full resolve table every 30 sim-seconds.
//   bun tests/scenarios/_herosoak.ts
import { mkRoom, step } from './harness.ts';
import { hmParseBin, hmScaled } from '../../../shared/heightfield.ts';
import { readFileSync } from 'node:fs';

const buf = readFileSync('C:/TEMP/_WEB/FPSWebTest/maps/rimrock.bin');
const spec = JSON.parse(readFileSync('C:/TEMP/_WEB/FPSWebTest/maps/rimrock.json', 'utf8'));
const field = hmScaled(hmParseBin(buf, spec.heightScale ?? 1), spec.heightScale ?? 1);

const BOTS = 14;
const room = mkRoom({
  mode: 'headhunt', bots: BOTS, botSkill: 'medium',
}, 'headhunt', 4242, false, field);

const players = [...room.players.getAllPlayers().values()];
const menace = players.find((p) => p.team === 'bravo');
if (!menace) {throw new Error('no bravo bot staged');}

// Crank his skill to the impossible tier: mutation must hit BOTH the
// live fields and the base* copies heroTick lerps from, or the first
// tick reverts him to medium.
import { BOT_TIERS } from '../../../shared/botSkill.ts';
const sk = room.bots.skillOf(menace.id);
if (!sk) {throw new Error('no skill on menace');}
for (const [src, dst] of [[sk.mods, sk.baseMods]] as const) {
  dst.aim = src.aim = BOT_TIERS.impossible.aim; dst.move = src.move = BOT_TIERS.impossible.move;
  dst.react = src.react = BOT_TIERS.impossible.react; dst.jitter = src.jitter = BOT_TIERS.impossible.jitter;
  dst.temper = src.temper = BOT_TIERS.impossible.temper;
}
for (const ax of ['snap', 'track', 'arcLead', 'arcJudge'] as const) {
  sk.baseAxes[ax].moving = sk.axes[ax].moving = 1.45;
  sk.baseAxes[ax].still = sk.axes[ax].still = 1.45;
}
sk.baseMove = sk.movement = 1.3;
// Scoreboard dominance (heroOf reads kills, not the body that earned
// them) - staged so the predator chain has a real threat to chase.
menace.kills = 25;
menace.deaths = 0;
// And full sweatlord: aim without engagement still doesn't farm - the
// real menace HUNTS.
(room.bots as unknown as { brains: Map<string, { sweat: number }> }).brains.get(menace.id)!.sweat = 1;

// Dealt x4: every shell he spawns carries 4x direct bonus.
const projs = room.projectiles as unknown as { projs: Map<string, { directBonus: number }> };
const origSpawn = room.projectiles.spawn.bind(room.projectiles);
room.projectiles.spawn = (pid, wt, o, d, v, sid, lag): string | null => {
  const id = origSpawn(pid, wt, o, d, v, sid, lag);
  if (pid === menace.id && id) {const p = projs.projs.get(id); if (p) {p.directBonus = 4;}}
  return id;
};
// Taken x0.1: the applyDamage funnel scales incoming damage for him.
const origDmg = room.players.applyDamage.bind(room.players);
room.players.applyDamage = (targetId: string, damage: number): ReturnType<typeof origDmg> =>
  origDmg(targetId, targetId === menace.id ? damage * 0.1 : damage);

console.log(`menace=${menace.id} team=${menace.team} (4x dealt / 0.1x taken)`);

const fmt = (): string => players
  .filter((p) => p.id !== menace.id)
  .map((p) => `${p.id.replace('bot:', '').padEnd(10)} ${p.team?.padEnd(5)} k=${p.kills} d=${p.deaths} rsv=${(room.bots.skillOf(p.id)?.resolve ?? -1).toFixed(2)}`)
  .join('\n  ');

let died = false;
for (let s = 0; s <= 300; s += 30) {
  if (s > 0) {step(room, 600, 0.05);} // 30 sim-seconds per print
  console.log(`\n--- t=${s}s ---  MENACE k=${menace.kills} d=${menace.deaths} hp=${Math.round(menace.health)}\n  ${fmt()}`);
  if (menace.deaths > 0 && !died) {died = true; console.log('  >>> MENACE DIED');}
}
