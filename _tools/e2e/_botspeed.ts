/* oxlint-disable no-console */
// Live bot Tribes-ness probe: join a populated room, sample remotes 1Hz
// for ~25s - speed histogram, ski flag fraction, parked fraction.
import { launchClient, closeClient } from './browser.ts';

const c = await launchClient(`http://localhost:5400/?server=ws://localhost:8000/ws&room=headhunt-1`);
await c.waitFor(`window.__test && window.__test.player`, 40000);
await new Promise(r => setTimeout(r, 6000)); // remotes populate + settle

const stats = new Map<string, { n: number; fast: number; parked: number; ski: number; max: number; dead: number }>();
for (let i = 0; i < 25; i += 1) {
  const rows = await c.page.evaluate(`(() => {
    const out = [];
    for (const [id, rp] of window.__test.world.remotePlayers.entities) {
      out.push({ id, vx: rp.vel.x, vy: rp.vel.y, vz: rp.vel.z, ski: rp.skiing ?? 0, dead: rp.isDead });
    }
    return out; })()`) as { id: string; vx: number; vy: number; vz: number; ski: number; dead: boolean }[];
  for (const r of rows) {
    const s = stats.get(r.id) ?? { n: 0, fast: 0, parked: 0, ski: 0, max: 0, dead: 0 };
    const sp = Math.hypot(r.vx, r.vy, r.vz);
    s.n += 1;
    if (sp > 20) {s.fast += 1;}
    if (sp < 3) {s.parked += 1;}
    if (r.ski) {s.ski += 1;}
    s.max = Math.max(s.max, sp);
    if (r.dead) {s.dead += 1;}
    stats.set(r.id, s);
  }
  await new Promise(r => setTimeout(r, 1000));
}
for (const [id, s] of stats) {
  console.log(`${id.padEnd(16)} fast=${Math.round(s.fast / s.n * 100)}% parked=${Math.round(s.parked / s.n * 100)}% ski=${Math.round(s.ski / s.n * 100)}% vmax=${s.max.toFixed(0)} dead=${Math.round(s.dead / s.n * 100)}%`);
}
await closeClient(c);
