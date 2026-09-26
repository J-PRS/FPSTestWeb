/**
 * Shared target-ID allocator for every Targetable (balls, enemies, mines).
 * IDs live in the u16 demo target space — a single counter replaces the
 * per-class static offsets, which already collided (Seeker/Turretter both
 * at 50000, Mine/Roller both at 60000) and wrapped into the ball range.
 * Collisions can only occur after a full 64k wrap now — unreachable in
 * practice since live targets number in the tens.
 */
let counter = 1;
export function nextTargetId(): number {
  const id = counter;
  counter = (counter + 1) % 65536;
  if (counter === 0) counter = 1;
  return id;
}
