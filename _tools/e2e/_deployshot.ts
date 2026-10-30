// Gunlab preview verify for the instanced deployables — seeds pick into
// localStorage before the page boots, reloads, screenshots.
import { launchClient, closeClient } from './browser.ts';
const pick = process.argv[2] ?? 'mortar';
const client = await launchClient('http://localhost:5400/gunlab.html');
try {
  await client.page.evaluateOnNewDocument(`try{localStorage.setItem('gunlab','{"pick":"${pick}","wt":0,"inspect":false,"yaw":0.8,"pitch":0.15}')}catch(e){}`);
  await client.page.reload({ waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 9000));
  await client.page.screenshot({ path: `_deploy_${pick}.png` });
  console.log(`shot _deploy_${pick}.png`);
} finally { await closeClient(client); }
