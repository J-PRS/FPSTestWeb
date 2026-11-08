// Wide WAN soak — R rooms × B bots over real wss, join-paced under the
// server's 20/min/IP flood guard (a 1013 close kills a bot for good —
// join pace is the whole trick). Usage:
//   bun tools/netbot/wideSoak.ts --url wss://play.jprice.app:8443/ws \
//       --rooms 10 --bots 24 --seconds 90 --pace 3400
// NOTE (fleet, 2026-11-07): play.jprice.app/ws on :443 is the DIRECTOR —
// it 404s. Resolve a real worker first: GET
// https://play.jprice.app/join?room=X → {url:"wss://host:8443/ws",...}.
import { LatencyLink } from './latency.ts';
import { NetClient } from './netClient.ts';
import { NetBot } from './bot.ts';
import { BOT_LOADOUTS, botClassForLoadout } from '../../shared/botLoadouts.ts';

function arg<T>(n: string, d: T, p: (s: string) => T): T {
  const i = process.argv.indexOf(n);
  return i !== -1 && process.argv[i + 1] ? p(process.argv[i + 1]) : d;
}
const URL_ = arg('--url', 'wss://play.jprice.app/ws', String);
const ROOMS = arg('--rooms', 10, Number);
const PER = arg('--bots', 24, Number);
const SECONDS = arg('--seconds', 90, Number);
const PACE = arg('--pace', 3400, Number); // ms between connects, global
// --join-parallel N: connect N bots concurrently per wave (join-burst
// test — the launch-day herd shape; default 1 keeps the WAN-polite
// serial pace the flood guard expects).
const JOIN_PAR = arg('--join-parallel', 1, Number);
const ROOMBASE = arg('--roombase', 'stress', String);
// Ops admin token — bypasses the 20/min/IP join flood guard on the
// server (SessionManager). Lets a single-box fleet burst instead of
// pacing. --pace still spreads handshakes; 5-50ms is plenty with it.
const KEY = arg('--key', process.env.FPS_ADMIN_TOKEN ?? '', String);
const TAG = Date.now().toString(36);
const LINKS = [
  { pingMs: 40, jitterMs: 30, lossRate: 0 },
  { pingMs: 80, jitterMs: 60, lossRate: 0 },
  { pingMs: 150, jitterMs: 90, lossRate: 0.01 },
  { pingMs: 250, jitterMs: 150, lossRate: 0.03 },
];

const bots: { nc: NetClient; bot: NetBot; room: string }[] = [];
let g = 0;
for (let r = 0; r < ROOMS; r++) {
  const room = `${ROOMBASE}-${r + 1}`;
  for (let i = 0; i < PER; i++) {
    const lo = BOT_LOADOUTS[g % BOT_LOADOUTS.length]!;
    const li = LINKS[g % LINKS.length]!;
    const nc = new NetClient(URL_, `nb${TAG}_${r}_${i}`, new LatencyLink(li),
      { transport: 'ws', room, mode: 'ctf', armorClass: botClassForLoadout(lo), ...(KEY ? { adminKey: KEY } : {}) });
    bots.push({ nc, bot: new NetBot(nc, { loadout: lo }), room });
    g++;
  }
}
console.log(`wide soak: ${bots.length} bots → ${ROOMS} rooms × ${PER}, pace ${PACE}ms → ~${Math.ceil(bots.length * PACE / 60_000)}min join phase`);

