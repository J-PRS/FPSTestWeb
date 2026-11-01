// Record-side cost bench: drives DemoRecorder headlessly at 60Hz for a
// simulated 60s with a synthetic field (8 remotes, 20 balls churning),
// then prints µs/call per section from recorder.prof. No game, no GPU.
// Usage: bun _tools/demorecprof.ts [--secs 60]

// DOM stubs before any client import (Logger/config touch window).
if (typeof globalThis.window === 'undefined') {
  (globalThis as Record<string, unknown>).window = {
    location: { search: '', href: 'http://localhost/' },
    addEventListener: (): void => { return; },
    removeEventListener: (): void => { return; },
    dispatchEvent: (): boolean => true,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
}
if (typeof globalThis.localStorage === 'undefined') {
  const s = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string): string | null => s.get(k) ?? null,
    setItem: (k: string, v: string): void => { s.set(k, String(v)); },
    removeItem: (k: string): void => { s.delete(k); },
    clear: (): void => { s.clear(); },
    get length(): number { return s.size; },
    key: (i: number): string | null => [...s.keys()][i] ?? null,
  };
}
if (typeof globalThis.document === 'undefined') {
  (globalThis as Record<string, unknown>).document = {
    addEventListener: (): void => { return; },
    removeEventListener: (): void => { return; },
    getElementById: (): null => null,
    querySelector: (): null => null,
    querySelectorAll: (): never[] => [],
    createElement: (): Record<string, unknown> => ({ style: {}, children: [] }),
    createTextNode: (t: string): { textContent: string } => ({ textContent: t }),
    body: { append: (): void => { return; }, appendChild: (): void => { return; } },
    hidden: false,
  };
}
if (typeof globalThis.CustomEvent === 'undefined') {
  class C { type: string; detail: unknown; constructor(t: string, i?: { detail?: unknown }) { this.type = t; this.detail = i?.detail; } }
  (globalThis as Record<string, unknown>).CustomEvent = C;
}

const { DemoRecorder } = await import('../client/src/demo/DemoRecorder.js');
const ev = await import('../client/src/demo/demoEvents.js');

const secs = Number(process.argv.find((a): boolean => a.startsWith('--secs'))?.split('=')[1] ?? 60);

// Player moving so dead-reckon doesn't skip every frame (worst case).
const p = {
  posX: 0, posY: 70, posZ: 0, velX: 30, velY: 0, velZ: 12,
  yaw: 0, pitch: -0.2, weaponType: 40, health: 100, armor: 50,
};
const inp = { inputFlags: 3, mouseDeltaX: 2, mouseDeltaY: -1, jetpackFlags: 1, jetpackFuel: 80 };

// 8 remotes jittering (real wire motion, never dead-reckon skipped).
const remotes = Array.from({ length: 8 }, (_, i) => ({
  id: `bot${i}`, posX: i * 40, posY: 60, posZ: i * -30,
  velX: 20, velY: 0, velZ: 5, yaw: i, pitch: 0, dead: false, ski: true,
  team: i % 2 ? 'alpha' : 'bravo', health: 100, held: 0, sheep: 0,
  armorClass: 'medium', status: 0, weapon: 42,
}));

// 20 balls drifting — the world-state sweep cost path.
const balls = Array.from({ length: 20 }, (_, i) => ({
  targetId: 10 + i, targetType: 0,
  pos: { x: i * 50, y: 40 + (i % 5) * 20, z: i * -25 },
  vel: { x: 15, y: -3, z: 8 }, health: 3,
}));

const r = new DemoRecorder(30, 60);
r.start(p as never, inp as never);
r.setRemoteSource(() => remotes);
r.setTargetSnapshotSource(() => balls);

// Ball event traffic: ~3 edge events/sec/ball (bounce+peak) — realistic
// mid-fight volume, exercises the push path housekeep can't reach.
let evtN = 0;
const pushBallEvent = (): void => {
  const b = balls[evtN % balls.length]!;
  ev.recordTargetBounce(r, b.targetId, { ...b.pos }, { ...b.vel }, 0);
  evtN += 1;
};

const dt = 1 / 60;
let t = 0;
const wall0 = performance.now();
while (t < secs) {
  p.posX += 0.5; p.yaw += 0.01; // never identical frames
  r.update(dt);
  if (evtN < t * 60) {pushBallEvent();} // ~60 target events/sec aggregate
  t += dt;
}
const wallMs = performance.now() - wall0;

const ms = (ns: number): string => ns.toFixed(1);
const us = (ns: number, n: number): string => n > 0 ? (ns * 1000 / n).toFixed(2) : '-';
const pr = r.prof;
console.log(`demorecprof: ${secs}s sim @60Hz, 8 remotes, 20 balls, ~60 targetEvents/s`);
console.log(`  wall time for sim:  ${wallMs.toFixed(0)}ms (incl. sim overhead)`);
console.log(`  update() total:     ${ms(pr.updateNs)}ms over ${pr.updateN} calls → ${us(pr.updateNs, pr.updateN)}µs/call`);
console.log(`  frame write:        ${ms(pr.frameNs)}ms / ${pr.frameN} → ${us(pr.frameNs, pr.frameN)}µs`);
console.log(`  remote sample:      ${ms(pr.remoteNs)}ms / ${pr.remoteN} → ${us(pr.remoteNs, pr.remoteN)}µs`);
console.log(`  target snapshot:    ${ms(pr.targetNs)}ms / ${pr.targetN} → ${us(pr.targetNs, pr.targetN)}µs`);
console.log(`  rolling prune:      ${ms(pr.pruneNs)}ms / ${pr.pruneN} → ${us(pr.pruneNs, pr.pruneN)}µs`);
console.log(`  buffers: frames=${r.frameBuffer.Count} proj=${r.projectileEvents.length} tgt=${r.targetEvents.length} remotes=${r.remoteFrames.length}`);
const msPerSec = pr.updateNs / secs;
console.log(`  budget: ${msPerSec.toFixed(2)}ms of recorder time per real second (${(msPerSec / 10).toFixed(2)}% of a 60fps frame)`);
