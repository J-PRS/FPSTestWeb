/* oxlint-disable no-console */
// Greedy-vs-MPC A/B on the real CTF soak room: same seed, same bots,
// 90s sim. Measures armed-bot count, per-arm speed, grabs, caps.
import { mkRoom, step, pin } from './harness.ts';
import { hmParseBin, hmHeight } from '../../../shared/heightfield.ts';
import { readFileSync } from 'node:fs';
import { BotGreedy } from '../../src/botGreedy.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';

const BOTS = Number(process.env.BOTS ?? 10);
const SIM_S = Number(process.env.SIM_S ?? 90);
const DRIVER = process.env.DRIVER ?? 'mpc'; // mpc | greedy

const field = hmParseBin(new Uint8Array(readFileSync(`${import.meta.dir}/../../../maps/peaks.bin`)));
const at = (x: number, z: number) => ({ x, y: hmHeight(field, x, z), z });
const room = mkRoom({
  mode: 'ctf', bots: BOTS, botSkill: 'impossible',
  bases: { alpha: at(-150, 0), bravo: at(150, 0) },
  arena: { x: 0, z: 0, radius: 450 },
}, 'ctf', 1337, false, field);
room.players.addPlayer('ref');
pin(room, 'ref', { x: 800, y: 300, z: 800 });

const sb = room.bots as unknown as { mpc: unknown; mpcArm: Map<string, unknown>; held?: Map<string, unknown> };
if (DRIVER === 'greedy') {
  sb.mpc = new BotGreedy(room.moveSim, field, (id, i, s) => (room as unknown as { botInput: (a: string, b: unknown, c: number) => void }).botInput(id, i, s));
}

let grabs = 0, caps = 0;
const armSpeed = new Map<string, { n: number; sum: number; max: number }>();
let armSamples = 0;
// Grabs read the flag sim's own state transitions (carried edges) —
// there is no flagGrab event; flagUpdate is the only broadcast.
const carry = new Map<string, string>();
const lastState = new Map<string, string>();
let msgs: ServerMessage[] = [];
const origBc = room.connections.broadcast.bind(room.connections);
room.connections.broadcast = ((m: ServerMessage): void => { msgs.push(m); origBc(m); }) as typeof room.connections.broadcast;

for (let t = 0; t < SIM_S; t += 0.05) {
  step(room, 1);
  for (const id of sb.mpcArm.keys()) {
    const p = room.players.getPlayer(id);
    if (!p) {continue;}
    const sp = Math.hypot(p.velocity.x, p.velocity.z);
    const a = armSpeed.get(id) ?? { n: 0, sum: 0, max: 0 };
    a.n += 1; a.sum += sp; a.max = Math.max(a.max, sp);
    armSpeed.set(id, a);
    armSamples += 1;
  }
  for (const [team, f] of room.flags!.flags) {
    const prev = lastState.get(team);
    if (f.state === 'carried' && f.carrier && carry.get(team) !== f.carrier) {
      grabs += 1;
      carry.set(team, f.carrier);
    } else if (f.state !== 'carried' && prev === 'carried') {
      carry.delete(team);
    }
    lastState.set(team, f.state);
  }
  while (msgs.length) {
    const m = msgs.shift()!;
    if (m.type === 'teamScore') {caps += 1;}
  }
}
const armed = [...armSpeed.entries()];
console.log(`driver=${DRIVER} armed=${sb.mpcArm.size} armsSeen=${armed.length} samples=${armSamples}`);
for (const [id, a] of armed) {
  console.log(`  ${id} avg=${(a.sum / a.n).toFixed(1)} vmax=${a.max.toFixed(0)}`);
}
console.log(`grabs=${grabs} caps=${caps}`);
process.exit(0);
