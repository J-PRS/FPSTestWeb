/* oxlint-disable no-console */
// Live bot-behavior probe: join the local server's bot room, sample each
// remote every 2s for ~20s - net displacement, sheep meter, deaths.
import { launchClient, closeClient } from './browser.ts';

const c = await launchClient(`http://localhost:5400/?server=ws://localhost:8000/ws`);
await c.waitFor(`window.__test && window.__test.player`, 40000);
console.log('seated');

const snap = new Map<string, { x: number; y: number; z: number; t: number }>();
const first: Map<string, { x: number; y: number; z: number }> = new Map();
let sheep: Record<string, number> = {};

for (let i = 0; i <= 10; i += 1) {
  const s = await c.page.evaluate(`(() => {
    const w = window.__test.world; const out = [];
    for (const [id, rp] of w.remotePlayers.entities) {
      out.push({ id, x: rp.position.x, y: rp.position.y, z: rp.position.z,
        dead: rp.isDead, sheep: rp.sheep ?? null, ski: rp.skiing ?? null });
    }
    return out; })()`) as { id: string; x: number; y: number; z: number; dead: boolean; sheep: number | null; ski: number | null }[];
  const now = Date.now();
  for (const r of s) {
    if (!first.has(r.id)) {first.set(r.id, { x: r.x, y: r.y, z: r.z });}
    snap.set(r.id, { x: r.x, y: r.y, z: r.z, t: now });
    if (r.sheep !== null) {sheep[r.id] = r.sheep;}
  }
  if (i < 10) {await new Promise(r => setTimeout(r, 2000));}
}

const rows = [...snap.entries()].map(([id, s]) => {
  const f = first.get(id)!;
  const net = Math.hypot(s.x - f.x, s.y - f.y, s.z - f.z);
  return `${id.padEnd(16)} net=${net.toFixed(1).padStart(6)}m sheep=${sheep[id] ?? '?'}`;
});
for (const r of rows) {console.log(r);}
await closeClient(c);
