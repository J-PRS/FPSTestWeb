import { launchClient, closeClient } from './e2e/browser.ts';
const c = await launchClient('http://localhost:5400/gunlab.html', {});
c.page.on('console', (m: any) => console.log('[con]', m.text().slice(0, 300)));
c.page.on('pageerror', (e: any) => console.log('[err]', String(e).slice(0, 600)));
await new Promise(r => setTimeout(r, 15000));
const r = await c.page.evaluate(`(() => {
  const sel = [...document.querySelectorAll('select')].map(s => ({v: s.value, opts: [...s.options].map(o => o.text)}));
  return sel; })()`);
console.log(JSON.stringify(r).slice(0, 1500));
const set = await c.page.evaluate(`(() => {
  const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.text === 'jugg vs og'));
  if (!sel) return 'no sel';
  sel.value = [...sel.options].find(o => o.text === 'jugg vs og').value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return 'set ' + sel.value; })()`);
console.log(set);
await new Promise(r2 => setTimeout(r2, 25000));
await c.page.screenshot({ path: 'e2e/shots/gunlab-jugg.png' });
await closeClient(c);
