/**
 * creatureGauntlet — one 'impossible'-skill bot vs a creature horde.
 * Each level is ONE life: fresh room, horde at that cap, the bot fights
 * until dead or the level timer expires. Metrics per level: median
 * survival seconds, kills, hp at death — the level where survival
 * collapses is the creature pressure ceiling for a lone elite.
 *
 * Usage:
 *   bun _tools/sweeps/creatureGauntlet.ts [--species crawler] [--runs 8]
 *     [--map raindance|--field] [--start 2] [--mult 1.4] [--lvl 60]
 *     [--maxlvl 12] [--seed 7] [--quiet 1] [--record out.rec]
 *
 * --record taps the LAST level's run into a .rec wire capture (spectator
 * view): creatures, shots, kills and tick frames all land, so the file
 * replays in-game as real gameplay via the dev __playRec hook.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hmParseBin, hmHeight } from '../../shared/heightfield.ts';
import { mkRoom, step } from '../../server_bun/tests/scenarios/harness.ts';
import { attachRec } from './recSink.ts';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1]! : d;
};
const SPECIES = ['crawler', 'snake', 'rakk', 'roller', 'baneling', 'gnat', 'scarab', 'totem'];
const ONLY = arg('species', '');           // one species or full mix
const RUNS = Number(arg('runs', 8));
const START = Number(arg('start', 2));     // caps per species at level 1
const MULT = Number(arg('mult', 1.4));     // caps multiplier per level
const LVL_S = Number(arg('lvl', 60));      // sim-seconds max per level
const MAXLVL = Number(arg('maxlvl', 12));
const SEED = Number(arg('seed', 7));
const QUIET = arg('quiet', '') === '1';
const REC = arg('record', '');            // .rec out path — last level only

const MAP = arg('map', 'raindance');
let f: ReturnType<typeof hmParseBin> | undefined;
let at: (x: number, z: number) => { x: number; y: number; z: number };
if (arg('field', '') === '1') {
  at = (x, z) => ({ x, y: 0, z });
} else {
  try {
    f = hmParseBin(new Uint8Array(readFileSync(resolve(import.meta.dir, `../../server_bun/${MAP}.bin`))), 1);
  } catch {
    f = hmParseBin(new Uint8Array(readFileSync(resolve(import.meta.dir, '../../server_bun/heightmap.bin'))), 1);
  }
  at = (x, z) => ({ x, y: hmHeight(f!, x, z), z });
}

interface LevelRow { caps: number; alive: number; kills: number; secs: number; hpEnd: number }

function runLevel(seed: number, lvl: number, capsPerSpecies: number): LevelRow {
  const species = ONLY ? [ONLY] : SPECIES;
  const pop: Record<string, number> = {};
  for (const s of species) pop[s] = Math.round(capsPerSpecies);
  const room = mkRoom(
    { mode: 'nuggets', bots: 0, botSkill: 'impossible',
      bases: { alpha: at(200, 0), bravo: at(-900, 800) },
      creatures: pop },
    'nuggets', seed + lvl * 1000, false, f,
  );
  room.bots.populate(1);
  const bot = [...room.players.getAllPlayers().values()][0]!;

  let kills = 0;
  const origKill = room.creatureSim.onKilled;
  room.creatureSim.onKilled = (by, pos) => { if (by === bot.id) kills++; origKill?.(by, pos); };

  const ticks = Math.round(LVL_S / 0.05);
  let t = 0;
  const rec = REC && lvl === MAXLVL ? attachRec(room, REC, () => t * 50) : null;
  for (; t < ticks && !bot.isDead; t++) { step(room, 1, 0.05); rec?.tick(); }
  rec?.close();
  return {
    caps: Math.round(capsPerSpecies) * species.length,
    alive: room.creatureSim.roster().length,
    kills,
    secs: +(t * 0.05).toFixed(1),
    hpEnd: bot.isDead ? 0 : Math.round(bot.health),
  };
}

const agg = new Map<number, { caps: number; kills: number[]; secs: number[]; hp: number[] }>();
let lvl = 0, capsN = START;
while (lvl++ < MAXLVL) {
  const a = agg.get(lvl) ?? { caps: 0, kills: [], secs: [], hp: [] };
  a.caps = Math.round(capsN) * (ONLY ? 1 : SPECIES.length);
  for (let r = 0; r < RUNS; r++) {
    const row = runLevel(SEED + r, lvl, capsN);
    a.kills.push(row.kills); a.secs.push(row.secs); a.hp.push(row.hpEnd);
  }
  agg.set(lvl, a);
  capsN *= MULT;
}
const med = (xs: number[]) => xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0;
const mn = (xs: number[]) => xs.length ? Math.min(...xs) : 0;
console.log(`creatureGauntlet  species=${ONLY || 'mix'}  bot=impossible  lvlTimer=${LVL_S}s  runs=${RUNS}`);
console.log('lvl caps  medSec minSec medKills medHpEnd');
for (const [l, a] of [...agg.entries()].sort((x, y) => x[0] - y[0])) {
  console.log(`${String(l).padStart(3)} ${String(a.caps).padStart(4)} ${String(med(a.secs)).padStart(6)} ${String(mn(a.secs)).padStart(6)} ${String(med(a.kills)).padStart(8)} ${String(med(a.hp)).padStart(7)}`);
}
