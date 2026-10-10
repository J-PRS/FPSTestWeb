// Scratch: server-side bot ski census — mkRoom with bots, step the room,
// sample p.skiing + airborne per bot to see whether brains ever hold ski.
import { mkRoom, step } from './harness.ts';
import { hmParseBin } from '../../../shared/heightfield.ts';
import { join } from 'node:path';

const MODE = process.argv[2] ?? 'dm';
const SECONDS = Number(process.argv[3] ?? 60);
const room = mkRoom({ mode: MODE, bots: 10 }, MODE, 1337);
try {
  const buf = new Uint8Array(await Bun.file(join(import.meta.dir, '..', '..', '..', 'maps', 'dunes.bin')).arrayBuffer());
  const f = hmParseBin(buf);
  room.field = f;
  room.ballSim.attachField(f);
  room.moveSim.attachField(f, (pid) => room.players.getPlayer(pid)?.position);
} catch { /* flat */ }

const per = new Map<string, { n: number; ski: number; air: number; hasMove: number }>();
for (let i = 0; i < SECONDS / 0.05; i++) {
  step(room, 1);
  for (const p of room.players.getAllPlayers().values()) {
    if (!p.isBot || p.isDead) continue;
    let r = per.get(p.id);
    if (!r) { r = { n: 0, ski: 0, air: 0, hasMove: 0 }; per.set(p.id, r); }
    r.n++;
    if (p.skiing) r.ski++;
    if (Math.abs(p.velocity.y) > 4) r.air++;
  }
}
let tot = { n: 0, ski: 0, air: 0 };
for (const [id, r] of per) { tot.n += r.n; tot.ski += r.ski; tot.air += r.air; console.log(`${id.slice(-8)} n=${r.n} ski=${(100 * r.ski / r.n).toFixed(1)}% air=${(100 * r.air / r.n).toFixed(1)}%`); }
console.log(`ALL ski=${(100 * tot.ski / tot.n).toFixed(1)}% air=${(100 * tot.air / tot.n).toFixed(1)}%`);
