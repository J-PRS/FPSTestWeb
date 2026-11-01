import { launchClient, closeClient } from './browser.ts';
import { spawn } from 'bun';
const vite = spawn(['npx.cmd','vite','--port','5467','--strictPort'],{cwd:'client',stdout:'ignore',stderr:'ignore'});
try {
  for (let i=0;i<100;i++){try{if((await fetch('http://localhost:5467/')).ok)break;}catch{}await new Promise(r=>setTimeout(r,300));}
  const c = await launchClient('http://localhost:5467/posedump.html?pmodel=scout&state=run&t=0.5',{});
  await new Promise(r=>setTimeout(r,5000));
  console.log('fetch class_anims:', await c.page.evaluate(`fetch('/assets/models/class_anims.glb').then(r=>r.status+'/'+r.headers.get('content-length')).catch(e=>String(e))`));
  console.log('fetch class_scout:', await c.page.evaluate(`fetch('/assets/models/class_scout.glb').then(r=>r.status).catch(e=>String(e))`));
  console.log('glb parse:', await c.page.evaluate(`(async()=>{const {GLTFLoader}=await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js').catch(e=>({err:String(e)})); return 'import-ok';})()`));
  await closeClient(c);
} finally { vite.kill(); }
