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

/** Other agents' listeners hold scattered ports — probe upward until one binds.
 *  TCP health alone isn't enough: a stale process may still own the UDP port
 *  (WebTransport shares the port number), which leaves wt clients talking to
 *  the stale server. Reject a port whose log reports a failed WT bind. */
async function spawnGameServer(procs: Subprocess[], from: number): Promise<number> {
  for (let port = from; port < from + 60; port++) {
    const proc = spawn([process.execPath, 'src/server.ts'], {
      cwd: `${REPO}server_bun`,
      env: { ...process.env, FPS_PORT: String(port) },
      stdout: 'pipe', stderr: 'pipe',
    });
    procs.push(proc);
    // Drain stdout for the life of the proc (a full pipe stalls the child),
    // keeping only the early bytes needed for the WT-bind verdict.
    let earlyLog = '';
    const drain = (async () => {
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        earlyLog += dec.decode(value);
        if (earlyLog.length > 8192) earlyLog = earlyLog.slice(-8192);
      }
    })();
    void drain;
    try {
      await waitHttp(`http://localhost:${port}/health`, 4000);
      // WT's bind verdict lands a few seconds in — wait for either outcome
      // before trusting the port ('WebTransport listening' or a failure).
      // 'disabled'/'unavailable' are intentional (no certs) — valid port.
      const verdict = /WebTransport (listening|server failed to start|disabled|addon unavailable)|EADDRINUSE/;
      const t0 = Date.now();
      while (!verdict.test(earlyLog) && Date.now() - t0 < 10000) await sleep(200);
      if (/failed to start|EADDRINUSE/.test(earlyLog)) { procs.pop()?.kill(); continue; }
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
