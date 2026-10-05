// Manual GC-pressure probe: step a busy room, force GC, report heap
// growth per tick. Not a test — run directly:
//   bun --expose-gc tools/heapprobe.ts [bots] [ticks] [rooms]
// With rooms>1 it also reports marginal retained cost per extra room.
import { mkRoom, step } from '../tests/scenarios/harness.ts';

const bots = Number(process.argv[2] ?? 20);
const ticks = Number(process.argv[3] ?? 600);
const roomN = Number(process.argv[4] ?? 1);
const room = mkRoom({ bots }, 'ctf');

// Warm pools so the measurement is steady-state churn, not first-fill.
step(room, 2000);
const windows = Math.max(1, Math.ceil(ticks / 1000));
let prev = (Bun.gc(true), process.memoryUsage().heapUsed);
for (let w = 0; w < windows; w++) {
  step(room, Math.min(1000, ticks - w * 1000));
  Bun.gc(true);
  const h = process.memoryUsage().heapUsed;
  console.log(`window ${w}: ${(prev / 1e6).toFixed(1)}MB -> ${(h / 1e6).toFixed(1)}MB  +${((h - prev) / 1024).toFixed(0)} KB`);
  prev = h;
}

// Churn rate (bytes allocated per tick, retained or not): no GC between
// h0/h1, so heapUsed delta counts everything the allocator handed out.
Bun.gc(true);
const c0 = process.memoryUsage().heapUsed;
step(room, 1000);
const c1 = process.memoryUsage().heapUsed;
console.log(`churn: ${((c1 - c0) / 1000 / 1024).toFixed(1)} KB/tick  (${((c1 - c0) / 1e6 * 20).toFixed(0)} KB/s at 20Hz)`);

// Marginal per-room retained cost: add rooms one at a time, warm each
// briefly so pools fill, then measure the delta.
if (roomN > 1) {
  for (let r = 1; r < roomN; r++) {
    Bun.gc(true);
    const before = process.memoryUsage().heapUsed;
    const extra = mkRoom({ bots }, 'ctf', 1337 + r);
    step(extra, 400);
    Bun.gc(true);
    const after = process.memoryUsage().heapUsed;
    console.log(`room +${r}: +${((after - before) / 1e6).toFixed(1)} MB retained (20 bots, 400 ticks warm)`);
  }
}
