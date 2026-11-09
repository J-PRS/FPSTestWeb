// Netbot soak runner — connects N headless bots to a LIVE server over real
// WebSockets with simulated WAN conditions, lets them fight, then prints
// per-bot + aggregate telemetry. The assertions a soak can honestly make:
// zero shotRejected (every claim a legit client sends should resolve),
// damage actually applied, corrections not storming.
//
//   bun tools/netbot/soak.ts --url ws://127.0.0.1:7777/ws --bots 6 \
//       --seconds 60 --ping 60 --jitter 120 --loss 0.01 [--hop-every 30000]

import { LatencyLink } from './latency.ts';
import { NetClient } from './netClient.ts';
import { NetBot } from './bot.ts';
import { BOT_LOADOUTS, botClassForLoadout } from '../../shared/botLoadouts.ts';

function arg<T>(name: string, def: T, parse: (s: string) => T): T {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? parse(process.argv[i + 1]) : def;
}
const num = (s: string) => Number(s);

const URL_ = arg('--url', 'ws://127.0.0.1:7777/ws', String);
const BOTS = arg('--bots', 6, num);
const SECONDS = arg('--seconds', 60, num);
const PING = arg('--ping', 60, num);
const JITTER = arg('--jitter', 120, num);
const LOSS = arg('--loss', 0.01, num);
const HOP_EVERY = arg('--hop-every', 0, num);
const DROP_EVERY = arg('--drop-every', 0, num);
const ROOM = arg('--room', '', String);
const MODE = arg('--mode', '', String);
const STAGGER = arg('--stagger', 50, num);
// --net ws|rtc|mixed — mixed assigns transports round-robin-randomly so a
// public-match split of socket types contends in one room. RTC needs
// node-datachannel (same import the test helpers use); if it can't load,
// rtc picks degrade to ws.
const NET = arg('--net', 'ws', String);
const nd = (NET === 'ws')
  ? null
  : await import('node-datachannel').then((m) => ((m as { default?: unknown }).default ?? m) as never).catch(() => null);
if (NET !== 'ws' && !nd) {console.log('node-datachannel unavailable — rtc picks run ws');}
const pickNet = (): 'ws' | 'rtc' =>
  NET === 'mixed' ? (nd && Math.random() < 0.5 ? 'rtc' : 'ws')
    : NET === 'rtc' && nd ? 'rtc' : 'ws';

console.log(`netbot soak: ${BOTS} bots → ${URL_} for ${SECONDS}s (ping=${PING}ms jitter=${JITTER}ms loss=${LOSS} net=${NET}${ROOM ? ` room=${ROOM}/${MODE}` : ''})`);

// Unique ids per run — the server pins each playerId to an HMAC identity
// token permanently (anti-impersonation), so reusing netbot_N across runs
// gets 'Player ID claimed' rejections. A browser survives this because
// localStorage keeps the token; a soak gets a fresh tag.
const RUN_TAG = Date.now().toString(36);
const bots: { nc: NetClient; bot: NetBot }[] = [];
for (let i = 0; i < BOTS; i++) {
  const lo = BOT_LOADOUTS[i % BOT_LOADOUTS.length]!;
  const transport = pickNet();
  const nc = new NetClient(URL_, `nb${RUN_TAG}_${i}`, new LatencyLink({ pingMs: PING, jitterMs: JITTER, lossRate: LOSS }), { transport, ...(transport === 'rtc' && nd ? { rtc: { nd } } : {}), ...(ROOM ? { room: ROOM, mode: MODE } : {}), armorClass: botClassForLoadout(lo) });
  const bot = new NetBot(nc, { hopEveryMs: HOP_EVERY > 0 ? HOP_EVERY : undefined, dropEveryMs: DROP_EVERY > 0 ? DROP_EVERY : undefined, loadout: lo });
  console.log(`  ${nc.id} → ${transport}`);
  bots.push({ nc, bot });
}

// Staggered connects — a simultaneous handshake burst over a shared
// tunnel/loopback dropped joins entirely in live testing (sockets open,
// no gameState ever). The bun test staggers for the same reason.
for (const b of bots) {
  await b.nc.connect();
  if (STAGGER > 0) {await new Promise((r) => setTimeout(r, STAGGER));}
}
console.log('all bots joined');
for (const b of bots) {b.bot.start();}

await new Promise((r) => setTimeout(r, SECONDS * 1000));

for (const b of bots) { b.bot.stop(); b.nc.close(); }
await new Promise((r) => setTimeout(r, 300)); // let the last wire events land

let fails = 0;
console.log('\n=== per-bot ===');
for (const { nc } of bots) {
  const t = nc.tel;
  const rejects = [...t.rejects.entries()].map(([r, n]) => `${r}:${n}`).join(' ') || 'none';
  const blocked = [...t.fireBlocked.entries()].map(([r, n]) => `${r}:${n}`).join(' ') || 'none';
  console.log(`${nc.id}: shots=${t.shots} claims=${t.claims} dealt=${t.hitsDealt} taken=${t.hitsTaken} ` +
    `intent=${t.fireIntents} blocked=[${blocked}] ` +
    `k/d=${t.kills}/${t.deaths} rejects=[${rejects}] corr=${t.corrections} dedup=${t.dedupDrops} ` +
    `hops=${t.hops} gs=${t.gameStates} rtt=${nc.pingMs}ms${nc.closed ? ` CLOSED[${nc.closeInfo}]` : ''}`);
  // 'shooter dead' is a legal verdict, not wire loss - the fire intent
  // races the death edge under jitter (same exclusion as bigSoak/harshWan).
  const totalRejects = [...t.rejects.entries()]
    .filter(([r]) => !r.endsWith('shooter dead'))
    .reduce((a, [, n]) => a + n, 0);
  if (totalRejects > 0) {fails++;}
}
const totShots = bots.reduce((a, b) => a + b.nc.tel.shots, 0);
const totDealt = bots.reduce((a, b) => a + b.nc.tel.hitsDealt, 0);
const totKills = bots.reduce((a, b) => a + b.nc.tel.kills, 0);
console.log(`\n=== totals === shots=${totShots} hitsDealt=${totDealt} kills=${totKills}`);
if (totDealt === 0) { console.log('FAIL: no damage applied at all'); fails++; }
if (fails) { console.log(`FAIL: ${fails} check(s) failed`); process.exit(1); }
console.log('PASS');
process.exit(0);
