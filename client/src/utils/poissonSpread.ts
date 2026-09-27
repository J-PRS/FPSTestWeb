// Poisson-disc sampling on the unit disc — even weapon-spread coverage
// without the clumping uniform random cones produce (the "flak cannon
// looks streaky" problem). Points are sampled once per count and cached;
// callers rotate by a random angle per shot so the pattern isn't static.

const cache = new Map<number, { x: number; y: number }[]>();

// Bridson-lite: dart-throwing with a min-distance bound derived from n.
// n is small (<=32) so rejection sampling converges instantly.
export function poissonDisc(n: number): { x: number; y: number }[] {
  const hit = cache.get(n);
  if (hit) return hit;

  // Min separation for ~n points in a unit disc (area heuristic, relaxed
  // a bit so sampling terminates quickly for small n)
  const minDist = Math.sqrt(Math.PI / (n * 1.9));
  const pts: { x: number; y: number }[] = [];
  const cell = minDist / Math.SQRT2;
  const gridSize = Math.ceil(2 / cell) + 1;
  const grid = new Int32Array(gridSize * gridSize).fill(-1);
  const cellOf = (x: number, y: number) =>
    Math.min(gridSize - 1, Math.floor((x + 1) / cell)) +
    Math.min(gridSize - 1, Math.floor((y + 1) / cell)) * gridSize;

  let attempts = 0;
  const maxAttempts = n * 400;
  while (pts.length < n && attempts < maxAttempts) {
    attempts++;
    const x = Math.random() * 2 - 1;
    const y = Math.random() * 2 - 1;
    if (x * x + y * y > 1) continue;
    const c = cellOf(x, y);
    const cx = c % gridSize, cy = Math.floor(c / gridSize);
    let ok = true;
    for (let gy = Math.max(0, cy - 2); ok && gy <= Math.min(gridSize - 1, cy + 2); gy++) {
      for (let gx = Math.max(0, cx - 2); gx <= Math.min(gridSize - 1, cx + 2); gx++) {
        const pi = grid[gy * gridSize + gx]!;
        if (pi < 0) continue;
        const dx = pts[pi]!.x - x, dy = pts[pi]!.y - y;
        if (dx * dx + dy * dy < minDist * minDist) { ok = false; break; }
      }
    }
    if (!ok) continue;
    grid[c] = pts.length;
    pts.push({ x, y });
  }

  // Fallback: top up with a Vogel spiral if rejection sampling starved
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = pts.length; i < n; i++) {
    const r = Math.sqrt((i + 0.5) / n);
    const a = i * golden;
    pts.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
  }

  cache.set(n, pts);
  return pts;
}
