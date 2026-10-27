// Headhunt token-fate probe: do drops get collected or rot to TTL while
// bots orbit them? Prints pool size over time + per-token lifespan.
import { readFileSync } from 'node:fs';
import { mkRoom, step } from '../tests/scenarios/harness.ts';
import { hmParseBin, hmHeight } from '../../shared/heightfield.ts';
import { simNow } from '../src/simClock.ts';

const MAP = 'headhunt';
const mapJson = JSON.parse(readFileSync(`${import.meta.dir}/../../maps/${MAP}.json`, 'utf8'));
const field = hmParseBin(new Uint8Array(readFileSync(`${import.meta.dir}/../../maps/${mapJson.terrain}`)));
const base = (b?: { x: number; z: number }) => b ? { x: b.x, y: hmHeight(field, b.x, b.z), z: b.z } : undefined;
const room = mkRoom({ ...mapJson, mode: 'headhunt', bots: 16, botFill: 16,
  bases: { alpha: base(mapJson.bases?.alpha) ?? { x: 0, y: 0, z: 0 },
           bravo: base(mapJson.bases?.bravo) ?? { x: 80, y: 80, z: 80 } } }, 'headhunt', 7, false, field);
room.mapSrc = MAP;
room.structs.attach();

// Wrap spawn/remove to ledger token fates.
const pk: any = (room as any).pickups;
const born = new Map<number, number>();
const origSpawn = pk.spawn.bind(pk);
pk.spawn = (pos: any, kind: string, armS = 0, val = 1, lockTeam?: string, lockS = 0, vel?: any) => { origSpawn(pos, kind, armS, val, lockTeam, lockS, vel); };
const origRemove = (pk as any).remove.bind(pk);
let collected = 0, rotted = 0;
const ages: number[] = [];
(pk as any).remove = (id: number, by: string | null) => { if (by) collected++; else rotted++; if (born.has(id)) ages.push(simNow() / 1000 - born.get(id)!); origRemove(id, by); };

const DT = 0.05, MINS = 15;
const ticks = Math.round(MINS * 60 / DT);
for (let t = 0; t < ticks; t++) {
  step(room, 1, DT);
  room.messages.respawnTick(simNow());
  if (t % Math.round(60 / DT) === 0) {
    const pool = [...pk.snapshot()];
    const toks = pool.filter((p: any) => p.kind === 'token');
    const tagged = toks.map((p: any) => `${Math.round(p.pos.x)},${Math.round(p.pos.z)}`).slice(0, 5);
    console.log(`t=${(t * DT / 60).toFixed(0)}m pool=${pool.length} tokens=${toks.length} @${tagged.join(' ')}`);
  }
}
ages.sort((a, b) => a - b);
console.log(`DONE collected=${collected} rotted=${rotted} medianLife=${ages[ages.length >> 1]?.toFixed(1) ?? '-'}s`);
