/** Siege probe: run bastion CTF, print siege tasks, besieger positions,
 *  and generator hp over time. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hmParseBin, hmHeight } from '../../shared/heightfield.ts';
import { mkRoom, step } from '../../server_bun/tests/scenarios/harness.ts';
import { simNow } from '../../server_bun/src/simClock.ts';

const arg = (n: string, d: string) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1]! : d; };
const MINS = Number(arg('mins', 3));
const BOTS = Number(arg('bots', 20));
const SEED = Number(arg('seed', 1337));

const spec = JSON.parse(readFileSync(resolve(import.meta.dir, '../../maps/bastion.json'), 'utf8'));
const f = hmParseBin(new Uint8Array(readFileSync(resolve(import.meta.dir, `../../maps/${spec.terrain}`))));
const at = (x: number, z: number) => ({ x, y: hmHeight(f, x, z), z });
const bases = { alpha: at(spec.bases.alpha.x, spec.bases.alpha.z), bravo: at(spec.bases.bravo.x, spec.bases.bravo.z) };

const room = mkRoom({ ...spec, mode: 'ctf', bots: BOTS, botFill: BOTS, bases }, 'ctf', SEED, false, f);
const WATCH = arg('watch', '');   // tail id, e.g. S-08 — prints pos+dest every 2s
const dt = 0.05;
let watchId = '';
for (let i = 0; i < MINS * 60 * 20; i++) {
  step(room, 1, dt);
  room.messages.respawnTick(simNow());
  if (WATCH && i % (2 * 20) === 0) {
    if (!watchId) {
      for (const t of room.bots.sense.debugTasks('bravo')) if (t.id.endsWith(WATCH)) watchId = t.id;
      for (const t of room.bots.sense.debugTasks('alpha')) if (t.id.endsWith(WATCH)) watchId = t.id;
    }
    const p = watchId && room.players.getPlayer(watchId);
    if (p && !p.isDead) {
      const d = room.bots.debugDest(watchId);
      console.log(`  w ${(i * dt).toFixed(0)}s pos=${p.position.x.toFixed(1)},${p.position.y.toFixed(1)},${p.position.z.toFixed(1)} dst=${d ? `${d.x.toFixed(1)},${d.y.toFixed(1)},${d.z.toFixed(1)}` : '-'} {${room.bots.debugBrain(watchId)}}`);
    } else if (p?.isDead) {
      console.log(`  w ${(i * dt).toFixed(0)}s dead`);
      watchId = '';
    }
  }
  if (i % (20 * 20) === 0) { // every 20s
    const parts: string[] = [];
    for (const d of room.deployables.items.values()) {
      if (d.kind === 'generator') parts.push(`gen-${d.team?.[0]}@${d.hp.toFixed(0)}`);
    }
    for (const team of ['alpha', 'bravo']) {
      for (const t of room.bots.sense.debugTasks(team)) {
        if (t.kind !== 'siege') continue;
        const p = room.players.getPlayer(t.id);
        const dd = p ? Math.hypot(p.position.x - t.goal.x, p.position.z - t.goal.z) : -1;
        const dest = room.bots.debugDest(t.id);
        const ds = dest ? ` dst=${dest.x.toFixed(0)},${dest.y.toFixed(0)},${dest.z.toFixed(0)}` : '';
        const br = p && !p.isDead ? ` {${room.bots.debugBrain(t.id)}}` : '';
        parts.push(`${t.id.slice(-4)}(${p?.isDead ? 'dead' : `${dd.toFixed(0)}m@${p.position.x.toFixed(0)},${p.position.y.toFixed(0)},${p.position.z.toFixed(0)}`}${ds}${br}→${t.goal.x.toFixed(0)},${t.goal.z.toFixed(0)})`);
      }
    }
    console.log(`t=${(i * dt).toFixed(0)}s ${parts.join(' ')}`);
  }
}
