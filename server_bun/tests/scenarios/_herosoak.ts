// Scratch: hero-overdrive proof in a REAL room sim. One bravo bot is
// staged as an un-damageable menace - kills=30, deaths=0, 0.1x-effective
// health (100k pool) - so the enemy team's results channel reads a
// dominant threat that takes no damage. step() runs the room's real
// think/senses/heroTick pipeline; the printout is per-bot resolve over
// sim-minutes. The menace's own resolve should stay ~0 (no one
// dominates HIM); at least one enemy should pass 1 (overdrive) within
// ~60s if the ramp works.
//   bun tests/scenarios/_herosoak.ts
import { mkRoom, step } from './harness.ts';

const BOTS = 14;
const room = mkRoom({
  mode: 'headhunt', bots: BOTS, botSkill: 'medium',
  arena: { x: 0, z: 0, radius: 300 },
}, 'headhunt', 4242);

const players = [...room.players.getAllPlayers().values()];
const menace = players.find((p) => p.team === 'bravo');
if (!menace) {throw new Error('no bravo bot staged');}
menace.kills = 30;
menace.deaths = 0;
menace.maxHealth = 100000;
menace.health = 100000;
console.log(`menace=${menace.id} team=${menace.team}`);

const fmt = (): string => players
  .filter((p) => p.id !== menace.id)
  .map((p) => `${p.id.replace('bot:', '').padEnd(10)} ${p.team?.padEnd(5)} rsv=${(room.bots.skillOf(p.id)?.resolve ?? -1).toFixed(2)}`)
  .join('\n  ');

for (let s = 0; s <= 120; s += 20) {
  if (s > 0) {step(room, 400, 0.05);} // 20 sim-seconds per print
  console.log(`\n--- t=${s}s ---\n  ${fmt()}`);
}
console.log(`\nmenace rsv=${(room.bots.skillOf(menace.id)?.resolve ?? -1).toFixed(2)}`);
