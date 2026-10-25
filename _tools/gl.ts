import { launchClient, closeClient } from './e2e/browser.ts';
const c = await launchClient('http://localhost:5400/gunlab.html', {});
c.page.on('console', (m: any) => console.log('[con]', m.text().slice(0, 300)));
c.page.on('pageerror', (e: any) => console.log('[err]', String(e).slice(0, 600)));
await new Promise(r => setTimeout(r, 30000));
// click 'jugg vs og' if the lineup menu is DOM
const clicked = await c.page.evaluate(`(() => {
  const els = [...document.querySelectorAll('*')].filter(e => e.children.length === 0 && e.textContent?.trim() === 'jugg vs og');
  if (els[0]) { els[0].click(); return 'clicked'; }
  return 'not found'; })()`);
console.log('menu:', clicked);
await new Promise(r => setTimeout(r, 20000));
await c.page.screenshot({ path: '_tools/e2e/shots/gunlab-jugg.png' });
await closeClient(c);
