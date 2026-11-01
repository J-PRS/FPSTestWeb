import { launchClient, closeClient } from './browser.ts';
import { spawn } from 'bun';
const vite = spawn(['npx.cmd','vite','--port','5465','--strictPort'],{cwd:'client',stdout:'ignore',stderr:'ignore'});
try {
  for (let i=0;i<100;i++){try{if((await fetch('http://localhost:5465/')).ok)break;}catch{}await new Promise(r=>setTimeout(r,300));}
  const c = await launchClient('http://localhost:5465/posedump.html?pmodel=scout&state=run&t=0.5',{});
  await new Promise(r=>setTimeout(r,15000));
  console.log('ready=', await c.page.evaluate('window.__ready'));
  const logs = await c.page.evaluate('window.__logs ? window.__logs.slice(-12) : "nologs"');
  console.log(JSON.stringify(logs).slice(0,2000));
  await closeClient(c);
} finally { vite.kill(); }
