/**
 * paritycanary.ts — broad glitch census soak (local stack or prod).
 *
 *   bun _tools/e2e/paritycanary.ts [--secs 90] [--bots 8] [--map dm]
 *   bun _tools/e2e/paritycanary.ts --prod [--secs 90] [--room headhunt-1]
 *
 * desyncsoak asserts only DESYNC warns; this sweeps every GLITCH:* family
 * the client can emit and fails on the authority-divergence tier:
 *
 *   FAIL  GLITCH:parity-* (dmg/kb echoes, traj outliers, fate-late, ...),
 *         shot rejected, class-locked, DESYNC, [ERROR]
 *   WARN  cosmetic/known-noise GLITCHs (trail-jumpcut, render-blend, ...)
 *         - counted and printed, never fail the run alone
 *
 * --prod joins the deployed box through the local :5500 preview
 * (?server=https://play.jprice.app&net=ws) - requires `vite preview`
 * already running. Otherwise upStack() spawns an isolated local stack.
 * End-of-soak liveness asserts the lane was actually alive (a dead seat
 * passes a glitch census vacuously).
 */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';
import { check, checkCount } from './check.ts';

const arg = (name: string, dflt: string): string =>
  process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1]! : dflt;
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const SECS = Number(arg('secs', '90'));
const BOTS = arg('bots', '8');
const MAP = arg('map', 'dm');
const PROD = flag('prod');
const ROOM = arg('room', PROD ? 'headhunt-1' : 'paritycanary');

const FAIL_GLITCH_RE = /GLITCH:parity-/;
const FAIL_RE = /shot rejected|class-locked|DESYNC/;
// console.error lines carry an [ERROR] tag; GLITCH:* logs ride that
// channel too, so classify GLITCH first and only fail bare errors.
const ERROR_RE = /\[ERROR\]/;
const GLITCH_RE = /GLITCH:([a-z-]+)/;

const fails: string[] = [];
const warns = new Map<string, number>();
const stack = PROD ? null : await upStack();
const url = PROD
  ? `http://127.0.0.1:5500/?server=https://play.jprice.app&room=${ROOM}&net=ws`
  : stack!.clientUrl(`&room=${ROOM}&map=${MAP}&bots=${BOTS}`);
const client = await launchClient(url);
client.page.on('console', (m) => {
  const t = m.text();
  const g = t.match(GLITCH_RE);
  if (g) {
    if (FAIL_GLITCH_RE.test(t)) fails.push(t.slice(0, 300));
    else warns.set(g[1]!, (warns.get(g[1]!) ?? 0) + 1);
    return;
  }
  if (FAIL_RE.test(t) || ERROR_RE.test(t)) fails.push(t.slice(0, 300));
});

try {
  await client.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
  await client.waitFor(`t.world.remotePlayers.entities.size >= 1`, 30000);
  const remotes = await client.test<number>(`t.world.remotePlayers.entities.size`);
  check(remotes > 0, `room populated (${remotes} remotes${PROD ? ', prod' : ''})`);

  console.log(`  soaking ${SECS}s wall (${PROD ? 'prod ' + ROOM : `map=${MAP} bots=${BOTS}`})`);
  await new Promise((r) => setTimeout(r, SECS * 1000));

  check(fails.length === 0, `no authority-divergence glitches (${fails.length} in ${SECS}s)`);
  for (const line of fails.slice(0, 10)) console.log(`    FAIL ${line}`);

  const end = await client.test<{ conn: boolean; seq: number; ping: number }>(
    `((w) => ({ conn: t.networkManager.isConnected(), seq: w.lastTickSeq,
        ping: t.parity.msgSeen.ping ?? 0 }))(t.networkManager['wireIn'])`);
  check(end.conn, 'still connected at soak end');
  check(end.seq > 0, `tick stream live (seq=${end.seq})`);
  check(end.ping >= Math.max(5, Math.floor(SECS / 10) - 4),
    `keepalives landed (ping=${end.ping} over ${SECS}s)`);
} finally {
  await closeClient(client);
  stack?.down();
}

if (warns.size > 0) {
  console.log('  warn-tier glitches (non-fatal):');
  for (const [k, n] of [...warns.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k}: ${n}`);
  }
}
console.log(`\n${checkCount()} checks passed`);
