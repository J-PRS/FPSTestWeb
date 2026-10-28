/**
 * all.ts — run the whole headless E2E suite in one command.
 *
 *   bun _tools/e2e/all.ts [--skip perf]
 *
 * Each spec boots its own stack (env.ts probes for free ports), so they
 * run sequentially in-process — parallel headless Chromes would contend
 * under SwiftShader and flake timing asserts. Exit code aggregates.
 */
import { spawn } from 'node:child_process';

if (process.env.E2E_GPU !== '1' && !process.env.CI) {
  console.warn('\\n[E2E] WARNING: E2E_GPU is not set — running on software rendering (SwiftShader).');
  console.warn('[E2E] This is SLOW (60-90s GLB loads) and flakes timing asserts.');
  console.warn('[E2E] Set E2E_GPU=1 for headless+GPU, or E2E_HEADED=1 for visible+GPU.\\n');
}

const SPECS = ['smoke.ts', 'duo.ts', 'duo_p2p.ts', 'lobby.ts', 'reconnect.ts', 'vgs.ts', 'overlap.ts', 'desyncsoak.ts', 'dualcheck.ts', 'mapswitch.ts', 'weather.ts', 'perf.ts'];
const skip = new Set(process.argv.slice(2).flatMap((a, i, arr) => a === '--skip' ? [arr[i + 1]] : []));
const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');

let failed = 0;
for (const spec of SPECS) {
  if (skip.has(spec.replace('.ts', ''))) { console.log(`SKIP ${spec}`); continue; }
  console.log(`\n=== ${spec} ===`);
  const args = spec === 'perf.ts' ? [spec, '--secs', '12'] : [spec];
  const code = await new Promise<number>((res) => {
    const p = spawn(process.execPath, [...args], { cwd: here, stdio: 'inherit' });
    p.on('exit', (c) => res(c ?? 1));
  });
  if (code !== 0) { failed++; console.log(`=== ${spec} FAILED (exit ${code}) ===`); }
}
console.log(`\n${SPECS.length - skip.size - failed}/${SPECS.length - skip.size} specs green`);
process.exit(failed ? 1 : 0);
