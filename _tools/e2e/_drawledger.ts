// Exact draw attribution: wrap renderer.renderBufferDirect for one frame —
// every draw call lands there (scene pass, shadow pass, composer).
// Per row: ancestor-chain name, object name, material type, color/shadow
// split, draws, triangles.
import { launchClient, closeClient } from './browser.ts';
const url = process.argv[2] ?? 'http://localhost:5400/quickjoin?server=127.0.0.1:8000&mode=ctf&bots=16';
const client = await launchClient(url);
try {
  await client.page.waitForFunction('window.__test && window.__test.player', { timeout: 120000 });
  await new Promise(r => setTimeout(r, 10000));
  const ledger = await client.page.evaluate(`new Promise((resolve) => {
    const r = window.__renderer;
    if (!r) { resolve('no __renderer'); return; }
    const rows = new Map();
    const orig = r.renderBufferDirect;
    r.renderBufferDirect = function (cam, scene, geo, mat, object) {
      const isDepth = mat && (mat.isMeshDepthMaterial || mat.isMeshDistanceMaterial || mat.type === 'ShadowMaterial');
      const pass = isDepth ? 'shadow' : 'color';
      // name: named ancestor (remote model root, structure group…) else obj
      let anc = object, name = object.name || '';
      while (anc.parent && anc.parent !== scene) { anc = anc.parent; if (!name && anc.name) { name = anc.name; } }
      if (!name) { name = (anc === object ? object : anc).type + ':' + (anc.name || object.name || object.type); }
      const key = pass + '|' + name + '|' + (mat ? (mat.name || mat.type) : '?');
      const row = rows.get(key) ?? { name, pass, mat: mat ? (mat.name || mat.type) : '?', draws: 0, tris: 0, objs: new Set() };
      row.draws++;
      row.tris += geo && geo.index ? geo.index.count / 3 : (geo && geo.attributes.position ? geo.attributes.position.count / 3 : 0);
      row.objs.add(object.uuid);
      rows.set(key, row);
      return orig.apply(this, arguments);
    };
    requestAnimationFrame(() => requestAnimationFrame(() => {
      r.renderBufferDirect = orig;
      const out = [...rows.values()].map((x) => ({ ...x, objs: x.objs.size })).sort((a, b) => b.draws - a.draws);
      resolve(JSON.stringify({ total: out.reduce((s, x) => s + x.draws, 0), rows: out }, null, 1));
    }));
  })`);
  console.log(ledger);
} finally { await closeClient(client); }
