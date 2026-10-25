import { mkRoom, step, pin } from './harness.ts';
import { BOT_LOADOUTS } from '../../../shared/botLoadouts.ts';

for (const seed of [11, 22, 33, 44, 55]) {
  const room = mkRoom({ mode: 'tdm', bots: 2, bases: { alpha: { x: -300, y: 60, z: 0 }, bravo: { x: 300, y: 60, z: 0 } } }, 'tdm', seed);
  const [a, b] = [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
  const ctl = room.bots as unknown as { loadouts: Map<string, unknown>; roster: { refitClass(id: string): void } };
  ctl.loadouts.set(a!.id, BOT_LOADOUTS[0]);
  ctl.loadouts.set(b!.id, BOT_LOADOUTS[6]);
  ctl.roster.refitClass(a!.id); ctl.roster.refitClass(b!.id);
  let t = 0;
  for (let i = 0; i < 700; i++) {
    pin(room, a!.id, { x: -5, y: 32, z: 0 });
    pin(room, b!.id, { x: 5, y: 32, z: 0 });
    step(room, 1); t += 1 / 20;
    if (a!.isDead || b!.isDead) {break;}
  }
  const w = a!.isDead ? 'flanker' : 'chaser';
  const win = a!.isDead ? b : a;
  console.log(`seed ${seed}: ${w} wins @${t.toFixed(1)}s  winnerHP=${win!.health}/${win!.maxHealth} armor=${win!.armor}`);
}
