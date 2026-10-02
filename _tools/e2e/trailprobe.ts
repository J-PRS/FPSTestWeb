/**
 * trailprobe.ts — fire shots through the real input path, then dump the
 * live quarks/ribbon state so "invisible trail" bugs read as data.
 *   bun _tools/e2e/trailprobe.ts
 * Writes _tools/e2e/shots/trailprobe.png
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const OUT = join(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'shots');
const stack = await upStack();
const client = await launchClient(stack.clientUrl('&room=trailprobe&bots=0&net=ws'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
try {
  await client.waitFor(`t.player && t.player.pos`, 30000);
  await sleep(2000);

  // Fire through player.onWeaponFire — the same callback combat's trigger
  // invokes on the real input path.
  const fireResult = await client.page.evaluate(`(async () => {
    try {
      const t = window.__test;
      const { weaponDef } = await import('/src/weapons.ts');
      const p = t.player;
      const dir = new p.pos.constructor(0.35, 0.9, 0).normalize(); // high lob — stays in frame longer
      const before = t.world.projectiles.length;
      for (let i = 0; i < 3; i++) {
        p.onWeaponFire(weaponDef(0), {
          origin: p.pos.clone().add(new p.pos.constructor(0, 1.4, 0)),
          dir: dir.clone(),
          playerVel: p.vel.clone(),
        });
        await new Promise(r => setTimeout(r, 300));
      }
      p.yaw = Math.atan2(0.35, 0); p.pitch = 0.6; // face the lob for the screenshot
      return { ok: true, cb: typeof p.onWeaponFire, before,
        after: t.world.projectiles.length,
        hidden: document.hidden, dead: p.isDead,
        inputTracking: t.entities?.inputTracking?.isTabHidden?.() };
    } catch (err) { return { ok: false, err: String(err && err.stack || err) }; }
  })()`);
  console.log('fire result:', JSON.stringify(fireResult));
  let live = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    live = await client.page.evaluate(`(() => {
      const t = window.__test;
      const projs = (t.world?.projectiles ?? []).map(p => ({
        age: +p.age.toFixed(2), exploded: p.exploded, dead: p.dead,
        vel: +p.vel.length().toFixed(1),
        hasTrailPs: !!(p.trail && p.trail.ps),
        trailParticles: p.trail?.ps?.particleNum ?? -1,
        trailPaused: p.trail?.ps?.paused ?? null,
        ribbonSlots: (p.ribbons ?? []).map(r => r.slot),
        ribbonCounts: (p.ribbons ?? []).map(r => r.count),
        ribbonStopped: (p.ribbons ?? []).map(r => r.stopped),
      }));
      const sys = [];
      for (const child of t.scene.children) {
        if (child.systemToBatchIndex) {
          for (const [ps] of child.systemToBatchIndex) {
            sys.push({ particles: ps.particleNum, paused: !!ps.paused,
              looping: !!ps.looping,
              wait: +(ps.emissionState?.waitEmiting ?? -1).toFixed(2),
              pos: [ps.emitter.position.x | 0, ps.emitter.position.y | 0, ps.emitter.position.z | 0] });
          }
        }
      }
      return { projs, sys: sys.filter(s => s.looping || s.particles > 0) };
    })()`);
    if (live.projs.length) {
      mkdirSync(OUT, { recursive: true });
      await client.page.screenshot({ path: join(OUT, 'trailprobe.png') });
      break;
    }
  }
  console.log('live projectiles:', JSON.stringify(live, null, 1));
  console.log('wrote', join(OUT, 'trailprobe.png'));
} finally {
  await client.page.evaluate(`document.dispatchEvent(new MouseEvent('mouseup', { button: 0 }))`).catch(() => {});
  await closeClient(client);
  stack.down();
}
