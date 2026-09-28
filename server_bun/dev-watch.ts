/**
 * Dev runner: `bun dev-watch.ts` — bun's own --watch only follows imports
 * under its entry dir, so shared/ changes never restart the server even
 * though they're protocol-critical. This wrapper spawns the server and
 * restarts the child when any file under ../shared (or ./src) changes.
 *
 * Debounced: saves that touch many files (formatter, branch switch)
 * collapse into one restart.
 */
import { spawn, type Subprocess } from 'bun';
import { watch } from 'fs';

const DIRS = ['src', '../shared'];
const DEBOUNCE_MS = 150;

let child: Subprocess | null = null;
let restarting = false;
let pending = false;

function boot(): void {
  child = spawn({ cmd: ['bun', 'src/server.ts'], stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' });
}

async function restart(): Promise<void> {
  if (restarting) { pending = true; return; }
  restarting = true;
  console.log('[dev-watch] restart — shared/ or src/ changed');
  child?.kill();
  await child?.exited;
  boot();
  restarting = false;
  if (pending) { pending = false; void restart(); }
}

for (const dir of DIRS) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  watch(dir, { recursive: true }, (_ev, file) => {
    if (!file || !file.endsWith('.ts')) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void restart(), DEBOUNCE_MS);
  });
}

boot();
console.log(`[dev-watch] watching ${DIRS.join(', ')} — editing shared/ restarts the server`);
