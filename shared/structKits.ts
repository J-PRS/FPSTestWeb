// structKits.ts — collision hull tables for the structKit pieces in
// client/src/structures/. Pure data so BOTH ends can use it: the server
// expands `kind:'kit'` spec entries into yaw-OBBs, the client renders
// the real builder. pos = box CENTER in piece-local space (origin at
// ground). Keep in step with the builders — each piece's hull table is
// the contract between its authored spec and its rendered mesh.
import type { Vec3like } from './mapSpec.js';

export interface KitHull {
  pos: Vec3like; size: Vec3like; rotY?: number;
  /** Hemisphere radius — the entry is a dome cap, not a box. pos.y/size.y
   *  bound it (spring line at pos.y − size.y/2); size.x/z stay 2r so the
   *  bounding-box consumers (index, overlap lint) work unchanged. */
  dome?: number;
}

/** Fold sub-piece hulls into a parent frame — mirrors compound() in
 *  structKit.ts (same yaw math: x' = x·cos + z·sin, z' = −x·sin + z·cos). */
function fold(entries: readonly (readonly [KitHull[], number, number] | readonly [KitHull[], number, number, number])[]): KitHull[] {
  const out: KitHull[] = [];
  for (const [hulls, x, z, rotY = 0] of entries) {
    const c = Math.cos(rotY), s = Math.sin(rotY);
    for (const h of hulls) {
      out.push({
        pos: { x: h.pos.x * c + h.pos.z * s + x, y: h.pos.y, z: -h.pos.x * s + h.pos.z * c + z },
        size: h.size,
        rotY: rotY + (h.rotY ?? 0) || undefined,
        dome: h.dome,
      });
    }
  }
  return out;
}
const box = (x: number, y: number, z: number, w: number, h: number, d: number, rotY?: number): KitHull =>
  ({ pos: { x, y, z }, size: { x: w, y: h, z: d }, rotY });

/** Hemisphere-on-plinth — the cap is a REAL dome collider (segment
 *  sweep solves the sphere quadratic, bodies read the closed-form cap
 *  height), so no box approximation eats the air over the slope. The
 *  plinth stays boxy: an octagonal skirt pair is close enough there. */
const domeHulls = (r: number, b = 1.8): KitHull[] => [
  box(0, b / 2, 0, r * 1.94, b, r * 1.94),
  box(0, b / 2, 0, r * 1.94, b, r * 1.94, Math.PI / 4),
  { pos: { x: 0, y: b + r / 2, z: 0 }, size: { x: r * 2, y: r, z: r * 2 }, dome: r },
];

// — per-piece hulls, matching structures.ts builder defaults —
// Builder sidecar (structures.ts mkWallRun): pos.y = h/2, size.y = h+0.4
// — center sits lower so the skirt buries instead of floating collision
// 0.4m above the visual wall top.
const WALLRUN_18: KitHull[] = [box(0, 2.1, 0, 20.4, 4.6, 1.8)];
// Short runs for authored compounds — mkWallRun(8)/(6)/(7@2.2).
const WALLSTUB_8: KitHull[] = [box(0, 2.1, 0, 10.4, 4.6, 1.8)];
const CURTAIN_6: KitHull[] = [box(0, 2.1, 0, 8.4, 4.6, 1.8)];
const LOWWALL_7: KitHull[] = [box(0, 1.1, 0, 9.4, 2.6, 1.8)];
const ENDPOST_2: KitHull[] = [box(0, 2.3, 0, 2, 4.6, 2)];
const ENDPOST_3: KitHull[] = [box(0, 2.3, 0, 3, 4.6, 3)];
// Wall-stub hulls share the mkWallRun sidecar: pos.y = h/2.

