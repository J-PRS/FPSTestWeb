import { launchClient, closeClient } from './browser.ts';
import { spawn } from 'bun';
const vite = spawn(['npx.cmd','vite','--port','5463','--strictPort'],{cwd:'client',stdout:'ignore',stderr:'ignore'});
try {
  for (let i=0;i<100;i++){try{if((await fetch('http://localhost:5463/')).ok)break;}catch{}await new Promise(r=>setTimeout(r,300));}
  const c = await launchClient('http://localhost:5463/posedump.html?pmodel=scout&state=idle&t=0.5',{});
  await c.page.waitForFunction('window.__ready === true',{timeout:120000});
  await c.page.screenshot({path:'_tools/e2e/shots/scout-lit.png'});
  await closeClient(c);
} finally { vite.kill(); }
