import { launchClient, closeClient } from './e2e/browser.ts';
const c = await launchClient('http://localhost:5400/posedump.html?pmodel=juggernaut&state=idle&t=0.5&wearviz=1', {});
await c.page.waitForFunction('window.__ready === true', { timeout: 120000 });
const info = await c.page.evaluate(`(() => { const out = [];
  window.__pm.model.traverse(o => { if (!o.isMesh && !o.isSkinnedMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) out.push({ mesh: o.name, mat: m.name, grunge: !!m.userData.__grunge,
      vc: m.vertexColors, metal: +m.metalness?.toFixed(2), us: m.userData.__unitScale,
      attrs: Object.keys(o.geometry.attributes).filter(a => !/position|normal|skin|tan/.test(a)) }); });
  return out; })()`);
console.log(JSON.stringify(info));
await c.page.screenshot({ path: '_tools/e2e/shots/jugg-wearviz.png' });
await closeClient(c);
