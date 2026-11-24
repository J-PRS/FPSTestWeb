/** _prodshot.ts — open a URL (prod by default) in real Chrome, capture a
 * screenshot + console errors + failed requests. For eyeballing deploys. */
import { launchClient, closeClient } from './browser.ts';

const url = process.argv[2] ?? 'https://anabatic.gg/?mode=classic&map=ballroom';
const shot = process.argv[3] ?? '_scratch/prodshot.png';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const client = await launchClient(url);
const errs: string[] = [];
client.page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
client.page.on('requestfailed', (r) => errs.push(`REQFAIL ${r.url().slice(0, 160)} ${r.failure()?.errorText ?? ''}`));
client.page.on('response', (r) => { if (r.status() >= 400) errs.push(`HTTP${r.status()} ${r.url().slice(0, 160)}`); });

await sleep(25_000);
await client.page.screenshot({ path: shot });
console.log('shot:', shot);
console.log('errors:', errs.length ? errs.slice(0, 20).join('\n  ') : '(none)');
await closeClient(client);
