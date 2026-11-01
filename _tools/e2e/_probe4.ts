import { launchClient, closeClient } from './browser.ts';
import { spawn } from 'bun';
const vite = spawn(['npx.cmd','vite','--port','5469','--strictPort'],{cwd:'client',stdout:'ignore',stderr:'ignore'});
try {
  for (let i=0;i<100;i++){try{if((await fetch('http://localhost:5469/')).ok)break;}catch{}await new Promise(r=>setTimeout(r,300));}
  const c = await launchClient('http://localhost:5469/posedump.html?pmodel=scout&state=run&t=0.5',{});
  await new Promise(r=>setTimeout(r,6000));
  const out = await c.page.evaluate(`(async()=>{
    const m = await import('/src/gltfLoad.ts').catch(e=>null);
    if (!m) {return 'import-fail';}
    const L = m.mkGltfLoader();
    try {
      const g = await Promise.race([L.loadAsync('/assets/models/class_scout.glb'), new Promise((_,rj)=>setTimeout(()=>rj(new Error('scout-timeout-8s')),8000))]);
      return 'scout ok meshes='+g.scene.children.length+' anims='+g.animations.length;
    } catch(e) { return 'scout FAIL: '+String(e&&e.message||e).slice(0,200); }
  })()`);
  console.log('page:', out);
  await closeClient(c);
} finally { vite.kill(); }
