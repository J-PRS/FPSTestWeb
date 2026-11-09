/**
 * _tools/q3spawncheck.ts — static spawn safety audit for q3conv maps.
 *
 *   bun _tools/q3spawncheck.ts [map ...]
 *
 * For every spawn/teamSpawn: floor = highest structure top at/below the
 * spawn point (SolidWorld.topAt), gap = spawn.y - floor. Flags:
 *   buried   floor above spawn head (gap << 0)
 *   float    no floor within 4m below (hole / terrain-only / bad Y)
 *   headroom a collider bottom sits inside the standing capsule column
 */
import { SolidWorld } from '../shared/solidWorld.ts';
import { structureColliders, type StructureCollider } from '../shared/ballCollide.ts';
import { hmParseBin, hmHeight } from '../shared/heightfield.ts';

const MAPS = process.argv.slice(2);
const ALL = ['oacmpdm2','oacmpdm4','oacmpdm5','oacmpdm7','oacmpdm8','oacmpdm9',
  'oacmpctf1','oacmpctf2','oajgdm4','oacmp2dm_utemple'];

interface Spawn { x: number; y: number; z: number }

function headroomBlocked(cols: readonly StructureCollider[], x: number, z: number,
  floorY: number, headY: number): number {
  let n = 0;
  for (const c of cols) {
    if (c.dome) {continue;}
    const dx = x - c.cx, dz = z - c.cz;
    const lx = dx * c.cos + dz * c.sin;
    const lz = -dx * c.sin + dz * c.cos;
    if (lx < -c.hx - 0.3 || lx > c.hx + 0.3 || lz < -c.hz - 0.3 || lz > c.hz + 0.3) {continue;}
    const bot = c.cy - c.hy, top = c.cy + c.hy;
    // collider occupies standing space between feet+0.2 and head
    if (bot < headY && top > floorY + 0.2) {n++;}
  }
  return n;
}

for (const name of (MAPS.length ? MAPS : ALL)) {
  const spec = await Bun.file(`maps/${name}.json`).json();
  const spawns: { s: Spawn; tag: string }[] = [
    ...(spec.spawns ?? []).map((s: Spawn) => ({ s, tag: 'dm' })),
    ...((spec.teamSpawns?.alpha ?? []) as Spawn[]).map((s: Spawn) => ({ s, tag: 'alpha' })),
    ...((spec.teamSpawns?.bravo ?? []) as Spawn[]).map((s: Spawn) => ({ s, tag: 'bravo' })),
  ];
  const cols = structureColliders(spec.structures);
  const sw = new SolidWorld(cols);
  const field = spec.terrain
    ? hmParseBin(new Uint8Array(await Bun.file(`maps/${spec.terrain}`).arrayBuffer()), spec.heightScale ?? 1, spec.tileSize)
    : null;
  let buried = 0, float = 0, head = 0, ok = 0;
  const bad: string[] = [];
  for (const { s, tag } of spawns) {
    const floor = sw.topAt(s.x, s.z, s.y + 0.5);
    const gap = s.y - floor;
    const hr = floor > -1e8 ? headroomBlocked(cols, s.x, s.z, floor, s.y + 1.7) : 0;
    if (gap < -0.6 || hr > 0) {
      if (gap < -0.6) {buried++;} else {head++;}
      if (bad.length < 4) {bad.push(`${tag}@(${s.x.toFixed(0)},${s.y.toFixed(0)},${s.z.toFixed(0)}) gap=${gap === -Infinity || gap > 1e8 ? 'inf' : gap.toFixed(1)} hr=${hr}`);}
    } else if (floor === -Infinity || gap > 4) {
      // NOFLOOR may still be fine — spawn could stand on the terrain
      // heightfield rather than a structure. terrain.bin is the same
      // field the server/client collide against.
      const terr = field ? hmHeight(field, s.x, s.z) : -Infinity;
      const tgap = s.y - terr;
      if (terr > -1e8 && tgap >= -0.6 && tgap <= 4) { ok++; continue; }
      float++;
      if (bad.length < 4) {bad.push(`${tag}@(${s.x.toFixed(0)},${s.y.toFixed(0)},${s.z.toFixed(0)}) NOFLOOR terr=${terr === -Infinity ? 'n/a' : terr.toFixed(1)} tgap=${tgap.toFixed(1)}`);}
    } else {ok++;}
  }
  console.log(`${name}: ${spawns.length} spawns ok=${ok} buried=${buried} float=${float} headroom=${head}`);
  for (const b of bad) {console.log(`   ! ${b}`);}
}
