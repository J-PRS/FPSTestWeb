// Per-subtree draw-call + triangle profiler. Patches WebGLRenderer's
// renderBufferDirect — the single funnel every GL draw goes through —
// so calls attribute to their object + top-level scene ancestor with
// zero misses (sprites, batched VFX, viewmodel, HUD all included).
//   E2E_GPU=1 bun _tools/e2e/_callprof.ts [bots] [secs]
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const bots = Number(process.argv[2] ?? 16);
const secs = Number(process.argv[3] ?? 4);
const stack = await upStack();
const c = await launchClient(stack.clientUrl(`&room=callprof&bots=${bots}`));
await c.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
await new Promise((r) => setTimeout(r, 8000)); // entities/structures settle

const rows = await c.page.evaluate(`new Promise((done) => {
  const r = window.__renderer;
  const agg = new Map();
  const f0 = r.info.render.frame;
  // onBeforeRender fires once per rendered object; a multi-group geometry
  // produces geometry.groups.length draw calls for that one event.
  const hook = new WeakMap();
  const hookObj = (o, scene) => {
    if (hook.has(o)) { return; }
    hook.set(o, 1);
    const prev = o.onBeforeRender;
    o.onBeforeRender = function (renderer, sc, cam, geom, mat, grp) {
      let top = this, prev2 = this;
      while (sc && top.parent && top.parent !== sc) { prev2 = top; top = top.parent; }
      const key = (sc ? (sc.name || sc.type) : '(internal)') + ' :: ' + (prev2 === this ? (this.name || this.type) : (prev2.name || prev2.type));
      let rec = agg.get(key);
      if (!rec) { rec = { calls: 0, tris: 0, objs: new Set() }; agg.set(key, rec); }
      rec.calls += Math.max(geom.groups ? geom.groups.length : 0, 1);
      rec.objs.add(this.uuid);
      let tris = geom.index ? geom.index.count / 3
        : (geom.attributes.position ? geom.attributes.position.count / 3 : 0);
      if (this.isInstancedMesh) { tris *= this.count; }
      rec.tris += tris;
      if (prev) { prev.call(this, renderer, sc, cam, geom, mat, grp); }
    };
  };
  const hookScene = (s) => s.traverse((o) => { if (o.geometry || o.isSprite || o.isPoints || o.isLine || o.isMesh) { hookObj(o, s); } });
  hookScene(window.__test.scene);
  // per-render()-call pass totals — info.calls is that pass's exact count
  const origR = r.render.bind(r);
  const passes = new Map(); // sceneName -> {renders, calls, tris}
  r.render = function (scene, camera) {
    if (scene && scene.isScene) { hookScene(scene); } // late-joined objects
    const ret = origR(scene, camera);
    const name = (scene && (scene.name || scene.type)) || '(null)';
    let p = passes.get(name);
    if (!p) { p = { renders: 0, calls: 0, tris: 0 }; passes.set(name, p); }
    p.renders++; p.calls += r.info.render.calls; p.tris += r.info.render.triangles;
    return ret;
  };
  setTimeout(() => {
    r.render = origR;
    const frames = r.info.render.frame - f0;
    const out = [];
    for (const [key, rec] of agg) {
      out.push({ bucket: key, calls: +(rec.calls / frames).toFixed(1),
                 tris: Math.round(rec.tris / frames), objs: rec.objs.size });
    }
    const passRows = [];
    for (const [name, p] of passes) {
      passRows.push({ pass: name, rendersPerF: +(p.renders / frames).toFixed(1),
                      callsPerRender: +(p.calls / p.renders).toFixed(1),
                      callsPerF: +(p.calls / frames).toFixed(1), trisPerF: Math.round(p.tris / frames) });
    }
    done({ frames, rows: out.sort((a, b) => b.calls - a.calls),
           passes: passRows.sort((a, b) => b.callsPerF - a.callsPerF) });
  }, ${secs} * 1000);
})`);

let tc = 0, tt = 0;
console.log(`frames sampled: ${rows.frames}`);
console.log('--- per render-pass ---');
for (const p of rows.passes) {
  console.log(`${String(p.callsPerF).padStart(7)} calls/f  ${String(p.trisPerF).padStart(8)} tris/f  ${String(p.rendersPerF).padStart(5)} rend/f  ${String(p.callsPerRender).padStart(6)} c/r  ${p.pass}`);
}
console.log('--- per object bucket ---');
for (const r of rows.rows) {
  tc += r.calls; tt += r.tris;
  console.log(`${String(r.calls).padStart(7)} calls/f  ${String(r.tris).padStart(8)} tris/f  ${String(r.objs).padStart(3)} objs  ${r.bucket}`);
}
console.log(`${'='.repeat(70)}\\nTOTAL ${tc.toFixed(1)} calls/f  ${tt} tris/f`);
await closeClient(c); stack.down();
