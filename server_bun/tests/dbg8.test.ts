import { it } from 'bun:test';
import { Room } from '../src/Room.ts';
import { resolveMapSpec } from '../../shared/mapSpec.ts';
const flat = { size: 4, data: new Uint8Array(16).fill(60), stride: 1 };
it('dbg8', () => {
  const room = new Room('t', flat, '', resolveMapSpec({ creatures: { baneling: 1 }, bots: 1 }));
  const bot = room.players.getPlayer('BOT-VEKTOR-01')!;
  bot.position = { x: 0, y: 31, z: 0 };
  room.creatureSim.step(0.05);
  for (let i = 0; i < 600; i++) {
    room.creatureSim.step(0.05);
    const r = room.creatureSim.roster();
    for (const c of r) {
      const d = Math.hypot(c.tp!.x - c.position.x, c.tp!.z - c.position.z);
      if (d < 15) console.log(i, 'd=', d.toFixed(2), 'pos', c.position.x.toFixed(1), c.position.z.toFixed(1), 'vel', (c.velocity.x).toFixed(1), (c.velocity.z).toFixed(1), 'st', c.state);
    }
  }
});
