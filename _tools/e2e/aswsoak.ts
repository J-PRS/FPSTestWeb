/**
 * aswsoak.ts — locomotion-split soak: % of life in HA/A/S/W/ST/I.
 *
 *   E2E_GPU=1 bun _tools/e2e/aswsoak.ts [--secs 120] [--bots 15] [--map rimrock] [--mode headhunt]
 *   add --online to fill the room with SERVER bots over WS instead of
 *   the offline ?solo field (same shared brain, different authority).
 *
 * Reads window.__aswDump() (remotes.ts) every SAMPLE_S and reports the
 * final per-bot splits plus roster means. The split is %-of-current-
 * life and wipes on death, so freshly respawned bots read small windows
 * — that's the metric, not a bug. Local player row is excluded.
 */
import { launchClient, closeClient } from './browser.ts';
import { upStack, type Stack } from './env.ts';

const arg = (n: string, d: string): string =>
  process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d;
const SECS = Number(arg('secs', '120'));
const BOTS = arg('bots', '15');
const MAP = arg('map', 'rimrock');
const MODE = arg('mode', 'headhunt');
const ONLINE = process.argv.includes('--online');
const SAMPLE_S = 15;

interface AswRow { id: string; ha: number; a: number; s: number; w: number; st: number; i: number }

const parseDump = (lines: string[]): AswRow[] => lines.flatMap((l) => {
  const m = /^\s*asw (\S+) ([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)/.exec(l);
  if (!m) {return [];}
  return [{ id: m[1]!, ha: +m[2]!, a: +m[3]!, s: +m[4]!, w: +m[5]!, st: +m[6]!, i: +m[7]! }];
});

const stack: Stack = await upStack();
const url = ONLINE
  ? stack.clientUrl(`&room=aswsoak&map=${MAP}&bots=${BOTS}&mode=${MODE}&net=ws`)
  : `http://localhost:${stack.clientPort}/?debug&solo&map=${MAP}&bots=${BOTS}&mode=${MODE}`;
const client = await launchClient(url);

try {
  if (ONLINE) {
    await client.waitFor(`t.networkManager && t.networkManager.isConnected()`, 60000);
    await client.waitFor(`t.world.remotePlayers.entities.size >= 1`, 30000);
  } else {
    await client.waitFor(`t.teamBots && t.teamBots.bots.length > 0`, 45000);
  }
  console.log(`${ONLINE ? 'online' : 'offline'} ${MODE} on ${MAP}, ${BOTS} bots — soaking ${SECS}s\n`);

  // Local id isn't 'bot:'-prefixed on either lane (player_* online,
  // player_* offline too) — exclude it by name, keep every other row.
  const localId = await client.test<string>(`t.networkManager?.getLocalPlayerId?.() ?? ''`).catch(() => '');
  const isBot = (id: string): boolean => id !== localId && id !== '' && !id.startsWith('player_');
  let last: AswRow[] = [];
  for (let t = 0; t < SECS; t += SAMPLE_S) {
    await new Promise((r) => setTimeout(r, SAMPLE_S * 1000));
    last = parseDump(await client.test<string[]>(`window.__aswDump ? window.__aswDump() : []`));
    const bots = last.filter((r) => isBot(r.id));
    console.log(`  t+${t + SAMPLE_S}s: ${bots.length} bots reporting`);
  }

  const bots = last.filter((r) => isBot(r.id));
  const mean = (k: keyof Omit<AswRow, 'id'>): number =>
    bots.length ? bots.reduce((s, r) => s + r[k], 0) / bots.length : 0;
  console.log(`\n=== ${ONLINE ? 'ONLINE' : 'OFFLINE'} bots (${bots.length}) — % of life ===`);
  console.log('id                 HA     A     S     W    ST     I');
  for (const r of bots.sort((x, y) => y.ha - x.ha)) {
    console.log(`${r.id.padEnd(18)} ${String(r.ha).padStart(5)} ${String(r.a).padStart(5)} ${String(r.s).padStart(5)} ${String(r.w).padStart(5)} ${String(r.st).padStart(5)} ${String(r.i).padStart(5)}`);
  }
  console.log(`${'MEAN'.padEnd(18)} ${mean('ha').toFixed(1).padStart(5)} ${mean('a').toFixed(1).padStart(5)} ${mean('s').toFixed(1).padStart(5)} ${mean('w').toFixed(1).padStart(5)} ${mean('st').toFixed(1).padStart(5)} ${mean('i').toFixed(1).padStart(5)}`);
} finally {
  await closeClient(client);
  stack.down();
}
