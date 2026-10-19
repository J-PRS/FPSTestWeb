/* oxlint-disable no-console */
/** dualDiff — the desync oracle as a gate. Runs a full dual capture
 *  (headless client demo + server FPS_DEMO flush of the same match),
 *  diffs them, and asserts replica fidelity bounds. Fails the run when
 *  any shared seat's divergence regresses into ghost territory.
 *
 *  Requires an FPS_DEMO'd server on DUAL_PORT (default 8477 — :8000 is
 *  usually owned by the dev babysitter without the env):
 *    FPS_PORT=8477 FPS_DEMO=demos_out/server bun server_bun/dev-watch.ts
 *    bun _tools/e2e/dualDiff.ts
 */
import { launchClient, closeClient } from './browser.ts';
import { writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';

const PORT = process.env.DUAL_PORT ?? '8477';
const ROOM = `ddiff_${Date.now().toString(36)}`;
const SECONDS = Number(process.env.DUAL_SECONDS ?? 45);

console.log(`room ${ROOM} on :${PORT} — ${SECONDS}s capture`);
const c = await launchClient(`http://localhost:5400/s/${ROOM}?server=localhost:${PORT}&mode=ctf&bots=8`);
await c.waitFor(`window.__test && window.__test.demoManager && window.__test.networkManager.isConnected()`, 45000);
await new Promise((r) => setTimeout(r, SECONDS * 1000));
const b64 = await c.page.evaluate(`(async () => {
  const dm = window.__test.demoManager;
  const f = dm.recorder.buildDemoFile('dualDiff gate');
  const { serializeDemo } = await import('/src/demo/demoWriter.js');
  const buf = new Uint8Array(serializeDemo(f));
  let s = ''; const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) {s += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + CH)));}
  return btoa(s);
})()`);
await closeClient(c);
mkdirSync('demos_out', { recursive: true });
writeFileSync('demos_out/dual_client.demo', Buffer.from(b64, 'base64'));

// Graceful shutdown flushes every room demo.
try { execSync(`curl -s http://localhost:${PORT}/dev/shutdown`); } catch { /* server may close fast */ }
await new Promise((r) => setTimeout(r, 3000));
// A room can flush twice (dispose on empty → re-mint on a stray join →
// shutdown) — the largest file is the one that captured the match.
const srv = readdirSync('demos_out/server')
  .filter((f): boolean => f.startsWith(`${ROOM}-`))
  .map((f): [string, number] => [f, statSync(`demos_out/server/${f}`).size])
  .sort((a, b): number => b[1] - a[1])[0]?.[0];
if (!srv) { console.error(`FAIL — no server demo for ${ROOM} (is FPS_DEMO set on :${PORT}?)`); process.exit(1); }

const out = execSync(`bun _tools/demodiff.ts demos_out/dual_client.demo "demos_out/server/${srv}"`).toString();
console.log(out);
// Gate: parse the seat table — meanΔ and p95 bounds. Post-fix healthy:
// means ~6-14m, p95 ≤57m. The treadmill regression was 57-199m mean /
// ~490m p95, so these bounds have clear separation.
let worstMean = 0, worstP95 = 0;
for (const m of out.matchAll(/^\S+\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/gm)) {
  worstMean = Math.max(worstMean, Number(m[2]));
  worstP95 = Math.max(worstP95, Number(m[3]));
}
if (worstMean > 25 || worstP95 > 100) {
  console.error(`FAIL — replica divergence regressed: worst mean ${worstMean.toFixed(1)}m, p95 ${worstP95.toFixed(1)}m`);
  process.exit(1);
}
console.log(`PASS — worst seat mean ${worstMean.toFixed(1)}m, p95 ${worstP95.toFixed(1)}m (interp lag at ski speeds)`);
