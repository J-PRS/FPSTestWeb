/* oxlint-disable -- scratch soak harness: console is the report channel. */
/**
 * _classicSoak — headless soak of the OFFLINE classic ("BALLS") ball sim.
 * Drives shared/ballSim.ts's stepBall directly — the same call Ball's
 * local path makes — with BALL_ENRAGE_ENABLED=false (the ?mode=classic
 * callsite) on SimBalls over a baked heightfield.
 *
 *   bun _classicSoak.ts [simHours] [ballCount]
 *
 * Asserts (any = grave error, per soak law):
 *   - every pos/vel stays finite
 *   - a ball never rests below the surface
 *   - a docile ball never exceeds BALL_MAX_DIST for >~8s of flight
 *     (teleport fires on the first ground contact past the line)
 */
/* oxlint-disable no-console — a soak's entire report IS stdout */

// ---- browser stubs (config/Logger/settings import chain) ----
const memStore = (): { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void; removeItem: (k: string) => void; clear: () => void; key: () => null; length: number } => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => m.get(k) ?? null,
    setItem: (k: string, v: string): void => { m.set(k, String(v)); },
    removeItem: (k: string): void => { m.delete(k); },
    clear: (): void => m.clear(),
    key: (): null => null,
    length: 0,
  };
};
(globalThis as Record<string, unknown>).localStorage = memStore();
(globalThis as Record<string, unknown>).sessionStorage = memStore();
// Logger.installErrorHooks calls window.addEventListener unconditionally,
// and its console tap swallows console.log into the Alt+Q buffer — stub
// the DOM, then restore the real console after the import chain settles.
const realConsole = { log: console.log, warn: console.warn, error: console.error, info: console.info };
(globalThis as Record<string, unknown>).window = {
  location: { search: '', hostname: 'localhost', protocol: 'http:' },
  addEventListener: (): void => {}, dispatchEvent: (): boolean => true,
};
(globalThis as Record<string, unknown>).document = {
  createElement: (): Record<string, unknown> => ({ style: {}, append: (): void => {}, remove: (): void => {} }),
  body: { append: (): void => {} }, addEventListener: (): void => {}, visibilityState: 'visible',
};

const THREE = await import('three');
const cfg = await import('./src/core/config.js');
const sim = await import('../shared/ballSim.js');
const hm = await import('../shared/heightfield.js');
Object.assign(console, realConsole);

cfg.setBallEnrage(false); // the classic-mode callsite — ballSim reads it

const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv ?? [];
const SIM_HOURS = Number.parseFloat(argv[2] ?? '4');
const N_BALLS = Number.parseInt(argv[3] ?? '30', 10);
const DT = 1 / 60;

// ---- fake terrain: rolling dunes, baked to a shared/heightfield ----
// The sim samples bytes, not functions: bake the analytic field into a
// wrapped heightmap (worldScale 4000 covers the roam+leash domain; the
// modulus wrap tiles it harmlessly past that).
const h = (x: number, z: number): number =>
  24 * Math.sin(x * 0.008) * Math.cos(z * 0.011) + 10 * Math.sin(x * 0.031 + z * 0.017) + 3 * Math.sin(x * 0.13) * Math.sin(z * 0.11);
const HM_N = 1024, HM_WS = 4000;
const hmData = new Uint8Array(HM_N * HM_N);
for (let z = 0; z < HM_N; z += 1) {
  for (let x = 0; x < HM_N; x += 1) {
    const wx = (x + 0.5) / HM_N * HM_WS, wz = (z + 0.5) / HM_N * HM_WS;
    hmData[z * HM_N + x] = Math.max(0, Math.min(255, Math.round(h(wx, wz) / 125 * 255)));
  }
}
const field = { size: HM_N, data: hmData, stride: 1, worldScale: HM_WS };

// ---- SimBall stand-ins — same object Ball's local path steps ----
const mkBall = (i: number, near: { x: number; z: number }): sim.SimBall => {
  const a = Math.random() * Math.PI * 2, d = 100 + Math.random() * 300;
  const x = near.x + Math.cos(a) * d, z = near.z + Math.sin(a) * d;
  const tri = (): number => (Math.random() + Math.random() - 1) * 32;
  return sim.makeSimBall(i, 0, i % 7,
    { x, y: h(x, z) + 1.2 + 5, z },
    { x: tri(), y: 32 + Math.random() * 32, z: tri() });
};

