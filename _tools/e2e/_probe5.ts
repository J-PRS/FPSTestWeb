import { launchClient, closeClient } from './browser.ts';
import { spawn } from 'bun';
const vite = spawn(['npx.cmd','vite','--port','5470','--strictPort'],{cwd:'client',stdout:'ignore',stderr:'ignore'});
try {
  for (let i=0;i<100;i++){try{if((await fetch('http://localhost:5470/')).ok)break;}catch{}await new Promise(r=>setTimeout(r,300));}
  const c = await launchClient('http://localhost:5470/posedump.html?pmodel=scout&state=run&t=0.5',{});
  await new Promise(r=>setTimeout(r,6000));
  const out = await c.page.evaluate(`(async()=>{
    const m = await import('/src/gltfLoad.ts').catch(e=>null);
    if (!m) {return 'import-fail';}
    const L = m.mkGltfLoader();
    try {
      const g = await Promise.race([L.loadAsync('/assets/models/class_anims.glb'), new Promise((_,rj)=>setTimeout(()=>rj(new Error('anims-timeout-8s')),8000))]);
      return 'anims ok clips='+g.animations.length;
    } catch(e) { return 'anims FAIL: '+String(e&&e.message||e).slice(0,200); }
  })()`);
  console.log('page:', out);
  console.log('ready=', await c.page.evaluate('window.__ready'), 'clips=', await c.page.evaluate('window.__clips && window.__clips.length'));
  await closeClient(c);
} finally { vite.kill(); }
