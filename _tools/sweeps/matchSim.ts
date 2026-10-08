/**
 * Full-match capper soak — a real CTF room on a real map: every bot
 * thinks, fights, dies, and respawns on sim clock. This is the defended-
 * stand counterpart to capMeasure's frozen-roster route metric.
 *
 *   bun _tools/sweeps/matchSim.ts [--map katabatic | --field default] [--mins 10] [--bots 20]
 *                                 [--spread 566] [--hscale 1] [--seed 1337] [--quiet]
 *
 * --field default runs the neutral generated heightfield
 * (server_bun/heightmap.bin) with bases on a diagonal — same routes as
 * neutralSoak, so empty-route times and contested times compare directly.
 *
 * Scores: caps per side, grab/cap sim-times, kills, flag drops — the
 * answers to "does the capper still finish the route when the other
 * team is trying to stop it".
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hmParseBin, hmHeight } from '../../shared/heightfield.ts';
import { mkRoom, step, watch } from '../../server_bun/tests/scenarios/harness.ts';
import { simNow } from '../../server_bun/src/simClock.ts';

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1]! : dflt;
};
const MAP = arg('map', 'katabatic');
const FIELD = arg('field', '');        // 'default' = neutral heightmap.bin
const MINS = Number(arg('mins', 10));
const BOTS = Number(arg('bots', 20));
const SEED = Number(arg('seed', 1337));
const QUIET = process.argv.includes('--quiet');
const SPREAD = Number(arg('spread', 566));
const HSCALE = Number(arg('hscale', 1));

let spec: Record<string, unknown> = {};
let f;
if (FIELD === 'default') {
  f = hmParseBin(new Uint8Array(readFileSync(resolve(import.meta.dir, '../../server_bun/heightmap.bin'))), HSCALE);
} else {
  spec = JSON.parse(readFileSync(resolve(import.meta.dir, `../../maps/${MAP}.json`), 'utf8'));
  f = hmParseBin(new Uint8Array(readFileSync(resolve(import.meta.dir, `../../maps/${(spec as { terrain: string }).terrain}`))), HSCALE);
}
const at = (x: number, z: number) => ({ x, y: hmHeight(f, x, z), z });
const bases = FIELD === 'default'
  ? { alpha: at(SPREAD, -SPREAD), bravo: at(-SPREAD, SPREAD) }  // SE>NW diagonal, same as neutralSoak
  : { alpha: at((spec as { bases: { alpha: { x: number; z: number } } }).bases.alpha.x, (spec as never as { bases: { alpha: { z: number } } }).bases.alpha.z),
      bravo: at((spec as never as { bases: { bravo: { x: number; z: number } } }).bases.bravo.x, (spec as never as { bases: { bravo: { z: number } } }).bases.bravo.z) };
const flagM = Math.hypot(bases.alpha.x - bases.bravo.x, bases.alpha.z - bases.bravo.z).toFixed(0);

const room = mkRoom({ ...spec, mode: 'ctf', bots: BOTS, botFill: BOTS, bases }, 'ctf', SEED, false, f);
let clock = 0;
const w = watch(room, () => clock);

const dt = 0.05;
const simS = MINS * 60;
const t0 = Date.now();
const marks = Math.min(10, MINS);
const markEvery = simS * 20 / marks;

for (let i = 0; i < simS * 20; i++) {
  step(room, 1, dt);
  // Stepped sims outrun wall-clock — the manager's own sim-deadline
  // ledger fires respawns here instead.
  room.messages.respawnTick(simNow());
  clock += dt;
  if (!QUIET && i % markEvery === markEvery - 1) {
    const all = [...room.players.getAllPlayers().values()];
    const alive = all.filter((p) => !p.isDead).length;
    let info = '';
    for (const fl of room.flags?.flags.values() ?? []) {
      if (fl.state !== 'carried' || !fl.carrier) continue;
      const c = room.players.getPlayer(fl.carrier);
      if (!c) continue;
      // Enemy approach histogram — is ANY hostile closing on this
      // carrier, or is the whole team parked in a midfield war?
      const ds: number[] = [];
      for (const p of all) {
        if (p.isDead || p.team === c.team) continue;
        ds.push(Math.hypot(p.position.x - c.position.x, p.position.z - c.position.z));
      }
      ds.sort((a, b) => a - b);
      const ownBase = c.team === 'alpha' ? bases.alpha : bases.bravo;
      const homeD = Math.hypot(c.position.x - ownBase.x, c.position.z - ownBase.z);
      info += ` ${fl.team[0]}carrier homeD=${homeD.toFixed(0)} foes=[${ds.slice(0, 4).map((d) => d.toFixed(0)).join(',')}]`;
    }
    const flags = [...(room.flags?.flags.values() ?? [])].map((fl) => `${fl.team[0]}:${fl.state}`).join(' ');
    console.log(`  t=${clock.toFixed(0)}s score ${room.scores.alpha}-${room.scores.bravo} alive=${alive} flags ${flags}${info}`);
    if (process.argv.includes('--sample')) {
      // Who is where — role + position so "attackers never leave home"
      // reads as a roster picture, not a hunch.
      const roles = room.bots.roster?.roles as Map<string, string> | undefined;
      const line = all
        .filter((p) => p.isBot && !p.isDead)
        .map((p) => `${p.id.slice(-4)}:${p.team[0]}:${roles?.get(p.id) ?? '?'}(${p.position.x.toFixed(0)},${p.position.y.toFixed(0)},${p.position.z.toFixed(0)})`)
        .join(' ');
      console.log(`    ${line}`);
    }
  }
}

// Pair each grab with its outcome: capped (flag home + teamScore) or
// dropped; hold time is the contested-transit metric that matters.
let kills = 0, returns = 0;
const carries: { team: string; carrier: string | null; grabT: number; endT?: number; result: 'cap' | 'drop' | 'held'; dropCause?: 'died' | 'threw' }[] = [];
// Carrier-death correlation — a flagUpdate carries no drop cause, but
// "threw it" and "died holding it" are different failure modes. A
// playerKill of the carrier within ~1.5s before the drop lands = died;
// otherwise the carrier tossed it alive.
const diedAt = new Map<string, number>();
const prev: Record<string, { state: string; carrier: string | null }> = {};
// Where each carry died — drop spot vs the flag's own home stand, so
// "carriers die deep in enemy territory" and "killed on their own
// doorstep" read as different failure modes.
const dropDs: number[] = [];
for (const m of w.msgs as { type: string; _s?: number; targetId?: string; flags?: { team: string; state: string; carrier: string | null; pos?: { x: number; y: number; z: number }; home?: { x: number; y: number; z: number } }[] }[]) {
  if (m.type === 'playerKill') { kills++; if (m.targetId) diedAt.set(m.targetId, m._s ?? 0); }
  if (m.type !== 'flagUpdate') continue;
  for (const fl of m.flags ?? []) {
    const was = prev[fl.team];
    const now = { state: fl.state, carrier: fl.carrier };
    if (fl.state === 'carried' && was?.state !== 'carried') {
      carries.push({ team: fl.team, carrier: fl.carrier, grabT: m._s ?? 0, result: 'held' });
    } else if (was?.state === 'carried' && fl.state === 'dropped') {
      const c = carries.findLast((x) => x.team === fl.team && x.result === 'held');
      if (c) {
        c.endT = m._s ?? 0;
        c.result = 'drop';
        const sinceDeath = c.carrier !== null ? c.endT - (diedAt.get(c.carrier) ?? -Infinity) : Infinity;
        c.dropCause = sinceDeath >= 0 && sinceDeath <= 1.5 ? 'died' : 'threw';
      }
      if (fl.pos && fl.home) dropDs.push(Math.hypot(fl.pos.x - fl.home.x, fl.pos.z - fl.home.z));
    } else if (was?.state === 'carried' && fl.state === 'home') {
      // carried→home on the STOLEN flag only happens via cap or return-
      // reset; teamScore adjacency is not needed — the flag teleporting
      // home while carried IS the capture edge.
      const c = carries.findLast((x) => x.team === fl.team && x.result === 'held');
      if (c) { c.endT = m._s ?? 0; c.result = 'cap'; }
    } else if (fl.state === 'home' && was?.state === 'dropped') {
      returns++;
    }
    prev[fl.team] = now;
  }
}
const done = carries.filter((c) => c.result !== 'held');
const died = done.filter((c) => c.dropCause === 'died').length;
const threw = done.filter((c) => c.dropCause === 'threw').length;
const med = (a: number[]) => a.length ? a.sort((x, y) => x - y)[Math.floor(a.length / 2)]!.toFixed(1) : '-';
const wallS = (Date.now() - t0) / 1000;
console.log(`map=${FIELD || MAP} flagM=${flagM}m bots=${BOTS} sim=${MINS}min wall=${wallS.toFixed(0)}s (${(simS / wallS).toFixed(0)}x rt)`);
console.log(`score alpha=${room.scores.alpha} bravo=${room.scores.bravo}  matchEnd=${w.count('matchEnd')}`);
console.log(`kills=${kills} grabs=${carries.length} drops=${done.filter((c) => c.result === 'drop').length} (died=${died} threw=${threw}) caps=${done.filter((c) => c.result === 'cap').length} heldAtEnd=${carries.length - done.length} standReturns=${returns}`);
console.log(`  pushCalls a=${room.bots?.debugPushCalls?.('alpha') ?? 0} b=${room.bots?.debugPushCalls?.('bravo') ?? 0}`);
// Siege report: did the generator pair actually crack the grid?
const gens = [...(room.deployables?.items.values() ?? [])]
  .filter((d) => d.kind === 'generator')
  .map((d) => `${d.team?.[0] ?? '?'}:${d.hp.toFixed(0)}${d.hp <= 0 ? ' DEAD' : ''}`)
  .join(' ');
if (gens) console.log(`  gens ${gens}`);
if (dropDs.length) console.log(`  dropD-from-own-home: ${dropDs.map((d) => d.toFixed(0)).sort((a, b) => +a - +b).join(',')}m`);
if (done.length) {
  console.log(`carry outcomes: med hold=${med(done.map((c) => (c.endT ?? 0) - c.grabT))}s`);
  console.log(`  grabs: ${carries.map((c) => `${c.team[0]}@${c.grabT.toFixed(0)}s→${c.result === 'drop' ? c.dropCause : c.result}${c.endT ? `+${(c.endT - c.grabT).toFixed(0)}s` : ''}`).join('  ')}`);
}
