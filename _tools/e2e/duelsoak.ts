/**
 * duelsoak.ts — two-client WAN soak: real bodies claiming against each
 * other over play.jprice.app. One client drives itself with ?autopilot
 * (real input fields, real claims); the other watches + also pilots.
 *
 *   E2E_GPU=1 bun _tools/e2e/duelsoak.ts [--secs 120] [--room headhunt-1]
 */
import { launchClient, closeClient } from './browser.ts';

const arg = (n: string, d: string): string =>
  process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d;
const SECS = Number(arg('secs', '120'));
const SERVER = arg('server', 'https://play.jprice.app');
const ROOM = arg('room', 'headhunt-1');
const CLIENT = arg('client', 'http://127.0.0.1:5500');
const url = `${CLIENT}/?debug&autopilot&server=${encodeURIComponent(SERVER)}&room=${encodeURIComponent(ROOM)}`;

const a = await launchClient(url);
const b = await launchClient(url);
try {
  for (const [tag, c] of [['A', a], ['B', b]] as const) {
    await c.waitFor(`t.networkManager && t.networkManager.isConnected()`, 60000);
    console.log(`${tag} connected`);
  }
  await new Promise((r) => setTimeout(r, 15000));
  const ra = await a.test<number>(`t.world.remotePlayers.entities.size`);
  const rb = await b.test<number>(`t.world.remotePlayers.entities.size`);
  console.log(`A sees ${ra} remotes, B sees ${rb} — soaking ${SECS}s`);
  await new Promise((r) => setTimeout(r, SECS * 1000));
  for (const [tag, c] of [['A', a], ['B', b]] as const) {
    const ghosts = await c.test<unknown>(`window.__trailDump ? window.__trailDump().ghosts : null`);
    const kills = await c.test<number>(`[...t.world.killCounts.values()].reduce((x,y)=>x+y,0)`);
    const tier = await c.test<string>(`t.networkManager.getTransportTier() ?? 'unknown'`);
    console.log(`=== ${tag} (tier=${tier}, kills=${kills}) ===`);
    console.log(JSON.stringify(ghosts, null, 1));
  }
} finally { await closeClient(a); await closeClient(b); }
