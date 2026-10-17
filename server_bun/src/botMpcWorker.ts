/**
 * botMpcWorker — runs the MoveSim beam search off the room tick thread.
 * Init carries the field + structure specs once (surfaces rebuild here);
 * jobs carry a snapshot + search params and return the plan. A deep
 * run-in solve (~1-3s) no longer sits inside a 50ms tick.
 */
import { FieldSurface } from '../../shared/fieldSurface.ts';
import { SolidWorld } from '../../shared/solidWorld.ts';
import { structureColliders } from '../../shared/ballCollide.ts';
import type { Heightfield } from '../../shared/heightfield.ts';
import type { StructureSpec } from '../../shared/mapSpec.ts';
import { runSearch, type MpcJob } from './botMpcSearch.ts';

let surface: FieldSurface | null = null;
let field: Heightfield | null = null;

declare const self: unknown;
const w = self as { postMessage(m: unknown): void; onmessage: ((e: MessageEvent) => void) | null };
w.onmessage = (e: MessageEvent): void => {
  const m = e.data;
  if (m.kind === 'init') {
    field = m.field as Heightfield;
    // Bot shadows ride the chord surface (the rendered mesh) — the plan
    // must predict the same ground the shadow stands on.
    surface = FieldSurface.fromFieldChord(field);
    surface.solid = m.solidSpecs?.length
      ? new SolidWorld(structureColliders(m.solidSpecs as StructureSpec[]))
      : null;
    return;
  }
  if (m.kind === 'job' && surface && field) {
    const t0 = performance.now();
    const plan = runSearch(surface, field, m.job as MpcJob);
    w.postMessage({ kind: 'plan', seq: m.seq, plan, ms: performance.now() - t0 });
  }
};
