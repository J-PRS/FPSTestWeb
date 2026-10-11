import { evictEldest } from './evictEldest.ts';

/** Sliding-window rate limiter, one implementation for every keyed
 *  throttle (join IP, log POST IP, ...). A key's window only resets
 *  when that key makes a fresh claim, so a flood of unique keys would
 *  grow the table forever — at `cap` we first drop expired windows
 *  (a burst must not reset throttle state still live for other keys),
 *  then evict oldest-first until bounded. Wholesale clear() here is
 *  the amnesty bug: it resets the window for every live key at once. */
export function windowAllow<K>(
  map: Map<K, { count: number; start: number }>,
  key: K, now: number,
  windowMs: number, limit: number, cap: number,
): boolean {
  let w = map.get(key);
  if (!w || now - w.start >= windowMs) {
    w = { count: 0, start: now };
    map.set(key, w);
    if (map.size > cap) {
      for (const [k, e] of map) {
        if (now - e.start >= windowMs) {map.delete(k);}
      }
      while (map.size > cap) {evictEldest(map);}
    }
  }
  return (w.count += 1) <= limit;
}
