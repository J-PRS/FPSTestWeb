// Scratch: headhunt wire soak — a full multi-round bot lobby on the real
// Room/CombatHandler/Pickups path, no test harness short-circuits. Bots
// hunt tokens (500m reach), farm creatures, kill each other, corpses
// spill denomination coins, enemies scoop them. Each round prints the
// pickup funnel (spawned/banked/decayed), the biggest hoard, lead swaps,
// and the final live-held score — the mode's volatility made visible.
//   bun tests/scenarios/_hhsoak.ts            # 3 rounds, 10 bots
//   bun tests/scenarios/_hhsoak.ts 6          # 6 rounds
//   HH_ROUND_S=90 HH_BOTS=14 bun ...          # shape knobs
import { mkRoom, step, pin, watch } from './harness.ts';
import { MODES } from '../../../shared/teams.ts';
import { simNow } from '../../src/simClock.ts';
import { weaponStats } from '../../src/weaponStats.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';

const ROUNDS = Number(process.argv[2]) || 3;
const BOTS = Number(process.env.HH_BOTS) || 10;
const ARENA = Number(process.env.HH_ARENA) || 250;
// Rounds are compressed so the soak sees many full match lifecycles —
// production stays 900s.
const ROUND_S = Number(process.env.HH_ROUND_S) || 180;
(MODES as Record<string, { timeLimitS: number }>).headhunt!.timeLimitS = ROUND_S;

const room = mkRoom({
  mode: 'headhunt', bots: BOTS, botSkill: 'impossible',
  arena: { x: 0, z: 0, radius: ARENA },
  balls: { base: 12, perPlayer: 0, max: 24 },
}, 'headhunt', 7331);
// The match clock only arms when a human sits in the room — a real
// lobby always has one. 'ref' is teamless: can't score, can't collect,
// parked outside the arena so it only witnesses.
room.players.addPlayer('ref');
pin(room, 'ref', { x: ARENA + 500, y: 200, z: ARENA + 500 });

const events = watch(room).msgs;
const bots = [...room.players.getAllPlayers().values()].filter((p) => p.isBot);

// ---- per-round event funnel ----
interface Round {
  spawned: number; collected: number; decayed: number;
  kills0: number; peakHeld: number; peakHolder: string;
  leadSwaps: number; lastLeader: string; winner: string; simS: number;
}
const rounds: Round[] = [];
const tokenIds = new Set<number>();
const tokenVals = new Map<number, number>();
let cur: Round = { spawned: 0, collected: 0, decayed: 0, kills0: 0, peakHeld: 0, peakHolder: '', leadSwaps: 0, lastLeader: '', winner: '?', simS: 0 };

const kills = (): number => room.scoring.matchPlayers().reduce((n, p) => n + p.kills, 0);
cur.kills0 = 0;

function drain(): void {
  while (events.length > 0) {
    const m = events.shift() as ServerMessage;
    if (m.type === 'pickupSpawn' && m.kind === 'token') {
      cur.spawned++;
      tokenIds.add(m.id);
      tokenVals.set(m.id, m.val ?? 1);
    } else if (m.type === 'pickupGone' && tokenIds.delete(m.id)) {
      tokenVals.delete(m.id);
      if (m.by) { cur.collected++; } else { cur.decayed++; }
    } else if (m.type === 'playerHeld') {
      if (m.n > cur.peakHeld) { cur.peakHeld = m.n; cur.peakHolder = m.playerId; }
    } else if (m.type === 'teamScore') {
      const leader = m.scores.alpha === m.scores.bravo ? null : m.scores.alpha > m.scores.bravo ? 'alpha' : 'bravo';
      if (leader && cur.lastLeader && leader !== cur.lastLeader) {cur.leadSwaps++;}
      if (leader) {cur.lastLeader = leader;}
    } else if (m.type === 'matchEnd') {
      cur.winner = m.winner;
    }
  }
}

// ---- respawn: the harness never revives; a real match does. 3s down. ----
const deadSince = new Map<string, number>();
function respawns(dt: number): void {
  for (const p of bots) {
    if (p.isDead) {
      const t = (deadSince.get(p.id) ?? 0) + dt;
      deadSince.set(p.id, t);
      if (t >= 3) {
        deadSince.delete(p.id);
        room.players.respawnPlayer(p.id);
        const a = Math.random() * Math.PI * 2;
        pin(room, p.id, { x: Math.cos(a) * (ARENA * 0.7), y: 60, z: Math.sin(a) * (ARENA * 0.7) });
      }
    } else {deadSince.delete(p.id);}
  }
}

console.log(`hhsoak: ${ROUNDS} rounds x ${ROUND_S}s, ${BOTS} impossible bots, arena r=${ARENA}m, wildlife 12-24\n`);

const t0 = Date.now();
let simS = 0;
// Ceiling: ROUND_S + intermission + slack, so a stuck round can't hang the soak.
const CAP_S = ROUNDS * (ROUND_S + 60);
let killsBase = 0;
while (rounds.length < ROUNDS && simS < CAP_S) {
  step(room, 1);
  simS += 0.05;
  respawns(0.05);
  room.checkMatchClock(simNow());
  drain();
  if (cur.winner !== '?') {
    cur.simS = simS;
    const k = kills() - killsBase;
    killsBase = 0; // scoreboard wipes at matchStart — next round counts fresh
    rounds.push(cur);
    const s = room.scores;
    const held = [...room.players.getAllPlayers().values()].filter((p) => p.heldTokens > 0).map((p) => `${p.id}=${p.heldTokens}`).join(' ');
    console.log(`round ${rounds.length}: winner=${cur.winner} score=${s.alpha}-${s.bravo} kills=${k} tokens spawned=${cur.spawned} collected=${cur.collected} decayed=${cur.decayed} peakHeld=${cur.peakHeld}(${cur.peakHolder}) leadSwaps=${cur.leadSwaps}`);
    console.log(`  pockets: ${held || 'none'}`);
    cur = { spawned: 0, collected: 0, decayed: 0, kills0: 0, peakHeld: 0, peakHolder: '', leadSwaps: 0, lastLeader: '', winner: '?', simS: 0 };
  }
}

// weaponStats is the authoritative economy funnel (spawn/bank/decay
// per kind) — the broadcast tally above is the same story told on wire.
const funnel = weaponStats.snapshot().pickups?.headhunt ?? {};
console.log('\npickup funnel (weaponStats, all rounds):');
for (const [kind, r] of Object.entries(funnel)) {
  const row = r as { spawned: number; banked: number; decayed: number; refused: number };
  console.log(`  ${kind}: spawned=${row.spawned} banked=${row.banked} decayed=${row.decayed} refused=${row.refused}`);
}
console.log(`\nwall=${((Date.now() - t0) / 1000).toFixed(1)}s for ${simS.toFixed(0)} sim-s (${(simS / ((Date.now() - t0) / 1000)).toFixed(1)}x)`);
