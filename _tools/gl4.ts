import { launchClient, closeClient } from './e2e/browser.ts';
const c = await launchClient('http://localhost:5400/gunlab.html', {});
c.page.on('pageerror', (e: any) => console.log('[err]', String(e).slice(0, 600)));
const t0 = Date.now();
await new Promise(r => setTimeout(r, 12000));
await c.page.evaluate(`(() => {
  const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.text === 'classes'));
  sel.value = 'classes'; sel.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await new Promise(r => setTimeout(r, 1500));
await c.page.evaluate(`(() => {
  const els = [...document.querySelectorAll('div,li,option,span,button')].filter(e => e.textContent?.trim() === 'jugg vs og');
  els[0]?.click(); })()`);
for (let i = 0; i < 12; i++) {
  await new Promise(r => setTimeout(r, 5000));
  const vis = await c.page.evaluate(`(() => {
    const cnv = document.querySelector('canvas');
    return cnv ? 'canvas ' + cnv.width + 'x' + cnv.height : 'none'; })()`);
  console.log(((Date.now()-t0)/1000).toFixed(0)+'s', vis);
}
await c.page.screenshot({ path: 'e2e/shots/gunlab-jugg.png' });
await closeClient(c);
