// _juggshot.ts — posedump screenshots of the juggernaut variant at
// several angles to eyeball mesh holes.
import { launchClient, closeClient } from './browser.ts';
import { mkdirSync } from 'node:fs';

try {
  mkdirSync('_tools/e2e/shots', { recursive: true });
  const c = await launchClient(
    `http://localhost:5400/posedump.html?pmodel=juggernaut&state=${process.env.STATE || 'idle'}&t=0.5`, {});
  await c.page.waitForFunction('window.__ready === true', { timeout: 180000 });
  // __cam is exposed — orbit around the body for each angle.
  const views: Record<string, [number, number, number]> = {
    front: [0, 1.4, 3.2], back: [0, 1.4, -3.2],
    left: [-3.0, 1.4, 0.4], right: [3.0, 1.4, 0.4],
    chest: [0.6, 1.5, 1.4], top: [0.2, 3.0, 1.6],
  };
  for (const [name, [x, y, z]] of Object.entries(views)) {
    await c.page.evaluate((px: number, py: number, pz: number) => {
      const cam = (window as unknown as { __cam: { position: { set: (a: number, b: number, c: number) => void }; lookAt: (a: number, b: number, c: number) => void } }).__cam;
      cam.position.set(px, py, pz);
      cam.lookAt(0, 1.3, 0);
    }, x, y, z);
    await new Promise((r) => setTimeout(r, 250));
    await c.page.screenshot({ path: `_tools/e2e/shots/jugg-${name}.png` });
    console.log(`shot ${name}`);
  }
  await closeClient(c);
} finally { /* dev server on :5400 stays up */ }
