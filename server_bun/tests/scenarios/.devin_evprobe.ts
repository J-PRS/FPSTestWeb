import { runBridge } from '../net/bridge.ts';
import type { Heightfield } from '../../../shared/heightfield.ts';

const field: Heightfield = (() => {
  const N = 32; const data = new Uint8Array(N * N);
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) data[z * N + x] = Math.round(128 + 40 * Math.sin(x / 3) * Math.cos(z / 4));
  return { size: 4, data, stride: N };
})();
const r = runBridge(field, {
  up: { latencyMs: 80, jitterMs: 30, lossP: 0.1, reorderP: 0.2 },
  down: { latencyMs: 60, jitterMs: 25, dupP: 0.1 },
  dropEveryMs: 4000, outageMs: 1200,
}, (t) => ({ input: { forward: 1, right: 1, jump: 0, ski: 1, jet: 0 }, yaw: t / 4000 }), 30);
const evs = [...r.durableEvs].sort((a, b) => a - b);
let gaps = 0;
for (let i = 1; i < evs.length; i++) if (evs[i]! !== evs[i - 1]! + 1 && gaps++ < 20) console.log(`gap ${evs[i - 1]} -> ${evs[i]} (${evs[i]! - evs[i - 1]! - 1} missing)`);
console.log(`drops=${r.drops} total evs=${evs.length} gaps=${gaps}`);
for (const rp of r.replays) console.log(`reclaim from=${rp.fromSeq} -> replayed evs [${rp.seqs.join(',')}]`);
