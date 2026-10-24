// _juggshot.ts — posedump screenshots of the juggernaut variant at
// several angles to eyeball mesh holes.
import { launchClient, closeClient } from './browser.ts';
import { mkdirSync } from 'node:fs';

try {
  mkdirSync('_tools/e2e/shots', { recursive: true });
  const pmodel = process.env.PMODEL || 'juggernaut';
  const c = await launchClient(
    `http://localhost:5400/posedump.html?pmodel=${pmodel}&state=${process.env.STATE || 'idle'}&t=0.5`, {});
  await c.page.waitForFunction('window.__ready === true', { timeout: 180000 });
  // __cam is exposed — orbit around the body for each angle.
  const views: Record<string, [number, number, number, number]> = {
    front: [0, 1.4, 3.2, 1.3], back: [0, 1.4, -3.2, 1.3],
    left: [-3.0, 1.4, 0.4, 1.3], right: [3.0, 1.4, 0.4, 1.3],
    chest: [0.6, 1.5, 1.4, 1.3], top: [0.2, 3.0, 1.6, 1.3],
    head: [0.9, 2.0, 2.2, 1.85], far: [0, 1.6, 4.4, 1.35],
  };
  for (const [name, [x, y, z, ly]] of Object.entries(views)) {
    await c.page.evaluate((px: number, py: number, pz: number, lpy: number) => {
      const cam = (window as unknown as { __cam: { position: { set: (a: number, b: number, c: number) => void }; lookAt: (a: number, b: number, c: number) => void } }).__cam;
      cam.position.set(px, py, pz);
      cam.lookAt(0, lpy, 0);
    }, x, y, z, ly);
    await new Promise((r) => setTimeout(r, 250));
    await c.page.screenshot({ path: `_tools/e2e/shots/${pmodel}-${process.env.STATE || 'idle'}-${name}.png` });
    console.log(`shot ${name}`);
  }
  await closeClient(c);
} finally { /* dev server on :5400 stays up */ }
