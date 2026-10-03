// Offline anim bake driver: compile bake.ts (+ its client/src imports)
// to plain JS under client/.animbake-tmp, then run it with node.
//   node _tools/animbake/run.mjs
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const client = path.resolve(here, '../../client');
const tsc = path.join(client, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');

const compile = spawnSync(tsc, [
  path.join(here, 'bake.ts'), '--ignoreConfig',
  '--outDir', '.animbake-tmp', '--rootDir', '..',
  '--module', 'nodenext', '--moduleResolution', 'nodenext',
  '--target', 'es2023', '--skipLibCheck',
], { cwd: client, stdio: ['inherit', 'ignore', 'inherit'] });
if (compile.status !== 0 && compile.status === null) process.exit(1);

// tsc emits despite the (expected) type-resolution warnings — the output
// is what matters.
const r = spawnSync(process.execPath, ['.animbake-tmp/_tools/animbake/bake.js'], { cwd: client, stdio: 'inherit' });
process.exit(r.status ?? 1);