let joined = 0;
const t0 = Date.now();
const joinMs: number[] = [];
const joinOne = async (b: (typeof bots)[0]): Promise<void> => {
  const c0 = Date.now();
  try { await b.nc.connect(); joined++; b.bot.start(); }
  catch { /* socket error — count at the end */ }
  // Time-to-first-gameState is the user-facing "how fast am I in" — but
  // waiting for it serializes the wave (a slow server turns every wave
  // into join latency × bots/parallel). Detach the poll: the join phase
  // runs at connect speed and we still keep the latency stat.
  void (async (): Promise<void> => {
    for (let i = 0; i < 50 && b.nc.tel.gameStates === 0; i++) {await new Promise((r) => setTimeout(r, 60));}
    if (b.nc.tel.gameStates > 0) {joinMs.push(Date.now() - c0);}
  })();
};
for (let w = 0; w < bots.length; w += JOIN_PAR) {
  const wave = bots.slice(w, w + JOIN_PAR);
  await Promise.all(wave.map(joinOne));
  if (w + JOIN_PAR < bots.length) {await new Promise((r) => setTimeout(r, PACE));}
}
joinMs.sort((a, b) => a - b);
const jq = (q: number): number => joinMs[Math.min(joinMs.length - 1, Math.floor(joinMs.length * q))]!;
console.log(`join phase done: ${joined}/${bots.length} connected in ${((Date.now() - t0) / 1000).toFixed(0)}s — first-gameState p50=${jq(0.5)}ms p95=${jq(0.95)}ms max=${joinMs[joinMs.length - 1]}ms`);
await new Promise((r) => setTimeout(r, SECONDS * 1000));

// Snapshot BEFORE teardown — b.nc.close() is what sets nc.closed, so
// counting after it always reads 100% and kills the reclaim signal.
const snap = bots.map((b) => ({ room: b.room, t: { ...b.nc.tel, rejects: new Map(b.nc.tel.rejects) }, closed: b.nc.closed, closeInfo: b.nc.closeInfo }));
for (const b of bots) { b.bot.stop(); b.nc.close(); }
await new Promise((r) => setTimeout(r, 400));

const perRoom = new Map<string, { n: number; gs: number; ticks: number; shots: number; hits: number; kills: number; deaths: number; rejects: Map<string, number>; closed: number; corr: number }>();
for (const s of snap) {
  const {t} = s;
  const r = perRoom.get(s.room) ?? { n: 0, gs: 0, ticks: 0, shots: 0, hits: 0, kills: 0, deaths: 0, rejects: new Map(), closed: 0, corr: 0 };
  r.n++; r.gs += t.gameStates; r.ticks += t.ticks; r.shots += t.shots; r.hits += t.hitsDealt;
  r.kills += t.kills; r.deaths += t.deaths; r.corr += t.corrections;
  for (const [reason, n] of t.rejects) {r.rejects.set(reason, (r.rejects.get(reason) ?? 0) + n);}
  if (s.closed) {r.closed++;}
  perRoom.set(s.room, r);
}
console.log('\n=== per-room ===');
let totR = 0, totC = 0, totGs = 0, totTicks = 0, totK = 0;
const fmtRejects = (m: Map<string, number>): string =>
  [...m.entries()].map(([r, n]) => `${r} x${n}`).join(', ') || 'none';
for (const [room, r] of perRoom) {
  const rTot = [...r.rejects.values()].reduce((a, x) => a + x, 0);
  console.log(`${room}: n=${r.n} gs=${r.gs} ticks=${r.ticks} shots=${r.shots} hits=${r.hits} kd=${r.kills}/${r.deaths} rejects=${rTot} [${fmtRejects(r.rejects)}] closed=${r.closed} corr=${r.corr}`);
  totR += rTot; totC += r.closed; totGs += r.gs; totTicks += r.ticks; totK += r.kills;
}
console.log(`\n=== totals === rooms=${perRoom.size} rejects=${totR} closed=${totC} gameStates=${totGs} ticks=${totTicks} kills=${totK}`);
const closeInfos = new Map<string, number>();
for (const s of snap) {
  if (s.closed) {closeInfos.set(s.closeInfo || 'unknown', (closeInfos.get(s.closeInfo || 'unknown') ?? 0) + 1);}
}
if (closeInfos.size > 0) {console.log('close reasons:', [...closeInfos.entries()].map(([r, n]) => `${r} x${n}`).join(', '));}
