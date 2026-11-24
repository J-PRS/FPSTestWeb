/**
 * _progdiff.ts — which program variants get CREATED post-veil.
 * Snapshots renderer.info.programs at veil drop, diffs 12s later,
 * prints name+first-use cost attribution for the prewarm inventory.
 *   E2E_GPU=1 bun _tools/e2e/_progdiff.ts [--secs 45]
 */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const arg = (n: string, d: string): string =>
  process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d;
const SECS = +arg('secs', '45');

const stack = await upStack();
const c = await launchClient(stack.clientUrl('&room=progdiff&map=lagoon&bots=4&debug'), { width: 1280, height: 800 });

// Wait for veil drop, snapshot
await c.page.waitForFunction((): boolean => performance.getEntriesByName('load:veilDropped').length > 0, { timeout: 60000 });
const snap = await c.page.evaluate((): { keys: string[]; names: string[] } => {
  const r = (window as unknown as { __renderer: { info: { programs: { cacheKey: string; name: string }[] } } }).__renderer;
  return { keys: r.info.programs.map((p) => p.cacheKey), names: r.info.programs.map((p) => p.name) };
});
console.log(`at veil drop: ${snap.keys.length} programs`);

await new Promise((r): NodeJS.Timeout => setTimeout(r, 12000));
const post = await c.page.evaluate((): { keys: string[]; names: string[] } => {
  const r = (window as unknown as { __renderer: { info: { programs: { cacheKey: string; name: string }[] } } }).__renderer;
  return { keys: r.info.programs.map((p) => p.cacheKey), names: r.info.programs.map((p) => p.name) };
});
const pre = new Set(snap.keys);
const newIdx = post.keys.map((k, i): number => (pre.has(k) ? -1 : i)).filter((i): boolean => i >= 0);
console.log(`12s post-veil: ${post.keys.length} programs, ${newIdx.length} created post-veil`);
for (const i of newIdx.slice(0, 25)) {
  const key = post.keys[i]!;
  // cacheKey fragments that identify the material shape
  const frags = ['instancing', 'skinning', 'USE_FOG', 'shadowMapType', 'numDirLights', 'vertexColors', 'map:'].filter((f): boolean => key.includes(f));
  console.log(`  + ${post.names[i]} | ${key.slice(0, 110)}`);
}
await closeClient(c);
await stack.down();
process.exit(0);
