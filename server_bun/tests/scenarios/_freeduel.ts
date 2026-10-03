// Scratch: chaingun vs sprinkler with FREE movement — pin once at spawn to
// clear protection, then the brains own the bodies. Measures the real duel,
// not stand-and-deliver weapon efficiency.
//   bun tests/scenarios/_freeduel.ts
import { mkRoom, step, pin, watch } from './harness.ts';
import { type BotLoadout } from '../../../shared/botLoadouts.ts';
import { WeaponType } from '../../../shared/weapons.ts';
import type { PlayerState } from '../../src/types.ts';

type Room = ReturnType<typeof mkRoom>;
const botsOf = (room: Room): PlayerState[] =>
  [...room.players.getAllPlayers().values()].filter((p) => p.isBot);

const W = WeaponType;
const cg: BotLoadout = { perk: 'none', near: W.Chaingun,  mid: W.Chaingun,  far: W.Chaingun,  belt: W.Grenade, side: W.Pistol };
const sp: BotLoadout = { perk: 'none', near: W.Sprinkler, mid: W.Sprinkler, far: W.Sprinkler, belt: W.Grenade, side: W.Pistol };

interface Acc { shots: number; hits: number; dmg: number }

function duel(loA: BotLoadout, loB: BotLoadout, distM: number, seed: number, maxTicks = 3600):
    { r: 'a' | 'b' | '-'; a: Acc; b: Acc } {
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
  // Spawn pin ONLY — clears protection and opens at distM; after this the
  // brains move wherever they want.
  pin(room, a!.id, { x: -distM / 2, y: 32, z: 0 });
  pin(room, b!.id, { x: distM / 2, y: 32, z: 0 });
  const w = watch(room);
  for (let i = 0; i < maxTicks; i++) {
    step(room, 1);
    if (a!.isDead || b!.isDead) break;
  }
  const acc = (id: string): Acc => {
    // Honest accuracy: a shot counts once, when ANY damage traced back to
    // its projectileCreated id — a 6-bomblet volley is one connect, not six.
    const shots = new Set(
      w.msgs.filter((m) => m.type === 'projectileCreated' && (m as { ownerId?: string }).ownerId === id)
        .map((m) => (m as { projectileId?: string }).projectileId));
    const hitShots = new Set(
      w.msgs.filter((m) => m.type === 'playerHit' && (m as { shooterId?: string }).shooterId === id)
        .map((m) => (m as { shotId?: string }).shotId)
        .filter((s): s is string => s !== undefined && shots.has(s)));
    return {
      shots: shots.size,
      hits: hitShots.size,
      dmg: w.msgs.filter((m) => m.type === 'playerHit' && (m as { shooterId?: string }).shooterId === id)
        .reduce((s, m) => s + ((m as { damage?: number }).damage ?? 0), 0),
    };
  };
  return { r: a!.isDead ? 'b' : b!.isDead ? 'a' : '-', a: acc(a!.id), b: acc(b!.id) };
}

for (const dist of [10, 25, 50, 75, 100]) {
  let wA = 0, wB = 0, d = 0;
  const tA: Acc = { shots: 0, hits: 0, dmg: 0 }, tB: Acc = { shots: 0, hits: 0, dmg: 0 };
  for (let seed = 101; seed <= 108; seed++) {
    const { r, a, b } = duel(cg, sp, dist, seed);
    if (r === 'a') wA++; else if (r === 'b') wB++; else d++;
    tA.shots += a.shots; tA.hits += a.hits; tA.dmg += a.dmg;
    tB.shots += b.shots; tB.hits += b.hits; tB.dmg += b.dmg;
  }
  const pct = (t: Acc) => t.shots ? (100 * t.hits / t.shots).toFixed(0) + '%' : '–';
  console.log(`dist ${dist}m — chaingun ${wA}  sprinkler ${wB}  draw ${d}` +
    `  |  CG ${tA.shots}sh ${tA.hits}hit ${pct(tA)} ${tA.dmg}dmg` +
    `  |  SP ${tB.shots}sh ${tB.hits}hit ${pct(tB)} ${tB.dmg}dmg`);
}
process.exit(0);
