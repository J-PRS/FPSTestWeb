// maplab shot: desiccator with the scramble verb — A/B for the phase-scramble.
import { launchClient, closeClient } from './browser.js';

const c = await launchClient('http://localhost:5400/maplab.html');
await c.page.evaluateOnNewDocument((): void => {
  localStorage.setItem('maplab', JSON.stringify({ map: 'buttes' }));
});
await c.page.goto('http://localhost:5400/maplab.html', { waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 16000));
await c.page.screenshot({ path: '_tools/e2e/shots/buttes.png' });
console.log('shot saved');
await closeClient(c);
