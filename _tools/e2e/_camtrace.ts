/**
 * _camtrace.ts — per DRAWN frame: camera position vs drawn ground under it.
 *   bun _tools/e2e/_camtrace.ts [map]
 * Wraps renderer.render so every presented frame is recorded with the exact
 * camera that was drawn, whether the veil was up, and the rendered ground.
 */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const map = process.argv[2] ?? 'escalade';
const stack = await upStack();
const client = await launchClient(stack.clientUrl(`&room=${map}&bots=0&net=ws`));
try {
  await client.waitFor(`t.player && t.player.pos`, 90000);
  await client.page.evaluate(`(() => {
    const R = window.__test.rendererSetup.renderer;
    const T = window.__test;
    const orig = R.render.bind(R);
    window.__frames = [];
    const t0 = performance.now();
    R.render = (scene, cam) => {
      if (scene !== T.scene) return orig(scene, cam);
      const c = cam.position;
      const p = T.player.pos;
      const ground = T.terrain.getRenderedHeight(c.x, c.z);
      window.__frames.push({
        t: Math.round(performance.now() - t0),
        veil: !!document.getElementById('session-veil'),
        cam: [+c.x.toFixed(1), +c.y.toFixed(1), +c.z.toFixed(1)],
        feetY: +p.y.toFixed(1),
        groundUnderCam: +ground.toFixed(1),
        camAboveGround: +(c.y - ground).toFixed(1),
      });
      return orig(scene, cam);
    };
  })()`);
  await new Promise((r) => setTimeout(r, 8000));
  const rows = JSON.parse(String(await client.page.evaluate(`JSON.stringify(window.__frames)`))) as Array<Record<string, unknown>>;
  console.log(`drawn frames: ${rows.length}`);
  let prev = '';
  rows.forEach((r, i) => {
    const key = `${r.veil}|${(r.cam as number[]).join(',')}`;
    if (key !== prev && (i < 3 || prev === '' || (r.veil as boolean) !== (rows[i - 1]?.veil as boolean) || i === rows.length - 1 || i % 60 === 0)) console.log(`#${i}`, JSON.stringify(r));
    prev = key;
  });
  const below = rows.filter((r) => (r.camAboveGround as number) < 0);
  const dropAt = rows.findIndex((r) => r.veil === false);
  console.log(`frames with camera below drawn ground: ${below.length}/${rows.length}; veil drops at frame #${dropAt}`);
  if (dropAt >= 0) for (const r of rows.slice(dropAt, dropAt + 6)) console.log('POST-DROP', JSON.stringify(r));
} finally {
  await closeClient(client);
  stack.down();
}
