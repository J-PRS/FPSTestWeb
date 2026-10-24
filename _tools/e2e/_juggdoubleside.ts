// _juggdoubleside.ts — same posedump, but force DoubleSide on every
// material before shooting. If the "holes" fill in, they're inverted
// faces (backface culling), not missing geometry.
import { launchClient, closeClient } from './browser.ts';
import { mkdirSync } from 'node:fs';

mkdirSync('_tools/e2e/shots', { recursive: true });
const c = await launchClient(
  `http://localhost:5400/posedump.html?pmodel=juggernaut&state=${process.env.STATE || 'run'}&t=0.5`, {});
await c.page.waitForFunction('window.__ready === true', { timeout: 180000 });
await c.page.evaluate((): void => {
  const pm = (window as unknown as { __pm: { object3D: { traverse: (f: (o: { material?: { side: number; needsUpdate: boolean } }) => void) => void } } }).__pm;
  pm.object3D.traverse((o) => { if (o.material) {o.material.side = 2; o.material.needsUpdate = true;} });
});
const views: Record<string, [number, number, number]> = {
  front: [0, 1.4, 3.2], left: [-3.0, 1.4, 0.4], chest: [0.6, 1.5, 1.4],
};
for (const [name, [x, y, z]] of Object.entries(views)) {
  await c.page.evaluate((px: number, py: number, pz: number) => {
    const cam = (window as unknown as { __cam: { position: { set: (a: number, b: number, c: number) => void }; lookAt: (a: number, b: number, c: number) => void } }).__cam;
    cam.position.set(px, py, pz);
    cam.lookAt(0, 1.3, 0);
  }, x, y, z);
  await new Promise((r) => setTimeout(r, 250));
  await c.page.screenshot({ path: `_tools/e2e/shots/jugg-ds-${name}.png` });
  console.log(`shot ds-${name}`);
}
await closeClient(c);
