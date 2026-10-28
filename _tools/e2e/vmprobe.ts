/**
 * vmprobe.ts — is the viewmodel (first-person weapon) in the vm scene?
 *
 *   E2E_GPU=1 bun _tools/e2e/vmprobe.ts
 *
 * Boots a headless client into a bot room, then dumps: every object in
 * vmScene with type/name/visible/geometry-presence, plus whether the
 * shadowIntensity crash fired. Answers "weapons invisible even in
 * wireframe" = meshes absent vs present-but-not-drawn.
 */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const stack = await upStack();
const client = await launchClient(stack.clientUrl('&room=vmprobe&map=lagoon&bots=4&net=ws'));
const crashes: string[] = [];
client.page.on('pageerror', (e) => { if (String(e).includes('shadowIntensity')) {crashes.push(String(e).slice(0, 120));} });
client.page.on('console', (m) => { if (m.text().includes('shadowIntensity')) {crashes.push(m.text().slice(0, 120));} });

try {
  await client.waitFor(`t.networkManager && t.networkManager.isConnected()`, 60000);
  await new Promise((r) => setTimeout(r, 15000)); // let the vm finish loading + render

  const census = await client.test<unknown>(`(() => {
    const out = [];
    const walk = (o, depth) => {
      out.push({
        d: depth, type: o.type, name: o.name || '', vis: o.visible,
        geo: !!o.geometry, mat: Array.isArray(o.material) ? o.material.length : o.material ? 1 : 0,
        skin: o.isSkinnedMesh === true, pos: [+o.position.x.toFixed(2), +o.position.y.toFixed(2), +o.position.z.toFixed(2)],
      });
      if (depth < 6) { for (const c of o.children) { walk(c, depth + 1); } }
    };
    walk(window.__vmScene ?? (window.__test && window.__test.vmScene && window.__test.vmScene()) ?? { children: [] }, 0);
    return out;
  })()`).catch(() => null);

  if (!census) {
    const fallback = await client.test<unknown>(`(() => {
      // Hunt globals for a scene containing the viewmodel.
      const scenes = [];
      for (const k of Object.getOwnPropertyNames(window)) {
        const v = window[k];
        if (v && v.isScene) { scenes.push({ key: k, kids: v.children.length }); }
      }
      return scenes;
    })()`);
    console.log('vmScene accessor missing — scene-like globals:', JSON.stringify(fallback));
  } else {
    console.log(`vmScene census: ${(census as unknown[]).length} nodes`);
    console.log(JSON.stringify(census, null, 0).slice(0, 6000));
  }
  console.log(`shadowIntensity crashes during run: ${crashes.length}`);
  for (const c of crashes.slice(0, 3)) {console.log(`  ${c}`);}
} finally {
  await closeClient(client);
  stack.down();
}
