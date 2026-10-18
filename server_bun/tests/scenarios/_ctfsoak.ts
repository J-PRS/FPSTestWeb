// Scratch: CTF botgame soak — a full bot lobby on the real
// Room/CombatHandler/RoomFlags path, real peaks.bin terrain, every bot
// thinking. Tracks the flag lifecycle (grabs/drops/returns/caps), the
// new brain tech (deny grabs, K-outs, sweat leads), per-role stats, and
// grab→cap transit times — the fun-vs-sound balance made visible.
//   bun tests/scenarios/_ctfsoak.ts           # 2 rounds, 12 bots
//   bun tests/scenarios/_ctfsoak.ts 4         # 4 rounds
//   CTF_ROUND_S=300 CTF_BOTS=14 bun ...       # shape knobs
//   CTF_MPC=1                                 # keep the capper MPC on —
//                                             # default off: sync solves
//                                             # cost ~0.36s each inside
//                                             # step() and the soak measures
//                                             # the room, not the planner.
import { readFileSync } from 'node:fs';
import { mkRoom, step, pin, watch } from './harness.ts';
import { hmParseBin, hmHeight } from '../../../shared/heightfield.ts';
import { MODES } from '../../../shared/teams.ts';
import { simNow } from '../../src/simClock.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';

if (!process.env.CTF_MPC) {process.env.FPS_MPC_OFF = '1';}
const ROUNDS = Number(process.argv[2]) || 2;
const BOTS = Number(process.env.CTF_BOTS) || 12;
const SEED = Number(process.env.CTF_SEED) || 4242;
const ROUND_S = Number(process.env.CTF_ROUND_S) || 300;
(MODES as Record<string, { timeLimitS: number; scoreLimit?: number }>).ctf!.timeLimitS = ROUND_S;

const field = hmParseBin(new Uint8Array(readFileSync(`${import.meta.dir}/../../../maps/peaks.bin`)));
const at = (x: number, z: number) => ({ x, y: hmHeight(field, x, z), z });
const BASES = { alpha: at(-150, 0), bravo: at(150, 0) };

const room = mkRoom({
  mode: 'ctf', bots: BOTS, botSkill: 'impossible',
  bases: BASES,
  arena: { x: 0, z: 0, radius: 450 },
}, 'ctf', SEED, false, field);
// Match clock needs a human seat — 'ref' is teamless and parked far out.
room.players.addPlayer('ref');
pin(room, 'ref', { x: 800, y: 300, z: 800 });

