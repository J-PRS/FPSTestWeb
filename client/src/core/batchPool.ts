// Overflow-batch contract, shared by every batched FX pool (ribbon
// trails, ball dots, terrain rings, explosion sparks, shell instancing):
// acquire takes from any batch with room and spawns a sibling when all
// are full — peak demand IS the right size; retire removes an emptied
// overflow batch so capacity contracts back to batch[0] (the floor).
// Callers own the slot logic; this owns the list/bookkeeping only.
import type { Scene } from 'three';

export type BatchMap<T> = Map<Scene, T[]>;

/** First batch with room for this scene, else a fresh sibling appended. */
export function acquireBatch<T>(
  map: BatchMap<T>, scene: Scene, make: (scene: Scene) => T, hasRoom: (b: T) => boolean,
): T {
  let list = map.get(scene);
  if (!list) { list = []; map.set(scene, list); }
  for (const b of list) if (hasRoom(b)) return b;
  const b = make(scene);
  list.push(b);
  return b;
}

/** Drop `b` from the scene's list and dispose it when fully drained and
 *  not the floor batch. Safe no-op when the batch isn't registered. */
export function retireBatch<T>(
  map: BatchMap<T>, scene: Scene, b: T, isDrained: (b: T) => boolean, dispose: (b: T) => void,
): void {
  const list = map.get(scene);
  if (!list || list[0] === b || !isDrained(b)) return;
  const i = list.indexOf(b);
  if (i < 0) return;
  list.splice(i, 1);
  dispose(b);
}
