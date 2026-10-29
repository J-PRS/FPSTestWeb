// structlab — katastand + genhouse rendered in the gunlab inspect rig
// (fit camera, real lighting) so the surface patch is judgeable up close.
import { upStack } from './env.ts';
import { launchClient, closeClient } from './browser.ts';

const stack = await upStack();
try {
  const c = await launchClient(stack.clientUrl('').replace('?', '/gunlab.html?'),
    { preload: "localStorage.setItem('gunlab', JSON.stringify({pick:'katastand', cat:'structures', inspect:true}))" });
  await new Promise(r => setTimeout(r, 12000));
  await c.page.screenshot({ path: '_tools/e2e/shots/lab_kata.png' });
  await c.page.evaluate("localStorage.setItem('gunlab', JSON.stringify({pick:'genhouse', cat:'structures', inspect:true})); location.reload()");
  await new Promise(r => setTimeout(r, 12000));
  await c.page.screenshot({ path: '_tools/e2e/shots/lab_genhouse.png' });
  console.log('lab shots saved');
  await closeClient(c);
} finally { await stack.down(); }
