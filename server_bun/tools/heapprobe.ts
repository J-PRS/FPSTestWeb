// Manual GC-pressure probe: step a busy room, force GC, report heap
// growth per tick. Not a test — run directly:
//   bun --expose-gc tests/heapprobe.ts [bots] [ticks]
import { mkRoom, step } from './scenarios/harness.ts';

const bots = Number(process.argv[2] ?? 20);
const ticks = Number(process.argv[3] ?? 600);
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
