import { launchClient, closeClient } from './browser.ts';
import { spawn } from 'bun';
const vite = spawn(['npx.cmd','vite','--port','5466','--strictPort'],{cwd:'client',stdout:'ignore',stderr:'ignore'});
try {
  for (let i=0;i<100;i++){try{if((await fetch('http://localhost:5466/')).ok)break;}catch{}await new Promise(r=>setTimeout(r,300));}
  const c = await launchClient('http://localhost:5466/posedump.html?pmodel=scout&state=run&t=0.5',{});
  c.page.on('pageerror',(e)=>console.log('PAGEERR',String(e).slice(0,300)));
  c.page.on('console',(m)=>{const t=m.type(); if(t==='error'||t==='warning')console.log(t.toUpperCase(),m.text().slice(0,300));});
  await new Promise(r=>setTimeout(r,15000));
  console.log('ready=', await c.page.evaluate('window.__ready'), 'clips=', await c.page.evaluate('window.__clips && window.__clips.length'));
  await closeClient(c);
} finally { vite.kill(); }
