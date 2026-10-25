import { launchClient, closeClient } from './e2e/browser.ts';
const c = await launchClient('http://localhost:5400/gunlab.html', {});
c.page.on('console', (m: any) => console.log('[con]', m.text().slice(0, 300)));
c.page.on('pageerror', (e: any) => console.log('[err]', String(e).slice(0, 600)));
await new Promise(r => setTimeout(r, 15000));
let r = await c.page.evaluate(`(() => {
  const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.text === 'classes'));
  sel.value = [...sel.options].find(o => o.text === 'classes').value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return 'classes set'; })()`);
console.log(r);
await new Promise(r2 => setTimeout(r2, 2000));
r = await c.page.evaluate(`(() => {
  const els = [...document.querySelectorAll('div,li,option,span,button')].filter(e => e.textContent?.trim() === 'jugg vs og');
  if (els[0]) { els[0].click(); return 'clicked'; }
  return 'not found: ' + [...document.querySelectorAll('div,li')].map(e => e.textContent?.trim()).filter(t => t && t.length < 20).slice(0, 40).join('|'); })()`);
console.log(r);
await new Promise(r2 => setTimeout(r2, 30000));
await c.page.screenshot({ path: 'e2e/shots/gunlab-jugg.png' });
await closeClient(c);
