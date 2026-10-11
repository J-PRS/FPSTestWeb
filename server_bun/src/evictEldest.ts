// One implementation of "cap a Map/Set at N, evict the eldest" —
// insertion-ordered containers make the oldest entry keys().next().
// A wholesale clear() under id churn is an amnesty: it resets the
// cooldown/window for every live entry at once (join floods, warn
// dedupes, grudge maps all take the burst exactly when they're hottest).
export function evictEldest<K, V>(c: Map<K, V> | Set<K>): void {
  const eldest = c.keys().next().value;
  if (eldest !== undefined) {c.delete(eldest as K);}
}
