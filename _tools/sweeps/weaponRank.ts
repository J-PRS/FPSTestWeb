/**
 * weaponRank.ts — ladder the weapon_results.jsonl ledger that teamSoak
 * appends every pinned/mixed match to. Scoring is Bradley-Terry on the
 * WEAPON-attributed kills (not team score): each frag is a Bernoulli
 * trial "this weapon won the encounter", so a 2000-kill mirror carries
 * ~10x the evidence of a 200-kill one with no weighting fudge. MLE via
 * the standard MM iteration; ratings normalized so the median = 1.00.
 *
 *   bun _tools/sweeps/weaponRank.ts [--jsonl path] [--min-kills N]
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const arg = (n: string, d: string): string => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1]! : d; };
const FILE = resolve(arg('jsonl', 'C:/TEMP/_WEB/FPSWebTest/_tools/sweeps/out/weapon_results.jsonl'));
const MIN_K = Number(arg('min-kills', '50'));

interface Row { a: string; b: string; A?: { kills: number } | null; B?: { kills: number } | null; }

if (!existsSync(FILE)) { console.log(`no results at ${FILE}`); process.exit(0); }
const rows = (readFileSync(FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Row))
  .filter((r) => r.A && r.B && (r.A.kills + r.B.kills) >= MIN_K);

const weapons = [...new Set(rows.flatMap((r) => [r.a, r.b]))];
const p = new Map<string, number>(weapons.map((w) => [w, 1]));
const wins = new Map<string, number>(weapons.map((w) => [w, 0]));
for (const r of rows) {
  wins.set(r.a, wins.get(r.a)! + r.A!.kills);
  wins.set(r.b, wins.get(r.b)! + r.B!.kills);
}
// MM iteration: p_i = wins_i / sum_j(n_ij / (p_i + p_j))
for (let it = 0; it < 200; it++) {
  const den = new Map<string, number>(weapons.map((w) => [w, 0]));
  for (const r of rows) {
    const s = p.get(r.a)! + p.get(r.b)!, n = r.A!.kills + r.B!.kills;
    den.set(r.a, den.get(r.a)! + n / s);
    den.set(r.b, den.get(r.b)! + n / s);
  }
  for (const w of weapons) {if (wins.get(w)! > 0) {p.set(w, wins.get(w)! / Math.max(1e-9, den.get(w)!));}}
  const sum = [...p.values()].reduce((a, b) => a + b, 0);
  for (const w of weapons) {p.set(w, p.get(w)! / sum);}
}

const sorted = [...p.entries()].sort((x, y) => y[1] - x[1]);
const med = [...p.values()].sort((a, b) => a - b)[Math.floor(p.size / 2)] ?? 1;
console.log(`${rows.length} matches scored (min ${MIN_K} combined kills)`);
console.log(`strength | wins  | weapon`);
for (const [w, s] of sorted) {
  console.log(`${(s / med).toFixed(2).padStart(7)} | ${String(wins.get(w) ?? 0).padStart(5)} | ${w}`);
}
