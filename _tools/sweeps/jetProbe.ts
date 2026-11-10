// jetProbe.ts — which jet gates arm per bot-second in a dm era.
// airLove=1 vs 0 comparison. bun _tools/sweeps/jetProbe.ts
import { mkRoom, step } from '../../server_bun/tests/scenarios/harness.ts';
import { hmParseBin, hmScaled } from '../../shared/heightfield.ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const buf = readFileSync(resolve(import.meta.dir, '../../maps/rimrock.bin'));
const spec = JSON.parse(readFileSync(resolve(import.meta.dir, '../../maps/rimrock.json'), 'utf8')) as { heightScale?: number };
const field = hmScaled(hmParseBin(buf, spec.heightScale ?? 1), spec.heightScale ?? 1);

for (const al of [0, 1]) {
  const room = mkRoom({ mode: 'dm', bots: 16, botSkill: 'medium', arena: { x: 0, z: 0, radius: 420 } }, 'dm', 1, false, field);
  const ctl = room.bots as unknown as { brains: Map<string, { skill: { airLove: number }; jetDebug: { why: string; out: boolean } }> };
  for (const b of ctl.brains.values()) {b.skill.airLove = al;}
  const whys = new Map<string, number>();
  let jetTicks = 0, total = 0;
  for (let s = 0; s < 480; s += 1) {
    step(room, 10, 0.05);
    for (const b of ctl.brains.values()) {
      const d = b.jetDebug;
      total += 1;
      if (d.out) {jetTicks += 1; whys.set(d.why, (whys.get(d.why) ?? 0) + 1);}
    }
  }
  console.log(`airLove=${al} jet-duty ${(jetTicks / total * 100).toFixed(1)}% of samples`);
  for (const [w, n] of [...whys.entries()].toSorted((a, b) => b[1] - a[1])) {
    console.log(`  ${w.padEnd(10)} ${(n / jetTicks * 100).toFixed(1)}% of jets`);
  }
  room.dispose();
}
