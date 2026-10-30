// Phone profiler — attach to the game page on the USB-connected phone via
// CDP (adb forward tcp:9333 localabstract:chrome_devtools_remote), navigate
// it into a live ctf bot match, then sample Performance metrics + rAF fps +
// __test every 15s. One 15s devtools.timeline trace mid-run names the hot
// main-thread functions.   bun _tools/e2e/_phoneprof.ts [wallSecs]
//
// Attaches to the PAGE target's webSocketDebuggerUrl over raw CDP — never
// playwright's connectOverCDP. Browser-level attach does Target.setAutoAttach
// on EVERY target incl. orphaned workers/empty-URL tabs; one wedged target
// stalls the handshake forever (agent-browser#87). Page attach can't stall.
import { writeFileSync } from 'node:fs';

const secs = Number(process.argv[2] ?? 90);
const PORT = 9333;

// --- minimal page-target CDP client -------------------------------------
const list = await (await fetch(`http://localhost:${PORT}/json`)).json() as
  { id: string; type: string; url: string; webSocketDebuggerUrl: string }[];
// freshest game page wins; fall back to any page so we can navigate it
const target = [...list].reverse().find(t => t.type === 'page' && t.url.includes('localhost:5400'))
  ?? [...list].reverse().find(t => t.type === 'page');
if (!target) { console.log('no page target'); process.exit(1); }
console.log('attached:', target.url);

const ws = new WebSocket(target.webSocketDebuggerUrl);
let seq = 0;
const pend = new Map<number, { res: (v: never) => void; rej: (e: Error) => void }>();
const listeners = new Map<string, ((p: unknown) => void)[]>();
const send = <T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
  new Promise((res, rej) => { const id = ++seq; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const on = (m: string, f: (p: unknown) => void): void => { listeners.set(m, [...listeners.get(m) ?? [], f]); };
ws.onmessage = (m: MessageEvent): void => {
  const d = JSON.parse(String(m.data)) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } };
  if (d.id && pend.has(d.id)) { const p = pend.get(d.id)!; pend.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result as never); }
  else if (d.method) { for (const f of listeners.get(d.method) ?? []) { f(d.params); } }
};
await new Promise(r => { ws.onopen = r; });
await send('Runtime.enable');
await send('Page.enable');
await send('Performance.enable');

const evalJs = async <T = unknown>(expr: string): Promise<T> => {
  const r = await send<{ result?: { value?: T }; exceptionDetails?: { text: string } }>(
    'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) { throw new Error(r.exceptionDetails.text); }
  return r.result?.value as T;
};

// rAF frame-time recorder — survives navigation because every stats read
// recreates it when missing. Runs on the phone's real compositor.
const inject = `(() => { const w = window; if (w.__ph) return; w.__ph = { frames: [] }; let last = performance.now(); const tick = () => { const now = performance.now(); w.__ph.frames.push(now - last); if (w.__ph.frames.length > 4096) w.__ph.frames.splice(0, w.__ph.frames.length - 4096); last = now; requestAnimationFrame(tick); }; requestAnimationFrame(tick); })()`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: inject });
if (target.url.includes('5400')) { await evalJs(inject); }

// waitForFunction equivalent — poll until the match seat lands
// (__test.player is the seat object; there is no scalar playerId).
{
  const t0 = Date.now();
  let ok = false;
  while (Date.now() - t0 < 90000) {
    ok = await evalJs('!!(window.__test && window.__test.player)').catch(() => false);
    if (ok) { break; }
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!ok) { console.log('WARN: no player within 90s — still on menu?'); }
}

const traceBuf: string[] = [];
on('Tracing.dataCollected', (p) => {
  for (const e of (p as { value?: { toString(): string }[] }).value ?? []) { traceBuf.push(String(e)); }
});

const stats = async (): Promise<void> => {
  const m = (await send<{ metrics: { name: string; value: number }[] }>('Performance.getMetrics')).metrics;
  const mm = Object.fromEntries(m.map(x => [x.name, x.value]));
  const s = await evalJs<Record<string, unknown>>(`(() => {
    const w = window;
    const f = w.__ph ? w.__ph.frames.splice(0) : []; f.sort((a, b) => a - b);
    const t = w.__test ?? {};
    return {
      fps: f.length ? Math.round(1000 / (f.reduce((a, b) => a + b, 0) / f.length)) : 0,
      p50: f[Math.floor(f.length * .5)]?.toFixed(1), p95: f[Math.floor(f.length * .95)]?.toFixed(1),
      seat: !!t.player, room: t.room, autoq: t.autoqLevel ?? t.gpuLevel, tickMs: t.tickMsAvg ?? t.tickMs,
      cv: (document.getElementById('gl') || {}).width,
    };
  })()`);
  console.log(`  fps=${s.fps} p50=${s.p50}ms p95=${s.p95}ms  Heap=${((mm.JSHeapUsedSize ?? 0) / 1048576).toFixed(0)}MB Nodes=${mm.Nodes}  cv=${s.cv} seat=${s.seat} autoq=${JSON.stringify(s.autoq)} tick=${s.tickMs}`);
};

let traced = false;
for (let t = 0; t < secs; t += 15) {
  await new Promise(r => setTimeout(r, 15000));
  await stats();
  if (!traced && t + 15 >= 45) {
    traced = true;
    console.log('  tracing 15s…');
    traceBuf.length = 0;
    await send('Tracing.start', { categories: 'devtools.timeline,v8.execute,blink.user_timing', transferMode: 'ReportEvents' });
    await new Promise(r => setTimeout(r, 15000));
    await send('Tracing.end');
    await new Promise(r => setTimeout(r, 2000)); // flush trailing dataCollected
    writeFileSync('_phone_trace.jsonl', traceBuf.join(''));
    // Aggregate self-time per function-ish event name.
    const selfTime = new Map<string, number>();
    for (const chunk of traceBuf) {
      for (const m of chunk.matchAll(/"name"\s*:\s*"([^"]+)"[^{}]*"dur"\s*:\s*(\d+)/g)) {
        const n = m[1]!, d = Number(m[2]);
        selfTime.set(n, (selfTime.get(n) ?? 0) + d);
      }
    }
    const top = [...selfTime.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    console.log('  top (us self):', top.map(([n, d]) => `${n.slice(0, 55)}=${d}`).join('  '));
    await stats();
  }
}
{
  const shot = await send<{ data: string }>('Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (shot) { writeFileSync('_phone.png', Buffer.from(shot.data, 'base64')); }
  else { console.log('screenshot failed (renderer busy)'); }
}
ws.close();
process.exit(0);
