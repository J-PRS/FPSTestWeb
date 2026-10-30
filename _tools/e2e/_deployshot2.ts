// Gunlab pick + scene introspection — verify instanced deployable parts
// actually render (count InstancedMesh in the scene the camera draws).
import { launchClient, closeClient } from './browser.ts';
const pick = process.argv[2] ?? 'mortar';
const client = await launchClient('http://localhost:5400/gunlab.html');
try {
  await client.page.evaluateOnNewDocument(`try{localStorage.setItem('gunlab','{"pick":"${pick}","wt":0,"inspect":false,"yaw":0.8,"pitch":0.15}')}catch(e){}`);
  await client.page.reload({ waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 9000));
  const info = await client.page.evaluate(`(() => {
    const g = window.__gunlab;
    const r = g.renderer;
    // find the scene via the vm group's root
    let scene = g.vm && g.vm.group;
    while (scene && scene.parent) { scene = scene.parent; }
    let inst = 0, meshes = 0, groups = 0;
    if (scene && scene.traverse) { scene.traverse((o) => { if (o.isInstancedMesh) { inst++; } else if (o.isMesh) { meshes++; } else if (o.isGroup) { groups++; } }); }
    return JSON.stringify({ pick: g.pick, calls: r.info.render.calls, inst, meshes, groups, cam: g.camera.position.toArray().map((x) => +x.toFixed(1)) });
  })()`);
  console.log(info);
  await client.page.screenshot({ path: `_deploy_${pick}.png` });
} finally { await closeClient(client); }
