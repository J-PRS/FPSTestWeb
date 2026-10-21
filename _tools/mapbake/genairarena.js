// genairarena.js — the Air Arena map: a terrainless, two-level arena frame
// floating in the sky.
//
//   bun _tools/mapbake/genairarena.js
//
// Writes maps/airarena.json. The heightfield is genmap.js --raw (a flat
// plain far below the decks) — see the header for the vertical contract.
//
// Layout, from the Tribes: Ascend reference the map is modelled on: a
// square frame of walkway panels, a second deck inset above it, and a
// catwalk bridge across the middle. Nothing is terrain — every surface
// is a structure, and the map's `killY` is what ends a fall.
//
// Built from the game's OWN structKit pieces — landing pads for the
// decking, towers and pillars for the piers, wall runs for the parapets,
// kata stands for the flag daises, gen houses for the generator rooms.
// Each piece carries its own hull, so the visual and the collision are
// the same thing (no separate collision boxes to drift).
//
// Vertical contract (metres):
//   y=0      the terrain plain (flat, ~2m of relief) — never seen
//   y=5      the kill zone (killY): the real floor. Falling off the decks is a long drop, not an instant death
//   y=110    the lower deck's walking surface
//   y=140    the upper deck's walking surface (30m of air between them)
// The upper deck is jetpack-only — the bridge is the way across.
import { writeFileSync } from 'node:fs';

const C = {
  killY: 5,
  lower: 110,     // lower deck walking surface
  upper: 140,     // upper deck walking surface
  cell: 12,       // a deck panel's footprint
  padScale: 12 / 9.45, // the landpad piece is 9.45m square
  padThick: 2.2,
  lowHalf: 4,     // the lower frame's half-width in CELLS (9x9 grid)
  lowVoid: 2,     // the void inside it (5x5 cells) - the frame is two cells wide
  upHalf: 2,      // the upper deck's half-width in CELLS (5x5 grid)
  upVoid: 1,      // its void (3x3 cells)
};

const structures = [];

/** A structKit piece — the server expands its hulls from the shared
 * table, so the visual and the collision are the same piece. */
const kit = (piece, x, y, z, rotY = 0, scale = 1) =>
  structures.push({ kind: 'kit', piece, pos: { x, y, z }, size: { x: 1, y: 1, z: 1 }, rotY, scale });

/** One deck panel — a landing pad, its hull scaled to the cell. */
const pad = (cx, cz, top) => kit('arenapanel', cx * C.cell, top - C.padThick, cz * C.cell, 0, 1);

/** The cells of a ring, in cell coordinates. */
function ring(half, voidHalf) {
  const cells = [];
  for (let i = -half; i <= half; i += 1) {
    for (let j = -half; j <= half; j += 1) {
      if (Math.abs(i) <= voidHalf && Math.abs(j) <= voidHalf) {continue;}
      cells.push([i, j]);
    }
  }
  return cells;
}

// ── the lower frame: a ring of deck panels around the void ─────────
for (const [i, j] of ring(C.lowHalf, C.lowVoid)) {pad(i, j, C.lower);}

// ── the upper deck: the same square, inset and lifted ──────────────
for (const [i, j] of ring(C.upHalf, C.upVoid)) {pad(i, j, C.upper);}

// ── the bridge: panels across the middle of the upper deck ─────────
for (const i of [-1, 0, 1]) {pad(i, 0, C.upper);}

// ── parapets: wall runs along the lower frame's inner edge ─────────
// A wall run is 20.4m long — two of them per side, meeting end to end.
const half = C.lowHalf * C.cell;
const inner = (C.lowHalf - 1) * C.cell + C.cell / 2;
for (const [x, z, rotY] of [
  [0, -inner, 0], [0, inner, 0], [-inner, 0, Math.PI / 2], [inner, 0, Math.PI / 2],
]) {
  for (const off of [-10.2, 10.2]) {
    const dx = off * Math.cos(rotY);
    const dz = -off * Math.sin(rotY);
    kit('wallrun', x + dx, C.lower, z + dz, rotY, 1);
  }
}

// ── the piers: what holds the whole thing up ────────────────────────
// Towers under the lower frame's corners, pillars under the mid-span.
for (const [x, z] of [
  [-half + 6, -half + 6], [half - 6, -half + 6],
  [half - 6, half - 6], [-half + 6, half - 6],
]) {
  kit('arenapier', x, 0, z, 0, (C.lower - 6) / 19.8);
}
for (const [x, z] of [[0, -inner], [0, inner], [-inner, 0], [inner, 0]]) {
  kit('arenapier', x, 0, z, 0, (C.lower - 2) / 19.8);
}
for (const [x, z] of [[-24, -24], [24, -24], [24, 24], [-24, 24]]) {
  kit('arenapier', x, 0, z, 0, (C.upper - 2) / 19.8);
}

// ── the bases: a kata stand (the flag dais) and a generator room ────
const baseX = C.lowHalf * C.cell - C.cell / 2;
kit('katastand', -baseX, C.lower - 3.2, 0, 0, 1);
kit('katastand', baseX, C.lower - 3.2, 0, 0, 1);
kit('genhouse', -baseX, C.lower - 1.8, 22, 0, 1);
kit('genhouse', baseX, C.lower - 1.8, -22, 0, 1);

const spec = {
  name: 'Air Arena',
  mode: 'ctf',
  hidden: false,
  bots: 6,
  botFill: 8,
  balls: { base: 6, perPlayer: 2, max: 16 },
  terrain: 'airarena.bin',
  // The kill zone — the void under the frame. The terrain plain sits far
  // below it, so the fall ends in air, not on dirt.
  killY: C.killY,
  // No water: the space under the arena is empty haze. The terrain plain
  // (a flat, near-featureless field far below) reads as a cloud deck
  // through the gaps, and the fog swallows the rest.
  terrainPreset: 3,
  fog: { color: [0.72, 0.8, 0.9], distance: 80, visible: 380, horizon: [0.78, 0.86, 0.94] },
  atmosphere: { timeOfDay: 0.42, rayleigh: 1.15, mie: 1.3, turbidity: 1.5, sunIntensity: 1.1 },
  bases: {
    alpha: { x: -baseX, y: C.lower, z: 0 },
    bravo: { x: baseX, y: C.lower, z: 0 },
  },
  deploys: [
    { kind: 'generator', pos: { x: -baseX, y: C.lower, z: 22 }, team: 'alpha' },
    { kind: 'generator', pos: { x: baseX, y: C.lower, z: -22 }, team: 'bravo' },
  ],
  teamSpawns: {
    alpha: [{ x: -baseX, y: C.lower + 2, z: -12, r: 3 }],
    bravo: [{ x: baseX, y: C.lower + 2, z: 12, r: 3 }],
  },
  spawns: [
    { x: -baseX, y: C.lower + 2, z: -12, r: 3 },
    { x: baseX, y: C.lower + 2, z: 12, r: 3 },
    { x: 0, y: C.lower + 2, z: -half + 12, r: 3 },
    { x: 0, y: C.lower + 2, z: half - 12, r: 3 },
    { x: -18, y: C.upper + 2, z: 0, r: 2 },
    { x: 18, y: C.upper + 2, z: 0, r: 2 },
    { x: 0, y: C.upper + 2, z: -18, r: 2 },
    { x: 0, y: C.upper + 2, z: 18, r: 2 },
  ],
  structures,
};

writeFileSync('maps/airarena.json', JSON.stringify(spec, null, 2) + '\n');
console.log(`maps/airarena.json — ${structures.length} kit pieces, killY ${C.killY}, decks at ${C.lower}/${C.upper}`);
