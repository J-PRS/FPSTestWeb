// structKits.ts — collision hull tables for the structKit pieces in
// client/src/structures/. Pure data so BOTH ends can use it: the server
// expands `kind:'kit'` spec entries into yaw-OBBs, the client renders
// the real builder. pos = box CENTER in piece-local space (origin at
// ground). Keep in step with the builders — same contract as
// flagStandSpecs vs mkFlagStand.
import type { Vec3like } from './mapSpec.js';

export interface KitHull { pos: Vec3like; size: Vec3like; rotY?: number }

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
      });
    }
  }
  return out;
}
const box = (x: number, y: number, z: number, w: number, h: number, d: number, rotY?: number): KitHull =>
  ({ pos: { x, y, z }, size: { x: w, y: h, z: d }, rotY });

// — per-piece hulls, matching structures.ts builder defaults —
// Builder sidecar (structures.ts mkWallRun): pos.y = h/2, size.y = h+0.4
// — center sits lower so the skirt buries instead of floating collision
// 0.4m above the visual wall top.
const WALLRUN_15: KitHull[] = [box(0, 2.1, 0, 17.4, 4.6, 1.8)];
const WALLRUN_30: KitHull[] = [box(0, 2.1, 0, 32.4, 4.6, 1.8)];
const WALLRUN_18: KitHull[] = [box(0, 2.1, 0, 20.4, 4.6, 1.8)];
const ENDPOST_2: KitHull[] = [box(0, 2.3, 0, 2, 4.6, 2)];
const ENDPOST_3: KitHull[] = [box(0, 2.3, 0, 3, 4.6, 3)];
// Wall-stub hulls share the mkWallRun sidecar: pos.y = h/2.

export const KIT_HULLS: Record<string, KitHull[]> = {
  // Base pieces
  katastand: [box(0, 1.6, 0, 6.4, 3.2, 6.4)],
  tower:     [box(0, 6, 0, 9, 12, 9)],
  wallrun:   WALLRUN_18,
  gendome:   [box(0, 3.4, 0, 10, 6.8, 10)],
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
  bunker: [
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
  ],
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
  // Midfield scatter
  pillar:  [box(0, 5.3, 0, 3, 10.6, 3)],
  obelisk: [box(0, 7.1, 0, 3.36, 14.2, 3.36)],
  shard:   [box(1, 4.6, 0, 4.08, 9.2, 4.08)], // w=3.4 × 1.2 visual pad
  // mkArch feet are leaning slabs (w=2.6, h=7.4), not end posts.
  arch:    [box(-4.5, 3.7, 0, 2.6, 7.4, 2.6), box(4.5, 3.7, 0, 2.6, 7.4, 2.6),
            box(0, 7.85, 0, 11.6, 1.1, 1.4)],
  // The whole compound — mirrors mkBastion's layout table.
  bastion: fold([
    [[box(0, 7, 0, 10, 14, 10)],        0, -9],
    [[box(0, 3.2, 0, 9.2, 6.4, 9.2)], -13, 1],
    [[box(0, 0.9, 0, 8.82, 1.8, 8.82)], 11, 8],
    [[box(0, 5.7, 0, 2.2, 11.4, 2.2)], 15, -11],
    [WALLRUN_15, -13, 13, -0.26],
    [WALLRUN_15, 13, 13, 0.26],
    [WALLRUN_30, 0, -18],
  ]),
};

export const KIT_PIECES = Object.keys(KIT_HULLS);

/** Spec y is advisory for kit pieces — same rule flag homes already
 *  live by: seat the base plane on the actual heightfield so authored
 *  maps can't float or bury. The wire echoes the spec objects, so
 *  mutating in place carries the seated height to clients for free.
 *  Skirts are designed to bury ~1–2m, so center-seating is correct. */
export function seatKits(list: readonly { kind: string; pos: Vec3like }[] | undefined,
                         getHeight: (x: number, z: number) => number | undefined): void {
  if (!list) return;
  for (const s of list) {
    if (s.kind !== 'kit') continue;
    const h = getHeight(s.pos.x, s.pos.z);
    if (h !== undefined) s.pos.y = h;
  }
}
