/**
 * jetskishot.ts — A/B capture of the locomotion VFX the user can't see:
 * ski roostertail and jetpack plume. Freezes the local player as a fixed
 * camera (input.frozen => updateFrozenCamera, no sim) and drives the real
 * spawn hooks (player.onSki / player.onJetpack) at a fixed world point,
 * aiming the camera straight at it, so burst density/size/colour read
 * exactly as a teammate's would — no sim interference, no luck.
 *   bun _tools/e2e/jetskishot.ts [map] [tag]
 * Writes _tools/e2e/shots/fx_<tag>_<case>_n.png
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const map = process.argv[2] ?? 'whiteout';
const tag = process.argv[3] ?? 'x';
const OUT = join(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'shots');

// case: kind, metres ahead of the eye, height of the emit point vs ground
const CASES: { name: string; kind: 'ski' | 'jet'; ahead: number; up: number }[] = [
  { name: 'ski', kind: 'ski', ahead: 6, up: 0 },
  { name: 'jet', kind: 'jet', ahead: 6, up: 2.6 },
  { name: 'jetsky', kind: 'jet', ahead: 14, up: 9 },
];

const stack = await upStack();
const client = await launchClient(stack.clientUrl(`&room=fxshot&bots=0&map=${map}&mode=dm`), {
  // Headless SwiftShader sits at ~10fps; the auto-quality ladder would cut
  // vfx quality scale and starve the plume we're here to judge.
  preload: `localStorage.setItem('fps-autoq', 'false');`,
});
try {
  await client.waitFor(`t.player && t.player.pos`, 30000);
  await client.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
  await new Promise((r) => setTimeout(r, 6000)); // terrain + player model settle

  const setup = await client.page.evaluate(`(() => {
    const t = window.__test;
    const p = t.player;
    const g = t.terrain.heightAt ? t.terrain.heightAt(240, 240) : 60;
    p.pos.set(240, g + 1.7, 240);
    p.vel.set(0, 0, 0);
    p.yaw = 0; p.pitch = 0;
    p.syncMovement && p.syncMovement();
    p.markTeleport && p.markTeleport();
    p.input.frozen = true;
    return { g, hasSki: !!p.onSki, hasJet: !!p.onJetpack };
  })()`);
  console.log('setup', JSON.stringify(setup));
  await new Promise((r) => setTimeout(r, 1200));

  // Aim the frozen camera straight at the emit point so the plume lands dead
  // centre frame; also stash the point + its ski velocity for the emit pass.
  const aim = (c: (typeof CASES)[number]): Promise<unknown> =>
    client.page.evaluate(`(() => {
      const t = window.__test; const p = t.player;
      const V = p.pos.constructor;
      const ahead = ${c.ahead}, up = ${c.up};
      const dirX = Math.sin(p.yaw), dirZ = Math.cos(p.yaw);
      const cx = p.pos.x + dirX * ahead, cz = p.pos.z + dirZ * ahead;
      const g = t.terrain.heightAt ? t.terrain.heightAt(cx, cz) : p.pos.y - 2;
      const px = cx, py = g + up, pz = cz;
      const dx = px - p.pos.x, dy = py - p.pos.y, dz = pz - p.pos.z;
      p.yaw = Math.atan2(dx, dz);
      p.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      window.__fxPos = new V(px, py, pz);
      window.__fxVel = new V(Math.sin(p.yaw) * 26, 0, Math.cos(p.yaw) * 26);
      return { g, pos: [px, py, pz], pitch: p.pitch, yaw: p.yaw };
    })()`);

  const emit = (c: (typeof CASES)[number]): Promise<unknown> =>
    client.page.evaluate(`(() => {
      const p = window.__test.player;
      let n = 0;
      const id = setInterval(() => {
        if ('${c.kind}' === 'ski') { p.onSki && p.onSki(window.__fxPos, window.__fxVel); }
        else { p.onJetpack && p.onJetpack(window.__fxPos); }
        if ((n += 1) > 2000) { clearInterval(id); }
      }, 5);
      window.__fxId = id;
      return true;
    })()`);

  mkdirSync(OUT, { recursive: true });
  const stats = (): Promise<unknown> =>
    client.page.evaluate(`(() => {
      const d = window.__trailDump ? window.__trailDump() : null;
      return { hidden: document.hidden, live: d && d.pools ? d.pools.liveParticles : null,
        liveSystems: d && d.pools ? d.pools.live : null };
    })()`);
  console.log('vis', JSON.stringify(await stats()));

  for (const c of CASES) {
    console.log(c.name, JSON.stringify(await aim(c)));
    await new Promise((r) => setTimeout(r, 1200)); // camera settles on the new aim
    // Baseline with the aim fixed but no plume — the diff pass then proves
    // exactly where and how strongly the effect lands on the framebuffer.
    const base = join(OUT, `fx_${tag}_${c.name}_0.png`);
    await client.page.screenshot({ path: base });
    await emit(c);
    await new Promise((r) => setTimeout(r, 1500)); // let the plume build
    console.log(c.name, 'stats', JSON.stringify(await stats()));
    const file1 = join(OUT, `fx_${tag}_${c.name}_1.png`);
    await client.page.screenshot({ path: file1 });
    console.log('wrote', file1);
    await new Promise((r) => setTimeout(r, 900));
    const file2 = join(OUT, `fx_${tag}_${c.name}_2.png`);
    await client.page.screenshot({ path: file2 });
    console.log('wrote', file2);
    await client.page.evaluate(`clearInterval(window.__fxId)`);
    await new Promise((r) => setTimeout(r, 2000)); // let it die between takes
    // Post-baseline: same aim, plume gone. base-vs-post isolates scene drift
    // (sky mood / weather) from the effect itself.
    const post = join(OUT, `fx_${tag}_${c.name}_3.png`);
    await client.page.screenshot({ path: post });
  }
} finally {
  await closeClient(client);
  stack.down();
}
