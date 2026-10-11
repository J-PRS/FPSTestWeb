/**
 * Shared target-ID allocator for every Targetable (balls, enemies, mines).
 * IDs live in the u16 demo target space — a single counter replaces the
 * per-class static offsets, which already collided (Seeker/Turretter both
 * at 50000, Mine/Roller both at 60000). The counter wraps at 0x4000: the
 * demo format's upper id space belongs to the deployable/creature/flag/
 * pickup lanes. Reuse needs a 16k-spawn gap — live targets number in the
 * tens, and the playback spawn path re-keys instead of orphaning on a hit.
 */
let counter = 1;
export function nextTargetId(): number {
  const id = counter;
  // Ball lane must stay below 0x4000 — the demo format reserves
  // 0x4000/0x8000/0xc000/0xe000 top bits for the deployable/creature/
  // flag/pickup namespaces, and demovalidate rejects ball ids that reach
  // them. Reuse is safe: live targets number in the tens.
  counter = (counter + 1) % 0x40_00;
  if (counter === 0) {counter = 1;}
  return id;
}