// Tall gate face (~21m): stubs at ±7.15, mouth towers at ±3.9, full-
// height slot. Hoisted so bastion can fold the same hull set twice.
const GATEHOUSE: KitHull[] = [
  box(-7.15, 10.0, 0, 9.7, 20.4, 1.8),
  box(7.15, 10.0, 0, 9.7, 20.4, 1.8),
  box(-3.9, 10.8, 0, 3.4, 21.6, 3.4),
  box(3.9, 10.8, 0, 3.4, 21.6, 3.4),
];

// Power vault hulls (mkGenHouse 16×14, h=7, rear door −Z). Hoisted so
// the bastion fold can reuse the same set.
const GENHOUSE: KitHull[] = [
  // Walls and deck carry a ~22m foundation below the base plane: the
  // vault seats on the footprint MAX (deck must clear dirt), so the
  // downhill face needs buried skirt to stand on, not air.
  ...fold([
    [[box(0, -7.5, 0, 18.4, 29.4, 1.8)], 0, 7],
    [[box(0, -7.5, 0, 16.4, 29.4, 1.8)], -8, 0, Math.PI / 2],
    [[box(0, -7.5, 0, 16.4, 29.4, 1.8)], 8, 0, Math.PI / 2],
    [[box(0, -7.5, 0, 5.5, 29.4, 1.8)], -5.25, -7],
    [[box(0, -7.5, 0, 5.5, 29.4, 1.8)], 5.25, -7],
    [[box(0, -7.3, 0, 2, 29.4, 2)], -3, -7],
    [[box(0, -7.3, 0, 2, 29.4, 2)], 3, -7],
  ]),
  box(0, -10.5, 0, 14.8, 23.0, 12.8), // deck → foundation fill
  box(0, 7.5, 0, 16, 1.0, 14),        // roof
  box(0, 13.0, 0, 2.2, 6.4, 2.2),     // comms mast on the vent crown
  box(0, 9.0, 0, 4.4, 1.6, 3.2),      // vent stack
];

// Bunker hulls (mkBunker 12×10, door +Z) — hoisted for the bastion fold.
const BUNKER: KitHull[] = [
  ...fold([
    [[box(0, 2.1, 0, 14.4, 4.6, 1.8)], 0, -5],
    [[box(0, 2.1, 0, 12.4, 4.6, 1.8)], -6, 0, Math.PI / 2],
    [[box(0, 2.1, 0, 12.4, 4.6, 1.8)], 6, 0, Math.PI / 2],
    [[box(0, 2.1, 0, 3.75, 4.6, 1.8)], -4.125, 5],
    [[box(0, 2.1, 0, 3.75, 4.6, 1.8)], 4.125, 5],
    [ENDPOST_2, -2.75, 5],
    [ENDPOST_2, 2.75, 5],
  ]),
  box(0, 4.6, 0, 12, 0.8, 10), // roof
];

