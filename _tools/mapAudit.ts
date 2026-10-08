// mapAudit — structure placement health for a map spec.
//   bun _tools/mapAudit.ts bastion
//   bun _tools/mapAudit.ts bastion --scan genhouse 4 --near -500,-4 --range 60
//     scans a grid for the flattest seat (min terrain spread) of that
//     piece's footprint near a point — where to move a floating build.
// Shares its numbers with mapsValid.test.ts's float gate: same hulls,
// same seatKits, same "air under ground-contact hull" measure.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveMapSpec, type StructureSpec } from '../shared/mapSpec.ts';
import { KIT_HULLS, seatKits } from '../shared/structKits.ts';
import { hmParseBin, hmHeight, type Heightfield } from '../shared/heightfield.ts';
import { findStructureOverlaps } from '../shared/ballCollide.ts';

const MAPS = join(import.meta.dir, '..', 'maps');
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const mapName = process.argv[2]?.replace(/\.json$/, '') ?? 'bastion';
const spec = resolveMapSpec(JSON.parse(readFileSync(join(MAPS, `${mapName}.json`), 'utf8')));
if (!spec.structures?.length) { console.log('no structures'); process.exit(0); }

let field: Heightfield | null = null;
if (spec.terrain && existsSync(join(MAPS, spec.terrain))) {
  field = hmParseBin(new Uint8Array(readFileSync(join(MAPS, spec.terrain))), spec.heightScale ?? 1);
}
const getH = (x: number, z: number) => (field ? hmHeight(field, x, z) : 0);

/** Farthest hull reach in XZ (what seatKits samples). */
const reach = (piece: string, k: number) => {
  let r = 0;
  for (const h of KIT_HULLS[piece] ?? []) {
    r = Math.max(r, (Math.abs(h.pos.x) + h.size.x / 2) * k, (Math.abs(h.pos.z) + h.size.z / 2) * k);
  }
  return r;
};

/** Terrain spread (max-min) over a 9-probe footprint grid. */
function spread(field: Heightfield, x: number, z: number, r: number, rotY = 0): { mn: number; mx: number; v: number } {
  const c = Math.cos(rotY), s = Math.sin(rotY);
  let mn = Infinity, mx = -Infinity;
  for (const [ox, oz] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]] as const) {
    const h = hmHeight(field, x + ox * c + oz * s, z - ox * s + oz * c);
    if (h < mn) mn = h;
    if (h > mx) mx = h;
  }
  return { mn, mx, v: mx - mn };
}

// --scan mode: flattest seat for a piece near a point
const scanPiece = arg('scan');
if (scanPiece) {
  if (!field) { console.error('map has no terrain'); process.exit(1); }
  const k = Number(arg('scale') ?? '1');
  const [nx, nz] = (arg('near') ?? '0,0').split(',').map(Number);
  const range = Number(arg('range') ?? '60');
  const r = reach(scanPiece, k);
  if (!r) { console.error(`unknown piece ${scanPiece}`); process.exit(1); }
  const hits: { x: number; z: number; v: number; mn: number; mx: number }[] = [];
  for (let dx = -range; dx <= range; dx += 4) {
    for (let dz = -range; dz <= range; dz += 4) {
      const x = nx! + dx, z = nz! + dz;
      const { mn, mx, v } = spread(field, x, z, r);
      hits.push({ x, z, v, mn, mx });
    }
  }
  hits.sort((a, b) => a.v - b.v);
  for (const h of hits.slice(0, 10)) {
    console.log(`${h.x.toFixed(0)},${h.z.toFixed(0)}  spread=${h.v.toFixed(1)}m  seat~${h.mx.toFixed(1)}`);
  }
  process.exit(0);
}

// default: per-piece audit
const structs = spec.structures.map(s => ({ ...s, pos: { ...s.pos } }));
seatKits(structs, getH);
for (const s of structs) {
  if (s.kind !== 'kit') continue;
  const hulls = KIT_HULLS[s.piece ?? ''];
  if (!hulls) { console.log(`${s.piece}@(${s.pos.x},${s.pos.z})  UNKNOWN PIECE`); continue; }
  const k = s.scale ?? 1;
  const cos = Math.cos(s.rotY ?? 0), sin = Math.sin(s.rotY ?? 0);
  let worst = 0, wx = 0, wz = 0;
  for (const h of hulls) {
    const b = h.pos.y - h.size.y / 2;
    if (b > 0.6) continue;
    const lx = h.pos.x * k, lz = h.pos.z * k;
    const hx = s.pos.x + lx * cos + lz * sin, hz = s.pos.z - lx * sin + lz * cos;
    const gap = s.pos.y + b * k - getH(hx, hz);
    if (gap > worst) { worst = gap; wx = hx; wz = hz; }
  }
  const flag = worst > 3 ? '  FLOAT' : worst > 1.5 ? '  ~air' : '';
  console.log(`${s.piece.padEnd(10)} (${s.pos.x.toFixed(0)},${s.pos.z.toFixed(0)}) k=${k} seat=${s.pos.y.toFixed(1)} air=${worst.toFixed(1)}m @(${wx.toFixed(0)},${wz.toFixed(0)})${flag}`);
}
for (const o of findStructureOverlaps(spec.structures)) {
  const a = spec.structures[o.a]!, b = spec.structures[o.b]!;
  if (a.kind === 'kit' && b.kind === 'kit') {
    console.log(`OVERLAP ${a.piece}@(${a.pos.x},${a.pos.z}) × ${b.piece}@(${b.pos.x},${b.pos.z}) ${o.x.toFixed(1)}x${o.y.toFixed(1)}x${o.z.toFixed(1)}`);
  }
}
void (0 as unknown as StructureSpec); // types import kept honest