// ---- roaming player: wander at ski speed, direction drifts ----
const player = { pos: new THREE.Vector3(0, 0, 0), hdg: 0 };
const stepPlayer = (dt: number): void => {
  player.hdg += (Math.random() - 0.5) * 2.2 * dt;
  const sp = 28;
  player.pos.x += Math.cos(player.hdg) * sp * dt;
  player.pos.z += Math.sin(player.hdg) * sp * dt;
  player.pos.y = h(player.pos.x, player.pos.z) + 1.2;
};

// ---- soak ----
// Hop census: apex-above-terrain + horizontal travel per bounce-to-bounce
// arc — the "are these midair-able" metric.
const hopApex: number[] = [];
const hopDist: number[] = [];
const firstApex: number[] = []; // each ball's FIRST hop — isolates the spawn toss
const apex = new Array<number>(N_BALLS).fill(0);
const hopped = new Array<boolean>(N_BALLS).fill(false);
// Flat-spell census: seconds since the last hop that cleared 5m apex —
// a skimming ball keeps moving fast but never gains height.
const flatSince = new Array<number>(N_BALLS).fill(0);
const flatRuns: number[] = []; // completed flat spells (s)
const lastBounce = Array.from({ length: N_BALLS }, (): InstanceType<typeof THREE.Vector3> => new THREE.Vector3());
const balls = Array.from({ length: N_BALLS }, (_, i): sim.SimBall => {
  const b = mkBall(i, player.pos);
  lastBounce[i]?.copy(new THREE.Vector3(b.x, b.y, b.z));
  return b;
});
const onBounce = (i: number, b: sim.SimBall): void => {
  if (hopped[i] === false) { firstApex.push(apex[i] ?? 0); hopped[i] = true; }
  if ((apex[i] ?? 0) > 5) {
    if ((flatSince[i] ?? 0) > 1) { flatRuns.push(flatSince[i] ?? 0); }
    flatSince[i] = 0;
  }
  hopApex.push(apex[i] ?? 0);
  hopDist.push(Math.hypot(b.x - (lastBounce[i]?.x ?? 0), b.z - (lastBounce[i]?.z ?? 0)));
  apex[i] = 0;
  lastBounce[i]?.copy(new THREE.Vector3(b.x, b.y, b.z));
};
const playerPos = new THREE.Vector3();
let teleports = 0, enrages = 0, breaches = 0, jank = 0;
const farSince = new Map<number, number>();
let maxD = 0, farTime = 0, totalTime = 0;

const isFar = (b: sim.SimBall): boolean => (b.x - player.pos.x) ** 2 + (b.z - player.pos.z) ** 2 > sim.BALL_MAX_DIST ** 2;

const steps = Math.round(SIM_HOURS * 3600 / DT);
for (let s = 0; s < steps; s++) {
  stepPlayer(DT);
  playerPos.copy(player.pos);
  for (let i = 0; i < balls.length; i += 1) {
    const b = balls[i]!;
    const dBefore = Math.hypot(b.x - player.pos.x, b.z - player.pos.z);

    // === the call Ball.tickLocal makes — same sim the wire replays ===
    const ev = sim.stepBall(b, DT, field, playerPos, true);
    if (ev !== null) {onBounce(i, b);} // every segment kind is a keyframe

    // === jank census ===
    if (!Number.isFinite(b.x + b.y + b.z + b.vx + b.vy + b.vz)) {
      jank += 1;
      if (jank < 5) { console.log(`[JANK] ball ${i} non-finite at t=${(s * DT).toFixed(1)}s pos=(${b.x},${b.y},${b.z}) vel=(${b.vx},${b.vy},${b.vz})`); }
      b.x = player.pos.x + 50; b.y = h(player.pos.x + 50, player.pos.z) + 10; b.z = player.pos.z;
      b.vx = 0; b.vy = 0; b.vz = 0;
    }
    // "Buried" is measured against the field the SIM samples — comparing
    // to the analytic h() would flag byte-quantization noise as jank.
    const gy = Math.max(hm.hmHeight(field, b.x, b.z), hm.hmChord(field, b.x, b.z));
    const under = gy + b.radius - b.y;
    if (under > 0.5) {
      jank += 1;
      if (jank < 10) { console.log(`[JANK] ball ${i} buried ${under.toFixed(2)}m at t=${(s * DT).toFixed(1)}s`); }
      b.y = gy + b.radius;
    }
    if (b.enraged) { enrages += 1; }

    const far = isFar(b);
    if (far) {
      farTime += DT;
      if (!farSince.has(i)) { farSince.set(i, s); }
      else if ((s - (farSince.get(i) ?? s)) * DT > 8) { breaches += 1; farSince.delete(i); }
    } else {
      if (farSince.has(i)) { teleports += 1; farSince.delete(i); }
      if (dBefore > 250 && !far) { teleports += 1; } // came home hard — count leash returns
    }
    apex[i] = Math.max(apex[i] ?? 0, b.y - h(b.x, b.z) - b.radius);
    // Flat = time spent NEAR the surface without a real hop — soaring
    // through a 60m arc for 4s is not a flat spell, it's the payoff.
    if (b.y - h(b.x, b.z) - b.radius < 4) { flatSince[i] = (flatSince[i] ?? 0) + DT; }
    maxD = Math.max(maxD, Math.hypot(b.x - player.pos.x, b.z - player.pos.z));
  }
  totalTime += DT;
}

