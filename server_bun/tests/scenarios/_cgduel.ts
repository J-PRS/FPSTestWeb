// Scratch: chaingun vs plasma gun over several seeds — every slot forced to
// the gun under test so the band pick can't dodge the question.
//   bun tests/scenarios/_cgduel.ts
import { mkRoom, step, pin } from './harness.ts';
import { type BotLoadout } from '../../../shared/botLoadouts.ts';
import { WeaponType } from '../../../shared/weapons.ts';
import type { PlayerState } from '../../src/types.ts';

type Room = ReturnType<typeof mkRoom>;
const botsOf = (room: Room): PlayerState[] =>
  [...room.players.getAllPlayers().values()].filter((p) => p.isBot);

const W = WeaponType;
const cg: BotLoadout  = { perk: 'none', near: W.Chaingun,  mid: W.Chaingun,  far: W.Chaingun,  belt: W.Grenade, side: W.Pistol };
const pg: BotLoadout  = { perk: 'none', near: W.Sprinkler, mid: W.Sprinkler, far: W.Sprinkler, belt: W.Grenade, side: W.Pistol };

function duel(loA: BotLoadout, loB: BotLoadout, distM: number, seed: number, maxTicks = 1500): 'a' | 'b' | '-' {
  const room = mkRoom({
    mode: 'tdm', bots: 2,
    bases: { alpha: { x: -300, y: 60, z: 0 }, bravo: { x: 300, y: 60, z: 0 } },
  }, 'tdm', seed);
  const [a, b] = botsOf(room);
  const ctl = room.bots as unknown as { loadouts: Map<string, BotLoadout>; roster: { refitClass(id: string): void } };
  ctl.loadouts.set(a!.id, loA);
  ctl.loadouts.set(b!.id, loB);
  ctl.roster.refitClass(a!.id);
  ctl.roster.refitClass(b!.id);
  for (let i = 0; i < maxTicks; i++) {
    pin(room, a!.id, { x: -distM / 2, y: 32, z: 0 });
    pin(room, b!.id, { x: distM / 2, y: 32, z: 0 });
    step(room, 1);
    if (a!.isDead || b!.isDead) break;
  }
  return a!.isDead ? 'b' : b!.isDead ? 'a' : '-';
}

for (const dist of [10, 25, 50, 75, 100]) {
  let wA = 0, wB = 0, d = 0;
  for (let seed = 101; seed <= 108; seed++) {
    const r = duel(cg, pg, dist, seed);
    if (r === 'a') wA++; else if (r === 'b') wB++; else d++;
  }
  console.log(`dist ${dist}m — chaingun ${wA}  sprinkler ${wB}  draw ${d}`);
}
process.exit(0);
