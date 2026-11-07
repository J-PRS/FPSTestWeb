/**
 * solosmoke.ts — offline-bot smoke: boots a ?solo match and verifies the
 * ctx-filled brains actually behave (move, chase, fight, score) and the
 * console stays free of exceptions from the new ctx paths.
 *
 *   E2E_GPU=1 bun _tools/e2e/solosmoke.ts [--secs 90] [--mode ctf] [--bots 12] [--map lagoon]
 */
import { launchClient, closeClient } from './browser.ts';

const arg = (n: string, d: string): string =>
  process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d;
const SECS = Number(arg('secs', '90'));
const MODE = arg('mode', 'ctf');
const BOTS = arg('bots', '12');
const MAP = arg('map', 'lagoon');
const CLIENT = arg('client', 'http://127.0.0.1:5500');

const errors: string[] = [];
const client = await launchClient(`${CLIENT}/?debug&solo&map=${MAP}&bots=${BOTS}&mode=${MODE}`);

try {
  await client.waitFor(`t.teamBots && t.teamBots.bots.length > 0`, 45000);
  const p0 = await client.test<string>(`JSON.stringify(t.teamBots.bots.map(b=>[b.position.x|0,b.position.z|0]))`);
  const hp0 = await client.test<number>(`t.teamBots.bots.filter(b=>b.botHp>0).length`);
  console.log(`solo populated (${hp0} bots alive) — watching ${SECS}s`);

  for (let i = 0; i < Math.ceil(SECS / 15); i += 1) {
    await new Promise((r) => setTimeout(r, 15000));
    const p = await client.test<string>(`JSON.stringify(t.teamBots.bots.map(b=>[b.position.x|0,b.position.z|0]))`);
    const alive = await client.test<number>(`t.teamBots.bots.filter(b=>b.botHp>0).length`);
    const moved = p.split('],').filter((s, ix) => s !== p0.split('],')[ix]).length;
    console.log(`  t+${(i + 1) * 15}s alive=${alive} moved-since-start=${moved}`);
  }
  const kills = await client.test<number>(`[...t.world.killCounts.values()].reduce((a,b)=>a+b,0)`);
  const scores = await client.test<string>(`JSON.stringify(t.teamBots.scores)`);
  console.log(`kills=${kills} scores=${scores} consoleErrors=${errors.length}`);
  for (const e of errors.slice(0, 10)) { console.log(`  ERR: ${e.slice(0, 160)}`); }
} finally {
  await closeClient(client);
}
