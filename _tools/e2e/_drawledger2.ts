// Exact draw attribution v2: renderBufferDirect wrap, ONE frame, and for
// every drawn object the FULL parent chain (names+types) so nothing
// collapses into "Mesh:Mesh". Pass split: shadow vs color via material.
import { launchClient, closeClient } from './browser.ts';
const map = process.argv[2];
const url = map ? `http://localhost:5400/?mode=ctf&map=${map}&bots=16` : 'http://localhost:5400/quickjoin?server=127.0.0.1:8000&mode=ctf&bots=16';
const client = await launchClient(url);
try {
  await client.page.waitForFunction('window.__test && window.__test.player', { timeout: 120000 });
  await new Promise(r => setTimeout(r, 10000));
  const ledger = await client.page.evaluate(`new Promise((resolve) => {
    const r = window.__renderer;
    if (!r) { resolve('no __renderer'); return; }
    const rows = new Map();
    const orig = r.renderBufferDirect;
    const rt0 = r.getRenderTarget();
    r.renderBufferDirect = function (cam, scene, geo, mat, object) {
      const isDepth = mat && (mat.isMeshDepthMaterial || mat.isMeshDistanceMaterial || mat.type === 'ShadowMaterial');
      const pass = isDepth ? 'shadow' : 'color';
      const chain = [];
      let a = object;
      while (a && a !== scene) { chain.push(a.name || a.type); a = a.parent; }
      const key = pass + '|' + chain.join('<') + '|' + (mat ? (mat.name || mat.type) : '?');
      const row = rows.get(key) ?? { chain: chain.join('<'), pass, mat: mat ? (mat.name || mat.type) : '?', draws: 0, tris: 0, objs: new Set() };
      row.draws++;
      const pos = geo && geo.attributes.position;
      row.tris += geo && geo.index ? geo.index.count / 3 : (pos ? pos.count / 3 : 0);
      row.objs.add(object.uuid);
      rows.set(key, row);
      return orig.apply(this, arguments);
    };
    requestAnimationFrame(() => {
      r.renderBufferDirect = orig;
      const out = [...rows.values()].map((x) => ({ ...x, objs: x.objs.size, tris: Math.round(x.tris) })).sort((a, b) => b.draws - a.draws);
      resolve(JSON.stringify({ total: out.reduce((s, x) => s + x.draws, 0), rows: out }, null, 1));
    });
  })`);
  console.log(ledger);
} finally { await closeClient(client); }
