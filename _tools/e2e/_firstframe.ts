/**
 * _firstframe.ts — what does the player SEE from the moment the body exists?
 *   bun _tools/e2e/_firstframe.ts [map]
 * Logs per-rAF: veil presence, player feet Y vs rendered ground under it,
 * and screenshots every ~150ms for the first ~4s. Writes shots/first_<n>.png.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const map = process.argv[2] ?? 'escalade';
const OUT = join(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'shots');
mkdirSync(OUT, { recursive: true });

const stack = await upStack();
const client = await launchClient(stack.clientUrl(`&room=${map}&bots=0&net=ws`));
try {
  await client.waitFor(`t.player && t.player.pos`, 60000);
  await client.page.evaluate(`(() => {
    const T = window.__test;
    window.__fl = [];
    const t0 = performance.now();
    const step = () => {
      const p = T.player;
      const tr = T.terrain;
      const cam = T.rendererSetup?.camera ?? null;
      const gx = p.pos.x, gz = p.pos.z;
      window.__fl.push({
        t: Math.round(performance.now() - t0),
        veil: !!document.getElementById('session-veil'),
        dead: p.isDead,
        feetY: +p.pos.y.toFixed(2),
        groundRendered: +tr.getRenderedHeight(gx, gz).toFixed(2),
        groundField: +tr.getHeight(gx, gz).toFixed(2),
        camY: cam ? +cam.position.y.toFixed(2) : null,
        pos: [+gx.toFixed(1), +gz.toFixed(1)],
      });
      if (performance.now() - t0 < 4500) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  })()`);
  for (let i = 0; i < 30; i++) {
    await client.page.screenshot({ path: join(OUT, `first_${String(i).padStart(2, '0')}.png`) });
    await new Promise((r) => setTimeout(r, 120));
  }
  const log = await client.page.evaluate(`JSON.stringify(window.__fl)`);
  const rows = JSON.parse(String(log)) as Array<Record<string, unknown>>;
  // Print only transitions and any under-ground frame, so the output stays readable.
  let prev = '';
  for (const r of rows) {
    const under = (r.feetY as number) < (r.groundRendered as number) - 0.5;
    const key = `${r.veil}|${r.dead}|${under}`;
    if (key !== prev || under) console.log(JSON.stringify(r));
    prev = key;
  }
  console.log(`frames logged: ${rows.length}; screenshots: ${OUT}/first_*.png`);
} finally {
  await closeClient(client);
  stack.down();
}
