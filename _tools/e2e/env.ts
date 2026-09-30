/**
 * env.ts — spawn the dev stack for E2E specs: vite dev server + bun game
 * server on dedicated ports, ready-waited, killed on exit.
 *
 * Specs call `stack = await upStack()` → `stack.clientUrl(room)` → down.
 */
import { spawn, type Subprocess } from 'bun';

const REPO = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

export interface Stack {
  clientPort: number;
  serverPort: number;
  clientUrl(extra?: string): string;
  serverMetrics(): Promise<Record<string, unknown>>;
  down(): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitHttp(url: string, timeoutMs = 30000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${url}`);
    await sleep(300);
  }
}

/** Other agents' listeners hold scattered ports — probe upward until one binds. */
async function spawnGameServer(procs: Subprocess[], from: number): Promise<number> {
  for (let port = from; port < from + 60; port++) {
    procs.push(spawn([process.execPath, 'src/server.ts'], {
      cwd: `${REPO}server_bun`,
      env: { ...process.env, FPS_PORT: String(port) },
      stdout: 'ignore', stderr: 'ignore',
    }));
    try {
      await waitHttp(`http://localhost:${port}/health`, 4000);
      return port;
    } catch {
      procs.pop()?.kill();
    }
  }
  throw new Error('no free port for game server');
}

export async function upStack(opts: { clientPort?: number; serverPort?: number } = {}): Promise<Stack> {
  const procs: Subprocess[] = [];
  const down = () => { for (const p of procs) { try { p.kill(); } catch { /* already dead */ } } };

  const serverPort = opts.serverPort ?? await spawnGameServer(procs, 8477);

  const clientPort = await (async () => {
    if (opts.clientPort) return opts.clientPort;
    for (let port = 5399; port < 5459; port++) {
      const p = spawn(['npx', 'vite', '--port', String(port), '--strictPort'], {
        cwd: `${REPO}client`,
        env: { ...process.env },
        stdout: 'ignore', stderr: 'ignore',
      });
      procs.push(p);
      try {
        await waitHttp(`http://localhost:${port}/`, 8000);
        return port;
      } catch {
        procs.pop()?.kill();
      }
    }
    throw new Error('no free port for vite');
  })();

  return {
    clientPort,
    serverPort,
    clientUrl: (extra = '') => `http://localhost:${clientPort}/?server=localhost:${serverPort}${extra}`,
    serverMetrics: async () => (await fetch(`http://localhost:${serverPort}/metrics`)).json() as Promise<Record<string, unknown>>,
    down,
  };
}