export const KIT_HULLS: Record<string, KitHull[]> = {
  // Base pieces
  katastand: [box(0, 1.6, 0, 6.4, 3.2, 6.4)],
  tower:     [box(0, 6, 0, 9, 12, 9)],
  wallrun:   WALLRUN_18,
  wallstub:  WALLSTUB_8,
  curtain:   CURTAIN_6,
  lowwall:   LOWWALL_7,
  gendome:   domeHulls(5),
  landpad:   [box(0, 0.9, 0, 9.45, 1.8, 9.45)],
  commast:   [box(0, 5.7, 0, 2.2, 11.4, 2.2)],
  ramp:      [box(0, 1.25, 6, 5, 2.5, 12)],
  wallgate:  fold([
    [[box(0, 2.1, 0, 6, 4.6, 1.8)], -6, 0],
    [[box(0, 2.1, 0, 6, 4.6, 1.8)], 6, 0],
    [ENDPOST_3, -3, 0],
    [ENDPOST_3, 3, 0],
  ]),
  // Enterables — wall hulls stay separate so interiors are hollow.
  bunker: BUNKER,
  flagtower: [
    ...fold([
      [[box(0, 2.2, 0, 10.4, 4.8, 1.8)], 0, -4],
      [[box(0, 2.2, 0, 10.4, 4.8, 1.8)], -4, 0, Math.PI / 2],
      [[box(0, 2.2, 0, 10.4, 4.8, 1.8)], 4, 0, Math.PI / 2],
      [[box(0, 2.2, 0, 2.5, 4.8, 1.8)], -2.75, 4],
      [[box(0, 2.2, 0, 2.5, 4.8, 1.8)], 2.75, 4],
      [[box(0, 2.4, 0, 2, 4.8, 2)], -1.9, 4],
      [[box(0, 2.4, 0, 2, 4.8, 2)], 1.9, 4],
    ]),
    box(0, 4.75, 0, 10.9, 0.7, 10.9), // ledge
    box(0, 7.45, 0, 5.76, 6.1, 5.76), // shaft
  ],
  // Power vault — mirrors mkGenHouse (16×14, h=7, rear door on −Z).
  // Deck + roof hulls ride with the folded walls so the interior floor
  // is structure, not terrain.
  genhouse: GENHOUSE,
  // Midfield scatter
  pillar:  [box(0, 5.3, 0, 3, 10.6, 3)],
  obelisk: [box(0, 7.1, 0, 3.36, 14.2, 3.36)],
  shard:   [box(1, 4.6, 0, 4.08, 9.2, 4.08)], // w=3.4 × 1.2 visual pad
  // mkArch feet are leaning slabs (w=2.6, h=7.4), not end posts.
  arch:    [box(-4.5, 3.7, 0, 2.6, 7.4, 2.6), box(4.5, 3.7, 0, 2.6, 7.4, 2.6),
            box(0, 7.85, 0, 11.6, 1.1, 1.4)],
  // Tall gate face (~21m — a jet hop over it is a real climb): stubs at
  // ±7.15, mouth towers at ±3.9. The slot between them is FULL height —
  // a 'shield' spec seats the whole opening, so a dead generator leaves
  // a real breach instead of a doggy door.
  gatehouse: GATEHOUSE,
  // The whole compound — mirrors mkBastion's layout table.
  bastion: fold([
    // genhouse straddles the rear wall — half out, door face in midfield.
    [GENHOUSE, 0, -23],
    // West column tower+dome, east column bunker+pad, comms on the axis.
    [[box(0, 7, 0, 10, 14, 10)], -13, -9],
    [BUNKER, 13, -9, -Math.PI / 2],
    [domeHulls(4.6), -13, 9],
    [[box(0, 0.9, 0, 8.82, 1.8, 8.82)], 13, 9],
    [[box(0, 5.7, 0, 2.2, 11.4, 2.2)], 0, -14],
    // Front: gatehouse + curtains ending at the corner towers.
    [GATEHOUSE, 0, 18],
    [[box(0, 2.1, 0, 9.4, 4.6, 1.8)], -15.5, 18],
    [[box(0, 2.1, 0, 9.4, 4.6, 1.8)], 15.5, 18],
    // Side faces: gatehouse each + curtains fore and aft.
    [GATEHOUSE, -20, -1, -Math.PI / 2],
    [GATEHOUSE, 20, -1, Math.PI / 2],
    [[box(0, 2.1, 0, 8.4, 4.6, 1.8)], -20, -16.5, -Math.PI / 2],
    [[box(0, 2.1, 0, 8.4, 4.6, 1.8)], -20, 14.5, -Math.PI / 2],
    [[box(0, 2.1, 0, 8.4, 4.6, 1.8)], 20, -16.5, Math.PI / 2],
    [[box(0, 2.1, 0, 8.4, 4.6, 1.8)], 20, 14.5, Math.PI / 2],
    // Rear stubs flank the vault door gap and run to the side curtains.
    [[box(0, 2.1, 0, 14.4, 4.6, 1.8)], -14, -23],
    [[box(0, 2.1, 0, 14.4, 4.6, 1.8)], 14, -23],
    // Corner towers — endPost(5, 4.5): every curtain/wall end is
    // swallowed by the post, nothing pokes through the joint.
    [[box(0, 2.7, 0, 4.5, 5.4, 4.5)], -20, 18],
    [[box(0, 2.7, 0, 4.5, 5.4, 4.5)], 20, 18],
    [[box(0, 2.7, 0, 4.5, 5.4, 4.5)], -20, -21.75],
    [[box(0, 2.7, 0, 4.5, 5.4, 4.5)], 20, -21.75],
  ]),
};

