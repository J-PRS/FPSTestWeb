// _heavycheck.ts - attach to the ALREADY-RUNNING dev client, wait for real
// remote players (bots), and dump each body's variant + bound clip count.
// The heavy body is variant 'polyart' (class_heavy.glb); anim-bind glitches
// with clips:0 mean the body never registered its clips.
//
//   bun _tools/e2e/_heavycheck.ts [clientUrl] [--lineup]
import { launchClient, closeClient } from './browser.ts';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const lineup = args.includes('--lineup');
const url = args.find((a): boolean => a.startsWith('http'))
  ?? (lineup
    ? 'http://localhost:5400/?room=heavycheck&map=crossfire&bots=0&mode=dm&dummylineup'
    : 'http://localhost:5400/?room=heavycheck&map=crossfire&bots=12&mode=ctf');

const c = await launchClient(url);
const glitches: string[] = [];
c.page.on('console', (m) => {
  const t = m.text();
  if (t.includes('anim-bind') || t.includes('poisoned')) glitches.push(t);
});
await c.waitFor(`window.__test && t.networkManager && t.networkManager.isConnected()`, 30000);
await new Promise((r) => setTimeout(r, 20000)); // models + anims settle

const info = await c.page.evaluate(`(() => {
  const mgr = window.__test.world.remotePlayers;
  const ents = mgr?.entities ? [...mgr.entities.values()] : [];
  const out = ents.map((rp) => {
    const m = rp.model;
    return { id: rp.playerId, cls: rp.armorClass ?? null, variant: m?.variant ?? null,
      clips: m?.anim?.animations?.size ?? -1, inScene: !!m?.model?.parent };
  });
  // any skinned meshes actually in the scene
  let skinned = 0; window.__scene.traverse((o) => { if (o.isSkinnedMesh) skinned++; });
  return { remotes: out, skinned };
})()`);
console.log('CHK', JSON.stringify(info));
console.log('GLITCHES', glitches.length, JSON.stringify(glitches.slice(0, 6)));

mkdirSync('_tools/e2e/shots', { recursive: true });
await c.page.screenshot({ path: '_tools/e2e/shots/heavy.png' });
console.log('shot: _tools/e2e/shots/heavy.png');
await closeClient(c);
