/**
 * desyncsoak.ts — headless replica-fidelity soak.
 *
 *   bun _tools/e2e/desyncsoak.ts [--secs 60] [--bots 8] [--map dm]
 *
 * One real client in a bot-populated room runs the StateHash audit for a
 * window; every DESYNC warn the page logs is collected and fails the
 * spec. This is the check the raw fleet soak can't do — fleet bots decode
 * frames but never assert wire-state-vs-server, so a lane-wide desync
 * (the wire-z saturation, stranded creatures) sails through a "clean"
 * fleet run. Locked-PC safe: headless Chrome runs the same stateDebug
 * the headed client does.
 */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';
import { check, checkCount } from './check.ts';

const arg = (name: string, dflt: string): string =>
  process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1]! : dflt;
const SECS = Number(arg('secs', '60'));
const BOTS = arg('bots', '8');
const MAP = arg('map', 'dm');

const desync: string[] = [];
const stack = await upStack();
const client = await launchClient(stack.clientUrl(`&room=desyncsoak&map=${MAP}&bots=${BOTS}`));
client.page.on('console', (m) => {
  const t = m.text();
  if (t.includes('DESYNC')) desync.push(t.slice(0, 300));
});

try {
  await client.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
  await client.waitFor(`t.world.remotePlayers.entities.size >= 1`, 30000);
  const remotes = await client.test<number>(`t.world.remotePlayers.entities.size`);
  check(remotes > 0, `room populated (${remotes} remotes)`);

  console.log(`  soaking ${SECS}s wall (headless game-time is slower — lanes still check on wall cadence)`);
  await new Promise((r) => setTimeout(r, SECS * 1000));

  check(desync.length === 0, `no DESYNC warns (${desync.length} in ${SECS}s)`);
  for (const line of desync.slice(0, 10)) console.log(`    ${line}`);

  // A dead seat passes "no DESYNC warns" vacuously — the wire went silent
  // so nothing could ever disagree (seen live: WT reset + ws refused for
  // 30+s inside a "PASS"). Assert the lane was actually alive at the end:
  // connected, tick seq advancing, keepalives landing.
  const end = await client.test<{ conn: boolean; seq: number; ping: number }>(
    `((w) => ({ conn: t.networkManager.isConnected(), seq: w.lastTickSeq,
        ping: t.parity.msgSeen.ping ?? 0 }))(t.networkManager['wireIn'])`);
  check(end.conn, 'still connected at soak end');
  check(end.seq > 0, `tick stream live (seq=${end.seq})`);
  check(end.ping >= Math.max(5, Math.floor(SECS / 10) - 4),
    `keepalives landed (ping=${end.ping} over ${SECS}s)`);
} finally {
  await closeClient(client);
  stack.down();
}
console.log(`\n${checkCount()} checks passed`);