// any ball still far at the end?
let stillFar = 0;
for (const b of balls) { if (isFar(b)) { stillFar += 1; } }

console.log(`\n=== classic soak: ${SIM_HOURS}h sim, ${N_BALLS} balls, dt=${DT.toFixed(4)} ===`);
console.log(`jank events        : ${jank}`);
console.log(`enraged frames     : ${enrages}  (must be 0 — docile mode)`);
console.log(`far-breach >8s     : ${breaches}`);
console.log(`balls still far    : ${stillFar}`);
console.log(`leash returns      : ${teleports}`);
console.log(`max dist seen      : ${maxD.toFixed(0)}m`);
console.log(`ball-time >200m    : ${(100 * farTime / (totalTime * N_BALLS)).toFixed(2)}%`);
const avgD = balls.reduce((a, b) => a + Math.hypot(b.x - player.pos.x, b.z - player.pos.z), 0) / N_BALLS;
console.log(`final avg dist     : ${avgD.toFixed(0)}m`);

// hop distribution — percentiles of apex height and bounce-to-bounce travel
const pct = (arr: number[], p: number): number => {
  const s = [...arr].sort((x, y) => x - y);
  return s.length === 0 ? 0 : (s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0);
};
console.log(`\nhops recorded      : ${hopApex.length}`);
console.log(`FIRST hop apex p50/p90/max : ${pct(firstApex, 0.5).toFixed(1)} / ${pct(firstApex, 0.9).toFixed(1)} / ${pct(firstApex, 1).toFixed(1)}`);
console.log(`apex m  p50/p90/p99/max : ${pct(hopApex, 0.5).toFixed(1)} / ${pct(hopApex, 0.9).toFixed(1)} / ${pct(hopApex, 0.99).toFixed(1)} / ${pct(hopApex, 1).toFixed(1)}`);
console.log(`apex deciles (m)   : ${[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].map((p): string => `p${Math.round(p * 100)}=${pct(hopApex, p).toFixed(1)}`).join(' ')}`);
console.log(`dist m  p50/p90/p99/max : ${pct(hopDist, 0.5).toFixed(1)} / ${pct(hopDist, 0.9).toFixed(1)} / ${pct(hopDist, 0.99).toFixed(1)} / ${pct(hopDist, 1).toFixed(1)}`);
const buckets = [0, 2, 5, 10, 20, 40, 80, 1e9];
const names = ['<2m', '2-5', '5-10', '10-20', '20-40', '40-80', '>80m'];
const hist = names.map((): number => 0);
for (const a of hopApex) {
  for (let bi = 0; bi < buckets.length - 1; bi += 1) {
    if (a >= (buckets[bi] ?? 0) && a < (buckets[bi + 1] ?? 0)) { hist[bi] = (hist[bi] ?? 0) + 1; break; }
  }
}
console.log(`apex histogram     : ${names.map((n, bi) => `${n}:${hist[bi]}`).join(' ')}`);

// flat spells — completed runs + spells still open at soak end
const openFlat = flatSince.filter((v) => v > 1);
const flatSecs = flatRuns.reduce((a, v) => a + v, 0) + openFlat.reduce((a, v) => a + v, 0);
console.log(`\nflat spells (>1s w/o a 5m hop): ${flatRuns.length} done, ${openFlat.length} still open`);
console.log(`flat time share      : ${(100 * flatSecs / (totalTime * N_BALLS)).toFixed(1)}% of all ball-time`);
const allFlat = [...flatRuns, ...openFlat];
console.log(`flat spell len s p50/p90/p99/max : ${pct(allFlat, 0.5).toFixed(1)} / ${pct(allFlat, 0.9).toFixed(1)} / ${pct(allFlat, 0.99).toFixed(1)} / ${pct(allFlat, 1).toFixed(1)}`);
console.log(jank === 0 && enrages === 0 && breaches === 0 ? 'CLEAN' : 'DIRTY');

export {};