const events = watch(room).msgs;
const bots = [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
const botCtl = room.bots as unknown as { roleOf(id: string): string | undefined };

// ---- per-round funnel ----
interface Grab { t: number; team: string; bot: string; capped: boolean; holdS: number }
interface Round {
  grabs: number; caps: number; drops: number; returns: number;
  kouts: number; denies: number; kills: number; leadSwaps: number;
  lastLeader: string; winner: string; simS: number;
  grabLog: Grab[]; capTimes: number[];
}
const fresh = (): Round => ({ grabs: 0, caps: 0, drops: 0, returns: 0, kouts: 0, denies: 0, kills: 0, leadSwaps: 0, lastLeader: '', winner: '?', simS: 0, grabLog: [], capTimes: [] });
const rounds: Round[] = [];
let cur = fresh();
let killsBase = 0;

// Flag transition bookkeeping: alpha flag carried by a bravo bot and
// vice versa — track per-flag carrier + grab time to measure holds.
const carry = new Map<string, { carrier: string; t: number }>();
const lastState = new Map<string, string>();
let simS = 0;
const killsTotal = (): number => room.scoring.matchPlayers().reduce((n, p) => n + p.kills, 0);

function flagTransitions(): void {
  for (const [team, f] of room.flags!.flags) {
    // Touch return: the flag went home straight out of 'dropped'.
    if (lastState.get(team) === 'dropped' && f.state === 'home') {cur.returns++;}
    lastState.set(team, f.state);
    const held = carry.get(team);
    if (f.state === 'carried' && f.carrier) {
      if (!held || held.carrier !== f.carrier) {
        // Grab: someone on the OTHER team took this flag. A grab while
        // OUR flag was already out = the mutual-carry/deny situation.
        const enemyTeam = team === 'alpha' ? 'bravo' : 'alpha';
        const ownOut = room.flags!.flags.get(enemyTeam)!.state === 'carried';
        cur.grabs++;
        if (ownOut) {cur.denies++;}
        cur.grabLog.push({ t: simS, team, bot: f.carrier, capped: false, holdS: 0 });
        carry.set(team, { carrier: f.carrier, t: simS });
      }
    } else if (held) {
      const g = cur.grabLog[cur.grabLog.length - 1];
      if (g && g.bot === held.carrier) {g.holdS = simS - held.t;}
      if (f.state === 'dropped') {cur.drops++;}
      // carried→home = the cap reset — teamScore counts it in drain().
      carry.delete(team);
    }
  }
}

function drain(): void {
  while (events.length > 0) {
    const m = events.shift() as ServerMessage;
    if (m.type === 'teamScore') {
      const leader = m.scores.alpha === m.scores.bravo ? null : m.scores.alpha > m.scores.bravo ? 'alpha' : 'bravo';
      if (leader && cur.lastLeader && leader !== cur.lastLeader) {cur.leadSwaps++;}
      if (leader) {cur.lastLeader = leader;}
      cur.caps++;
      const g = cur.grabLog[cur.grabLog.length - 1];
      if (g) {g.capped = true; cur.capTimes.push(g.holdS);}
    } else if (m.type === 'matchNotice' && /fragged themselves/.test(m.text ?? '')) {
      cur.kouts++;
    } else if (m.type === 'matchEnd') {
      cur.winner = m.winner;
    }
  }
}

// ---- respawn: 3s down, then back at own base with scatter ----
const deadSince = new Map<string, number>();
function respawns(dt: number): void {
  for (const p of bots) {
    if (p.isDead) {
      const t = (deadSince.get(p.id) ?? 0) + dt;
      deadSince.set(p.id, t);
      if (t >= 3) {
        deadSince.delete(p.id);
        room.players.respawnPlayer(p.id);
        const base = BASES[p.team as 'alpha' | 'bravo'] ?? BASES.alpha;
        const a = Math.random() * Math.PI * 2, r = 10 + Math.random() * 30;
        pin(room, p.id, { x: base.x + Math.cos(a) * r, y: base.y + 30, z: base.z + Math.sin(a) * r });
      }
    } else {deadSince.delete(p.id);}
  }
}

console.log(`ctfsoak: ${ROUNDS} rounds x ${ROUND_S}s, ${BOTS} impossible bots, peaks 300m stands\n`);

const t0 = Date.now();
const CAP_S = ROUNDS * (ROUND_S + 90);
const WALL_MS = Number(process.env.CTF_WALL_S || 0) * 1000; // 0 = no cap
const dt = 0.05;
while (rounds.length < ROUNDS && simS < CAP_S) {
  if (WALL_MS > 0 && Date.now() - t0 > WALL_MS) {break;}
  step(room, 1, dt);
  simS += dt;
  respawns(dt);
  room.checkMatchClock(simNow());
  flagTransitions();
  drain();
  if (Math.floor(simS) % 30 < dt && Math.floor(simS) > 0 && !process.env.CTF_QUIET) {
    console.log(`  [t=${simS.toFixed(0)}s] kills=${killsTotal() - killsBase} grabs=${cur.grabs} caps=${cur.caps} drops=${cur.drops} kouts=${cur.kouts} score=${room.scores.alpha}-${room.scores.bravo}`);
    if (process.env.CTF_DEBUG) {
      for (const p of bots) {
        const role = botCtl.roleOf(p.id);
        if (role !== 'capper' && role !== 'offense') {continue;}
        const eb = BASES[p.team === 'alpha' ? 'bravo' : 'alpha'];
        const d = Math.hypot(p.position.x - eb.x, p.position.z - eb.z);
        const hp = p.maxHealth > 0 ? Math.round(p.health / p.maxHealth * 100) : 0;
        console.log(`      ${p.id} ${p.team}/${role} dStand=${d.toFixed(0)} hp=${hp}% dead=${p.isDead}`);
      }
    }
  }
  if (cur.winner !== '?') {
    cur.simS = simS;
    cur.kills = killsTotal() - killsBase;
    killsBase = 0;
    rounds.push(cur);
    const s = room.scores;
    const holds = cur.grabLog.map((g) => g.holdS);
    const avgHold = holds.length > 0 ? holds.reduce((a, b) => a + b, 0) / holds.length : 0;
    const avgCap = cur.capTimes.length > 0 ? cur.capTimes.reduce((a, b) => a + b, 0) / cur.capTimes.length : 0;
    const grabRate = cur.caps > 0 || cur.grabs > 0 ? `${cur.caps}/${cur.grabs}` : '0/0';
    console.log(`round ${rounds.length}: winner=${cur.winner} ${s.alpha}-${s.bravo} kills=${cur.kills}`);
    console.log(`  flags: grabs=${cur.grabs} caps=${cur.caps} (${grabRate} capped) drops=${cur.drops} returns=${cur.returns} mutualCarries=${cur.denies}`);
    console.log(`  tech: kouts=${cur.kouts} leadSwaps=${cur.leadSwaps}`);
    console.log(`  tempo: avgHold=${avgHold.toFixed(1)}s avgCapT=${avgCap.toFixed(1)}s (grab→cap)`);
    // Role scoreboard — who did the work: kills, deaths, grabs, caps per role.
    const roleLine = new Map<string, { k: number; d: number; g: number; c: number }>();
    for (const p of bots) {
      const role = botCtl.roleOf(p.id) ?? 'offense';
      const r = roleLine.get(role) ?? { k: 0, d: 0, g: 0, c: 0 };
      r.k += p.kills; r.d += p.deaths;
      r.g += cur.grabLog.filter((g) => g.bot === p.id).length;
      r.c += cur.grabLog.filter((g) => g.bot === p.id && g.capped).length;
      roleLine.set(role, r);
    }
    console.log(`  roles: ${  [...roleLine.entries()].map(([r, v]) => `${r} k${v.k}/d${v.d} grab${v.g} cap${v.c}`).join('  ')}`);
    cur = fresh();
  }
}
// Wall-capped exits print the in-flight round too — partial data beats none.
cur.kills = killsTotal() - killsBase;
if (cur.winner === '?' && (cur.grabs > 0 || cur.kills > 0 || cur.kouts > 0)) {
  const holds = cur.grabLog.map((g) => g.holdS);
  const avgHold = holds.length > 0 ? holds.reduce((a, b) => a + b, 0) / holds.length : 0;
  const s = room.scores;
  console.log(`partial: ${s.alpha}-${s.bravo} kills=${cur.kills} grabs=${cur.grabs} caps=${cur.caps} drops=${cur.drops} returns=${cur.returns} mutual=${cur.denies} kouts=${cur.kouts} swaps=${cur.leadSwaps} avgHold=${avgHold.toFixed(1)}s`);
  for (const g of cur.grabLog) {console.log(`    grab ${g.bot} t=${g.t.toFixed(0)}s hold=${g.holdS.toFixed(1)}s ${g.capped ? 'CAPPED' : 'lost'}`);}
}
console.log(`\nwall=${((Date.now() - t0) / 1000).toFixed(1)}s for ${simS.toFixed(0)} sim-s (${(simS / ((Date.now() - t0) / 1000)).toFixed(1)}x)`);
