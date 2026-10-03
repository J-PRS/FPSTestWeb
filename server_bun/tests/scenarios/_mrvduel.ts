// Scratch: mortar vs MRV over many seeds — run with
//   bun tests/scenarios/_mrvduel.ts
import { mkRoom, step, pin, watch } from './harness.ts';
import { type BotLoadout } from '../../../shared/botLoadouts.ts';
import { WeaponType } from '../../../shared/weapons.ts';
import type { PlayerState } from '../../src/types.ts';

type Room = ReturnType<typeof mkRoom>;
const botsOf = (room: Room): PlayerState[] =>
  [...room.players.getAllPlayers().values()].filter((p) => p.isBot);

// Pure-weapon rigs: every slot holds the gun under test so band picks can't
// sneak PlasmaCannon/Chaingun damage into the totals.
const artillery: BotLoadout = { perk: 'bombardier', near: WeaponType.Mortar, mid: WeaponType.Mortar, far: WeaponType.Mortar, belt: WeaponType.Grenade, side: WeaponType.Pistol };
const mrv: BotLoadout = { perk: 'bombardier', near: WeaponType.MRVLauncher, mid: WeaponType.MRVLauncher, far: WeaponType.MRVLauncher, belt: WeaponType.Grenade, side: WeaponType.Pistol };

interface Acc { shots: number; hits: number; dmg: number }

function duel(loA: BotLoadout, loB: BotLoadout, distM: number, seed: number, idleDrawS = 20, maxSimS = 180, maxMs = 10_000):
    { r: 'a' | 'b' | '-'; a: Acc; b: Acc; ticks: number } {
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
  const w = watch(room);
  // Draw = damage inactivity, not elapsed time: every playerHit resets
  // the clock so chipping exchanges get as long as they need. A hard
  // sim ceiling + realtime guard still bound the pathological cases.
  const idleTicks = Math.round(idleDrawS / 0.05);
  const hardTicks = Math.round(maxSimS / 0.05);
  const deadline = Date.now() + maxMs;
  let ticks = 0, lastDmg = 0, hits = 0;
  while (ticks - lastDmg < idleTicks && ticks < hardTicks && Date.now() < deadline) {
    pin(room, a!.id, { x: -distM / 2, y: 32, z: 0 });
    pin(room, b!.id, { x: distM / 2, y: 32, z: 0 });
    step(room, 1);
    ticks++;
    const n = w.msgs.length;
    for (; hits < n; hits++) if (w.msgs[hits]!.type === 'playerHit') lastDmg = ticks;
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
  return { r: a!.isDead ? 'b' : b!.isDead ? 'a' : '-', a: acc(a!.id), b: acc(b!.id), ticks };
}

for (const dist of [25, 43, 75, 100]) {
  let wA = 0, wB = 0, d = 0;
  const tA: Acc = { shots: 0, hits: 0, dmg: 0 }, tB: Acc = { shots: 0, hits: 0, dmg: 0 };
  let ticks = 0;
  for (let seed = 101; seed <= 108; seed++) {
    const dres = duel(artillery, mrv, dist, seed);
    if (dres.r === 'a') wA++; else if (dres.r === 'b') wB++; else d++;
    ticks += dres.ticks;
    tA.shots += dres.a.shots; tA.hits += dres.a.hits; tA.dmg += dres.a.dmg;
    tB.shots += dres.b.shots; tB.hits += dres.b.hits; tB.dmg += dres.b.dmg;
  }
  const pct = (t: Acc) => t.shots ? (100 * t.hits / t.shots).toFixed(0) + '%' : '–';
  console.log(`dist ${dist}m — mortar ${wA}  mrv ${wB}  draw ${d}  avg ${(ticks / 8 * 0.05).toFixed(0)}s` +
    `  |  MOR ${tA.shots}sh ${tA.hits}hit ${pct(tA)} ${tA.dmg | 0}dmg` +
    `  |  MRV ${tB.shots}sh ${tB.hits}hit ${pct(tB)} ${tB.dmg | 0}dmg`);
}
