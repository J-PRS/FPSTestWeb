// CPU profile under 5x throttle on the LIVE server room — real remotes,
// real phases. CDP Profiler.start → stop, then self-time attribution
// per (function,url,line). No phase guesses — actual hot functions.
import { launchClient, closeClient } from './browser.ts';
const secs = Number(process.argv[2] ?? 15);
const throttle = Number(process.argv[3] ?? 5);
const url = (process.argv[4] && process.argv[4] !== '-') ? process.argv[4] : 'http://localhost:5400/quickjoin?server=127.0.0.1:8000&mode=ctf&bots=16';
const settle = Number(process.argv[5] ?? 20);
const client = await launchClient(url);
try {
  await client.page.waitForFunction('window.__test && window.__test.player', { timeout: 120000 });
  const cdp = await client.page.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  await new Promise(r => setTimeout(r, settle * 1000)); // remotes/models load BEFORE the window
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.start');
  await new Promise(r => setTimeout(r, secs * 1000));
  const { profile } = await cdp.send('Profiler.stop');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  const self = new Map<string, { name: string; url: string; line: number; us: number; hits: number }>();
  const nodes = new Map<number, any>();
  for (const n of profile.nodes) {nodes.set(n.id, n);}
  // samples[i] hit during timeDeltas[i] us — attribute to the LEAF node
  for (let i = 0; i < (profile.samples ?? []).length; i += 1) {
    const id = profile.samples[i];
    const dt = profile.timeDeltas[i] ?? 0;
    const n = nodes.get(id);
    if (!n) {continue;}
    const cf = n.callFrame;
    const base = cf.url.split('/').pop() ?? '?';
    const key = `${cf.functionName || '(anon)'}|${base}:${cf.lineNumber + 1}`;
    const row = self.get(key) ?? { name: cf.functionName || '(anon)', url: base, line: cf.lineNumber + 1, us: 0, hits: 0 };
    row.us += dt; row.hits += 1;
    self.set(key, row);
  }
  const total = [...self.values()].reduce((s, r) => s + r.us, 0);
  const top = [...self.values()].sort((a, b) => b.us - a.us).slice(0, 60);
  console.log(JSON.stringify({
    total_ms: Math.round(total / 1000),
    throttle, secs,
    rows: top.map(r => ({ fn: r.name, file: `${r.url}:${r.line}`, ms: +(r.us / 1000).toFixed(1), pct: +(r.us / total * 100).toFixed(1) })),
  }, null, 1));
} finally { await closeClient(client); }
