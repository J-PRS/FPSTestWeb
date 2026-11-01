import { launchClient, closeClient } from './browser.ts';
import { spawn } from 'bun';
const vite = spawn(['npx.cmd','vite','--port','5468','--strictPort','--force'],{cwd:'client',stdout:'ignore',stderr:'ignore'});
try {
  for (let i=0;i<100;i++){try{if((await fetch('http://localhost:5468/')).ok)break;}catch{}await new Promise(r=>setTimeout(r,300));}
  for (const pm of ['scout','brawler']) {
    const c = await launchClient(`http://localhost:5468/posedump.html?pmodel=${pm}&state=run&t=0.5`,{});
    await c.page.waitForFunction('window.__ready === true',{timeout:120000});
    const clips = await c.page.evaluate('window.__clips');
    console.log(pm, 'clips:', Array.isArray(clips)?clips.length:clips);
    await c.page.screenshot({path:`_tools/e2e/shots/${pm}-run.png`});
    await closeClient(c);
  }
} finally { vite.kill(); }
