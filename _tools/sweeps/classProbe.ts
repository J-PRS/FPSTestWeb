// classProbe.ts — why don't heavy bots fly? Per-class tallies in a
// headhunt era: airborne share, jet duty, hunting share, posted share.
// bun _tools/sweeps/classProbe.ts
import { mkRoom, step } from '../../server_bun/tests/scenarios/harness.ts';
import { hmParseBin, hmScaled, hmHeight } from '../../shared/heightfield.ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const buf = readFileSync(resolve(import.meta.dir, '../../maps/rimrock.bin'));
const spec = JSON.parse(readFileSync(resolve(import.meta.dir, '../../maps/rimrock.json'), 'utf8')) as { heightScale?: number };
const field = hmScaled(hmParseBin(buf, spec.heightScale ?? 1), spec.heightScale ?? 1);

const room = mkRoom({ mode: 'headhunt', bots: 15, botSkill: 'medium', arena: { x: 0, z: 0, radius: 420 } }, 'headhunt', 1, false, field);
type Brain = { jetDebug: { why: string; out: boolean }; stuckDiag: Record<string, number | boolean>; huntTarget: { x: number } | null; skill: { airLove: number } };
const ctl = room.bots as unknown as { brains: Map<string, Brain> };
const clsOf = new Map<string, string>();
for (const p of room.players.getAllPlayers().values()) {
  if (!p.isBot) {continue;}
  clsOf.set(p.id, (p as unknown as { armorClass?: string }).armorClass ?? 'medium');
}
const rows = new Map<string, { n: number; air: number; jet: number; hunt: number; post: number; al: number }>();
for (let s = 0; s < 600; s += 1) {
  step(room, 10, 0.05);
  for (const [id, b] of ctl.brains) {
    const cls = clsOf.get(id) ?? 'medium';
    const r = rows.get(cls) ?? { n: 0, air: 0, jet: 0, hunt: 0, post: 0, al: 0 };
    r.n += 1; r.al = b.skill.airLove;
    const p = room.players.getPlayer(id) as { position: { x: number; y: number; z: number } } | null;
    if (p && p.position.y - hmHeight(field, p.position.x, p.position.z) > 5) {r.air += 1;}
    if (b.jetDebug.out) {r.jet += 1;}
    if (b.huntTarget) {r.hunt += 1;}
    if (b.stuckDiag.posted) {r.post += 1;}
    rows.set(cls, r);
  }
}
for (const [cls, r] of [...rows.entries()].toSorted((a, b) => a[0].localeCompare(b[0]))) {
  const pct = (v: number): string => `${(v / r.n * 100).toFixed(0)}%`;
  console.log(`${cls.padEnd(7)} ha=${pct(r.air)} jet=${pct(r.jet)} hunting=${pct(r.hunt)} posted=${pct(r.post)} airLove=${r.al.toFixed(2)}`);
}
room.dispose();