export const KIT_PIECES = Object.keys(KIT_HULLS);

/** Pieces that may carry a flag home — local Y of the STANDING surface
 *  (× spec scale). katastand's slab tops at 3.2; flagtower's flag perch
 *  is the mid ledge (4.75 + half its 0.7 thickness), not the shaft top.
 *  flagStandTop snaps bases onto these; every other kit is ignored. */
export const KIT_STAND_TOP: Record<string, number> = {
  katastand: 3.2,
  flagtower: 5.1,
};

/** Spec y is advisory for kit pieces — same rule flag homes already
 *  live by: seat the base plane on the actual heightfield so authored
 *  maps can't float or bury. The wire echoes the spec objects, so
 *  mutating in place carries the seated height to clients for free.
 *
 *  Seating reads the LOWEST sample across the footprint, not the center:
 *  a piece straddling a dune edge with center-height seating hangs its
 *  ends in the air (walls, gatehouses — wide and exactly the wrong
 *  pieces to float). Burying the uphill side is the designed look —
 *  every kit's skirt expects a metre or two of dirt. */
export function seatKits(
  list: readonly { kind: string; pos: Vec3like; size?: Vec3like; piece?: string; rotY?: number; scale?: number }[] | undefined,
  getHeight: (x: number, z: number) => number | undefined,
): void {
  if (!list) return;
  for (const s of list) {
    // 'shield' panes seat their BASE on the field too — a pane authored
    // a metre off the ground either floats (enemies ski under a "gate")
    // or buries (an opaque seam eats the bottom of the arch).
    if (s.kind !== 'kit' && s.kind !== 'shield') continue;
    // Footprint reach in world XZ: farthest hull corner (kits — rotY of
    // the spec itself moves with the piece, so sample its yaw) or the
    // pane's own half-extents.
    const k = s.scale ?? 1;
    let reach = 0;
    if (s.kind === 'kit') {
      for (const h of KIT_HULLS[s.piece ?? ''] ?? []) {
        reach = Math.max(reach,
          (Math.abs(h.pos.x) + h.size.x / 2) * k,
          (Math.abs(h.pos.z) + h.size.z / 2) * k);
      }
      if (reach === 0) continue; // unknown piece — nothing to seat
    } else {
      reach = Math.max(s.size?.x ?? 0, s.size?.z ?? 0) / 2;
    }
    const cos = Math.cos(s.rotY ?? 0), sin = Math.sin(s.rotY ?? 0);
    // Enterables with their own deck (genhouse's slab tops at +1m) seat
    // HIGH instead: base on the max sample so the floor clears terrain
    // everywhere inside — walking into a building onto dirt is the bug.
    const floored = s.piece === 'genhouse';
    let min = Infinity, max = -Infinity;
    // Center + the four footprint extremes. Five probes per piece is
    // enough — terrain is a smooth heightfield, a knife-edge between
    // corners can't exceed the corner samples by much.
    for (const [ox, oz] of [[0, 0], [reach, 0], [-reach, 0], [0, reach], [0, -reach]] as const) {
      const h = getHeight(s.pos.x + ox * cos + oz * sin,
                          s.pos.z - ox * sin + oz * cos);
      if (h === undefined) continue;
      if (h < min) min = h;
      if (h > max) max = h;
    }
    if (min !== Infinity) s.pos.y = floored ? max : min;
  }
}
