/**
 * env.ts — spawn the dev stack for E2E specs: vite dev server + bun game
 * server on dedicated ports, ready-waited, killed on exit.
 *
 * Specs call `stack = await upStack()` → `stack.clientUrl(room)` → down.
 */
import { spawn, type Subprocess } from 'bun';
import dgram from 'node:dgram';

const REPO = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

export interface Stack {
  clientPort: number;
  serverPort: number;
  clientUrl(extra?: string): string;
  serverMetrics(): Promise<Record<string, unknown>>;
  /** Spawned server's drained stdout (capped) — join/spec diagnostics. */
  serverLog(): string;
  down(): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Drained stdout tails for the current upStack's game-server spawns. */
const serverLogBufs: { log: string }[] = [];

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
/** WebTransport shares the TCP port number on UDP — a stale server that
 *  owns UDP:<port> would hijack wt clients even though our TCP bind won.
 *  Probe the UDP side directly (the server's own WT bind verdict is too
 *  flaky on Windows to trust as the port gate). */
function udpFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = dgram.createSocket('udp4');
    s.once('error', () => { s.close(); res(false); });
    s.once('listening', () => { s.close(); res(true); });
    s.bind(port, '0.0.0.0');
  });
}

async function spawnGameServer(procs: Subprocess[], from: number): Promise<number> {
  for (let port = from; port < from + 60; port++) {
    if (!await udpFree(port)) continue;
    const proc = spawn([process.execPath, 'src/server.ts'], {
      cwd: `${REPO}server_bun`,
      env: { ...process.env, FPS_PORT: String(port) },
      stdout: 'pipe', stderr: 'pipe',
    });
    procs.push(proc);
    // Drain stdout for the life of the proc (a full pipe stalls the child),
    // keeping only the early bytes needed for the WT-bind verdict.
    let earlyLog = '';
    serverLogBufs.push({ get log() { return earlyLog; } });
    const dec = new TextDecoder();
    const drain = async (stream: ReadableStream<Uint8Array> | null) => {
      if (!stream) return;
      const reader = stream.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        earlyLog += dec.decode(value);
        if (earlyLog.length > 65536) earlyLog = earlyLog.slice(-65536);
      }
    };
    void drain(proc.stdout as ReadableStream<Uint8Array>);
    // logger.warn/error go to stderr — drain it or warns are invisible
    // AND a full stderr pipe eventually stalls the child.
    void drain(proc.stderr as ReadableStream<Uint8Array>);
    try {
      await waitHttp(`http://localhost:${port}/health`, 4000);
      // waitHttp answers on ANY listener — a stale server from an earlier
      // run (killed npx wrapper orphans the real process on Windows) would
      // pass the check while our spawn dies on EADDRINUSE. If our child
      // already exited, the port belongs to a ghost — move on.
      await sleep(300);
      if (proc.exitCode !== null) { continue; }
      // WT's bind verdict lands a few seconds in — wait for either outcome
      // before trusting the port ('WebTransport listening' or a failure).
      // 'disabled'/'unavailable' are intentional (no certs) — valid port;
      // 'failed to start' is fine now that udpFree pre-checks the UDP side.
      const verdict = /WebTransport (listening|server failed to start|disabled|addon unavailable)|EADDRINUSE/;
      const t0 = Date.now();
      while (!verdict.test(earlyLog) && Date.now() - t0 < 10000) await sleep(200);
      if (/EADDRINUSE/.test(earlyLog)) { procs.pop()?.kill(); continue; }
      return port;
    } catch {
      procs.pop()?.kill();
    }
  }
  throw new Error('no free port for game server');
}

export async function upStack(opts: { clientPort?: number; serverPort?: number } = {}): Promise<Stack> {
  const procs: Subprocess[] = [];
  serverLogBufs.length = 0;
  const down = () => { for (const p of procs) { try { p.kill(); } catch { /* already dead */ } } };

  const serverPort = opts.serverPort ?? await spawnGameServer(procs, 8477);

  const clientPort = await (async () => {
    if (opts.clientPort) return opts.clientPort;
    for (let port = 5399; port < 5459; port++) {
      // Windows: npx is a .cmd shim, uv_spawn needs the explicit filename.
      const p = spawn([process.platform === 'win32' ? 'npx.cmd' : 'npx', 'vite', '--port', String(port), '--strictPort'], {
        cwd: `${REPO}client`,
        env: { ...process.env },
        stdout: 'ignore', stderr: 'ignore',
      });
      procs.push(p);
      try {
        await waitHttp(`http://localhost:${port}/`, 8000);
        // Same ghost-listener guard as the game server — a stale vite
        // serves old code while our strictPort spawn has already died.
        await sleep(300);
        if (p.exitCode !== null) continue;
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
    // 127.0.0.1 not localhost: Chrome resolves localhost→::1 first, and a
    // stale server bound on IPv6 loopback would silently win the ws while
    // IPv4 probes hit the spawned server — a split-brain that hid real
    // bugs for hours.
    clientUrl: (extra = '') => `http://localhost:${clientPort}/?server=127.0.0.1:${serverPort}${extra}`,
    serverMetrics: async () => (await fetch(`http://localhost:${serverPort}/metrics`)).json() as Promise<Record<string, unknown>>,
    serverLog: () => serverLogBufs.map(b => b.log).join('\n'),
    down,
  };
}
