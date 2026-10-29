// lagoon rework check: ground/beach vantage + aerial of the island.
// Same pos.set + markTeleport pattern as _wyrdshot so jumps stick.
import { upStack } from './env.ts';
import { launchClient, closeClient } from './browser.ts';

const stack = await upStack();
try {
  const c = await launchClient(stack.clientUrl('&room=lagshot&map=lagoon&bots=0&net=ws'),
    { preload: "localStorage.setItem('fps-autoq','false')" });
  await c.waitFor('window.__test && window.__test.networkManager && window.__test.networkManager.isConnected()', 90000);
  // Wait for the swapped-in lagoon field to answer — getHeight is the
  // Terrain method; mapshot's heightAt guess silently fell back to 60 and
  // buried the camera inside the 134m peak (the fog-wall shots).
  await c.waitFor('window.__test.terrain && isFinite(window.__test.terrain.getHeight(0,0))', 60000);
  await new Promise(r => setTimeout(r, 6000));
  const tp = (x: number, z: number, up: number, yaw: number, pitch: number) =>
    `(() => { const p = window.__test.player;
      const h = window.__test.terrain.getHeight(${x}, ${z});
      p.pos.set(${x}, h + ${up}, ${z}); p.vel.set(0,0,0);
      p.yaw = ${yaw}; p.pitch = ${pitch};
      p.syncMovement && p.syncMovement(); p.markTeleport && p.markTeleport(); })()`;
  // Beach-level on the sun side looking NE across a slope — sun azimuth
  // 42 puts light in the east, so view from the east for a lit face.
  await c.page.evaluate(tp(150, 120, 12, 2.3, -0.15));
  await new Promise(r => setTimeout(r, 2000));
  await c.page.screenshot({ path: '_tools/e2e/shots/lagoon_beach.png' });
  // High over the waist between masses, looking down-island — coastline,
  // hue zones, no-pond check from altitude.
  await c.page.evaluate(tp(-60, -20, 260, -0.7, -0.9));
  await new Promise(r => setTimeout(r, 2000));
  await c.page.screenshot({ path: '_tools/e2e/shots/lagoon_high.png' });
  // Near top-down — weight-map coverage + coast shape.
  await c.page.evaluate(tp(100, 60, 420, 0.0, -1.5));
  await new Promise(r => setTimeout(r, 1500));
  await c.page.screenshot({ path: '_tools/e2e/shots/lagoon_top.png' });
  console.log('lagoon shots saved');
  await closeClient(c);
} finally { await stack.down(); }
