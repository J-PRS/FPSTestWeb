// igun ladder soak: impossible bots race the rungs. Measures sim-time
// to each rung and the fastest climb to the Chaingun pinnacle.
//   bun tests/scenarios/_igunsoak.ts [seeds]
import { mkRoom, step, pin } from './harness.ts';
import { WeaponType } from '../../../shared/weapons.ts';

const SEEDS = Number(process.argv[2]) || 3;
const BOTS = 8;
const CAP_S = 1800;
const DT = 0.05;

for (let seed = 301; seed < 301 + SEEDS; seed++) {
  const room = mkRoom({ mode: 'dm', bots: BOTS, botSkill: 'impossible', arena: { x: 0, z: 0, radius: 300 } }, 'dm', seed, false);
  room.mods.gungame = true; room.mods.igun = true;
  room.gunGameReset();
  const bots = [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
  bots.forEach((b, i) => {
    const a = (i / bots.length) * Math.PI * 2;
    pin(room, b.id, { x: Math.cos(a) * 180, y: 65, z: Math.sin(a) * 180 });
  });
  (room as { endMatch(w: string): void }).endMatch = () => {};
  const firstAt = new Map<string, Map<number, number>>(); // bot -> rung -> sim s
  const deaths = new Map<string, number>();
  for (const b of bots) {firstAt.set(b.id, new Map()); deaths.set(b.id, 0);}
  let simS = 0; let climaxS = -1; let climaxBot = '';
  for (let t = 0; t < CAP_S && climaxS < 0; t += DT) {
    step(room, 1, DT); simS += DT;
    for (const b of bots) {
      const r = room.gunRungOf(b.id);
      const m = firstAt.get(b.id)!;
      if (!m.has(r)) {m.set(r, simS);}
      if (r >= 8 && climaxS < 0) {climaxS = simS; climaxBot = b.id;}
    }
  }
  console.log(`seed=${seed} simS=${simS.toFixed(0)} ${climaxS > 0 ? `CHAINGUN at ${climaxS.toFixed(0)}s by ${climaxBot}` : 'nobody hit climax'}`);
  for (const b of bots) {
    const m = firstAt.get(b.id)!;
    const top = Math.max(...m.keys());
    console.log(`  ${b.id.padEnd(16)} topRung=${top} rungs: ${[...m.entries()].sort((a, b2) => a[0] - b2[0]).map(([r, s]) => `r${r}@${s.toFixed(0)}s`).join(' ')}`);
  }
}
process.exit(0);
