// Park the lab camera outside the deployable and shoot.
import { launchClient, closeClient } from './browser.ts';
const pick = process.argv[2] ?? 'mortar';
const client = await launchClient('http://localhost:5400/gunlab.html');
try {
  await client.page.evaluateOnNewDocument(`try{localStorage.setItem('gunlab','{"pick":"${pick}","wt":0,"inspect":false,"yaw":0.8,"pitch":0.15,"cam":[3,2.2,3],"tgt":[0,1,0]}')}catch(e){}`);
  await client.page.reload({ waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 9000));
  await client.page.evaluate(`(() => { const g = window.__gunlab; g.camera.position.set(3, 2.2, 3); g.camera.lookAt(0, 1, 0); })()`);
  await new Promise(r => setTimeout(r, 500));
  await client.page.evaluate(`(() => { const g = window.__gunlab; g.camera.position.set(3, 2.2, 3); g.camera.lookAt(0, 1, 0); })()`);
  await client.page.screenshot({ path: `_deploy_${pick}.png` });
  console.log(`shot _deploy_${pick}.png`);
} finally { await closeClient(client); }
