/** _vmportrait.ts — aspect-aware viewmodel probe: boot a spawned stack,
 * screenshot landscape, resize to phone portrait, screenshot again. The
 * gun must stay in frame at ~60% of half-width both ways. */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stack = await upStack();
const client = await launchClient(stack.clientUrl('&mode=classic&map=ballroom'));
try {
  await client.page.setViewport({ width: 800, height: 600 });
  await client.waitFor('t.player && t.terrain', 90000);
  await sleep(4000);
  await client.page.screenshot({ path: '_scratch/vm_landscape.png' });
  await client.page.setViewport({ width: 412, height: 892 });
  await sleep(2500); // resize -> aspect sync -> pose lerp
  await client.page.screenshot({ path: '_scratch/vm_portrait.png' });
  // Numeric check: gun group x vs visible half-width at its depth
  const m = await client.page.evaluate(`(() => {
    const t = window.__test;
    const vm = t.viewModel ?? t.vm; const cam = vm.vmCam ?? null;
    return { aspect: cam ? cam.aspect : null, gx: vm ? vm.group.position.x : null };
  })()`);
  console.log('vm probe:', JSON.stringify(m));
  console.log('shots: _scratch/vm_landscape.png _scratch/vm_portrait.png');
} finally { await closeClient(client); await stack.down(); }
