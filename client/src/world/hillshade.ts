// hillshade — the relief image hillshade.cjs emits for shipped maps, shared
// by maplab (slope/drain overlays) and the lobby's live map thumb (plain).
import { hmHeight, hmNormal, type Heightfield } from '../../../shared/heightfield.js';

export interface HillshadeOpts {
  /** World span the field covers (meters) — maplab's fixed WS, or
   *  field.worldScale for a spec's own tile span. */
  ws: number;
  /** Normalization denominator for the height band (expected max world
   *  height — HM_HEIGHT_SCALE·heightScale for shipped maps, ·vscale for
   *  maplab synths). */
  vmax: number;
  /** Red overlay where the face is too steep to ski (slope > ~0.8). */
  steep?: boolean;
  /** D8 drainage accumulation — convergent flow draws as cyan threads. */
  drain?: { acc: ArrayLike<number> & Iterable<number> };
}

const L = { x: -0.6, y: 0.75, z: -0.35 };
const _n = { x: 0, y: 0, z: 0 };

export function hillshadeImage(field: Heightfield, o: HillshadeOpts): ImageData {
  const N = field.size;
  const img = new ImageData(N, N);
  // Normalize the flow tint against the trunk channel, not the cell count
  // — acc/(N²) keeps even the biggest river at a few percent of range.
  let accMax = 1;
  if (o.drain) { for (const a of o.drain.acc) { if (a > accMax) { accMax = a; } } }
  for (let z = 0; z < N; z += 1) {
    for (let x = 0; x < N; x += 1) {
      const wx = (x / N - 0.5) * o.ws, wz = (z / N - 0.5) * o.ws;
      const h = hmHeight(field, wx, wz);
      hmNormal(field, wx, wz, _n);
      const shade = Math.max(0, _n.x * L.x + _n.y * L.y + _n.z * L.z);
      const v = Math.min(255, (h / o.vmax) * 140 + shade * 120);
      const i = (z * N + x) * 4;
      const steep = 1 - _n.y > 0.32 && (o.steep ?? false);
      const flow = o.drain ? (o.drain.acc[z * N + x]! / accMax) ** 0.35 : 0;
      img.data[i] = steep ? 200 : v * (1 - flow) + 30 * flow;
      img.data[i + 1] = steep ? 60 : v * (1 - flow * 0.6) + 120 * flow;
      img.data[i + 2] = steep ? 60 : v * 0.9 * (1 - flow * 0.4) + 140 * flow;
      img.data[i + 3] = 255;
    }
  }
  return img;
}
