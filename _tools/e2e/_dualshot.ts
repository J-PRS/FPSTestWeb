import { launchClient, closeClient } from './browser.ts';
import { spawn } from 'bun';
const vite = spawn(['npx.cmd','vite','--port','5462','--strictPort'],{cwd:'client',stdout:'ignore',stderr:'ignore'});
try {
  for (let i=0;i<100;i++){try{if((await fetch('http://localhost:5462/')).ok)break;}catch{}await new Promise(r=>setTimeout(r,300));}
  for (const [name,q] of [['lit',''],['unlit','&atlaslit=0']] as const) {
    const c = await launchClient(`http://localhost:5462/posedump.html?pmodel=scout&state=idle&t=0.5${q}`,{});
    await c.page.waitForFunction('window.__ready === true',{timeout:120000});
    await c.page.screenshot({path:`_tools/e2e/shots/scout-${name}.png`});
    await closeClient(c);
  }
} finally { vite.kill(); }
