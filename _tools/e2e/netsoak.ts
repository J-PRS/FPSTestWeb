/**
 * netsoak.ts — networked real-match fidelity soak.
 *
 *   LOG_LEVEL=debug bun _tools/e2e/netsoak.ts [--secs 120] [--bots 12] [--map lagoon]
 *
 * One headless client joins a bot-populated CTF room on a REAL server
 * over the wire. Collects the three fidelity signals a matchSim can't
 * see: client DESYNC audit lines (replica vs server divergence), the
 * server 'Room health' funnel (claims/rejects/applied damage — dropped
 * damage instances show up here), and /metrics tick-lag at the end.
 * LOG_LEVEL=debug is required or the Room health lines never print.
 */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const arg = (name: string, dflt: string): string =>
  process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1]! : dflt;
const SECS = Number(arg('secs', '120'));
const BOTS = arg('bots', '12');
const MAP = arg('map', 'lagoon');

const desync: string[] = [];
const warns: string[] = [];
const prof: string[] = [];
const glitches = new Map<string, number>();
const glitchFirst = new Map<string, string>();
const stack = await upStack();
const tNav = Date.now();
const client = await launchClient(stack.clientUrl(`&room=netsoak&map=${MAP}&bots=${BOTS}&mode=ctf&net=ws`));
client.page.on('console', (m) => {
  const t = m.text();
  if (t.includes('DESYNC')) desync.push(t.slice(0, 300));
  else if (t.includes('[PROFILE]')) prof.push(t);
  else if (t.includes('[GLITCH:')) {
    const tag = /GLITCH:([a-z-]+)/.exec(t)?.[1] ?? '?';
    glitches.set(tag, (glitches.get(tag) ?? 0) + 1);
    if (!glitchFirst.has(tag)) glitchFirst.set(tag, t.slice(0, 200));
  }
  else if (m.type() === 'warning' || m.type() === 'error') warns.push(t.slice(0, 200));
});

try {
  try {
    await client.waitFor(`t.networkManager && t.networkManager.isConnected()`, 60000);
  } catch {
    const st = await client.test(`({
      ready: document.readyState, hasT: !!window.__test,
      hasNm: !!(window.__test && window.__test.networkManager),
      conn: !!(window.__test && window.__test.networkManager && window.__test.networkManager.isConnected()),
      marks: performance.getEntriesByType('mark').map(m => m.name + ':' + Math.round(m.startTime)),
    })`).catch((e) => ({ err: String(e) }));
    console.log('boot state at timeout:', JSON.stringify(st));
    throw new Error('no connect');
  }
  const tConn = Date.now() - tNav;
  await client.waitFor(`t.world.remotePlayers.entities.size >= 1`, 30000);
  console.log(`\n=== boot ===`);
  console.log(`nav→connected: ${tConn}ms wall`);
  // Console lines fire before our handler attaches; the marks persist —
  // read them out of the page directly.
  const marks = await client.test<[string, number][]>(
    `performance.getEntriesByType('mark').filter(m => m.name.startsWith('load:')).map(m => [m.name.slice(5), Math.round(m.startTime)])`);
  let prev = 0;
  for (const [name, t] of marks) { console.log(`  ${name}: +${t - prev}ms (total ${t}ms)`); prev = t; }
  for (const l of prof) console.log(`  ${l}`);
  const remotes = await client.test<number>(`t.world.remotePlayers.entities.size`);
  console.log(`room populated (${remotes} remotes) — soaking ${SECS}s wall`);

  await new Promise((r) => setTimeout(r, SECS * 1000));

  const metrics = await stack.serverMetrics();
  console.log('\n=== metrics ===');
  console.log(JSON.stringify(metrics, null, 1).slice(0, 2000));

  const log = stack.serverLog();
  const health = log.split('\n').filter((l) => l.includes('Room health'));
  const rejects = log.split('\n').filter((l) => /reject|dropped|refus/i.test(l));
  console.log(`\n=== server log ===`);
  console.log(`Room health lines: ${health.length}`);
  for (const l of health.slice(-3)) console.log(`  ${l.slice(0, 300)}`);
  console.log(`reject/dropped lines: ${rejects.length}`);
  for (const l of rejects.slice(0, 8)) console.log(`  ${l.slice(0, 240)}`);

  console.log(`\n=== client ===`);
  console.log(`DESYNC warns: ${desync.length}`);
  for (const l of desync.slice(0, 8)) console.log(`  ${l}`);
  console.log(`GLITCH counts:`);
  for (const [tag, n] of [...glitches].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${tag}: ${n}  e.g. ${glitchFirst.get(tag)}`);
  }
  console.log(`other warns: ${warns.length}`);
  for (const l of warns.slice(0, 8)) console.log(`  ${l}`);
} finally {
  console.log('\n=== server log tail ===');
  console.log(stack.serverLog().split('\n').slice(-30).join('\n'));
  await closeClient(client);
  stack.down();
}
