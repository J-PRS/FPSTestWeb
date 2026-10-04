// Trace a capper's real route on a real map and render it: approach
// (pre-grab) in cyan, carry (post-grab) in orange over the heightfield.
//   bun _tools/sweeps/tmp_capTrace.ts <map>
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hmParseBin, hmHeight, HM_WORLD_SCALE } from '../../shared/heightfield.ts';
import { mkRoom, step } from '../../server_bun/tests/scenarios/harness.ts';
import { BOT_LOADOUTS } from '../../shared/botLoadouts.ts';
import { WeaponType } from '../../shared/weapons.ts';

const name = process.argv[2] ?? 'peaks';
const spec = JSON.parse(readFileSync(resolve(import.meta.dir, `../../maps/${name}.json`), 'utf8'));
const f = hmParseBin(new Uint8Array(readFileSync(resolve(import.meta.dir, `../../maps/${spec.terrain}`))));
const at = (x: number, z: number) => ({ x, y: hmHeight(f, x, z), z });
const bases = { alpha: at(spec.bases.alpha.x, spec.bases.alpha.z), bravo: at(spec.bases.bravo.x, spec.bases.bravo.z) };

const room = mkRoom({ mode: 'ctf', bots: 6, bases }, 'ctf', 9001, false, f);
const bots = [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
const capper = bots.find((p) => p.team === 'alpha')!;
const ctl = room.bots as unknown as {
  loadouts: Map<string, (typeof BOT_LOADOUTS)[number]>;
  roster: { roles: Map<string, string>; refitClass(id: string): void };
};
ctl.loadouts.set(capper.id, { ...BOT_LOADOUTS[0]!, belt: WeaponType.DiscPull });
ctl.roster.refitClass(capper.id);
ctl.roster.roles.set(capper.id, 'capper');
for (const p of bots) {
  if (p !== capper) {
    room.bots.quiet.add(p.id);
    if (p.team === 'alpha') ctl.roster.roles.set(p.id, 'offense');
  }
}

const approach: [number, number][] = [];
const carry: [number, number][] = [];
let carrying = false;
let caps = 0;
const dt = 0.05;
for (let i = 0; i < 260 * 20 && caps === 0; i++) {
  step(room, 1, dt);
  const bf = room.flags!.flags.get('bravo')!;
  if (!carrying && bf.carrier === capper.id) carrying = true;
  if (carrying && bf.state === 'dropped') carrying = false;
  (carrying ? carry : approach).push([capper.position.x, capper.position.z]);
  if (bf.state === 'home' && carrying) caps++;
}
console.log(`trace [${name}]: approach=${approach.length}pts carry=${carry.length}pts caps=${caps} grabAt=${(approach.length * dt).toFixed(1)}s`);

// --- render ---
const S = 560; // svg px; world is HM_WORLD_SCALE square
const px = (w: number) => ((w / HM_WORLD_SCALE + 0.5) * S).toFixed(1);
const N = f.size;
// heightfield hillshade, decimated to ~140px cells
let rects = '';
const stepPx = 4;
for (let j = 0; j < N; j += stepPx) {
  for (let i = 0; i < N; i += stepPx) {
    const h0 = f.data[j * N + i]!;
    const hx = f.data[j * N + Math.min(N - 1, i + 1)]!;
    const hz = f.data[Math.min(N - 1, j + 1) * N + i]!;
    const shade = Math.max(0, Math.min(255, 128 + (hx - h0) * 10 + (hz - h0) * 6));
    const x0 = ((i / N - 0.5) * HM_WORLD_SCALE);
    const z0 = ((j / N - 0.5) * HM_WORLD_SCALE);
    rects += `<rect x="${px(x0)}" y="${px(z0)}" width="${(S / N * stepPx + 0.5).toFixed(1)}" height="${(S / N * stepPx + 0.5).toFixed(1)}" fill="rgb(${shade},${shade},${(shade * 0.9 + 20) | 0})"/>`;
  }
}
const path = (pts: [number, number][], stride: number) =>
  pts.filter((_, k) => k % stride === 0 || k === pts.length - 1).map(([x, z]) => `${px(x)},${px(z)}`).join(' ');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
<rect width="${S}" height="${S}" fill="#111"/>${rects}
<polyline points="${path(approach, 2)}" fill="none" stroke="#22d3ee" stroke-width="2" opacity="0.9"/>
<polyline points="${path(carry, 2)}" fill="none" stroke="#fb923c" stroke-width="2.5" opacity="0.95"/>
<circle cx="${px(bases.alpha.x)}" cy="${px(bases.alpha.z)}" r="6" fill="#60a5fa" stroke="#fff"/>
<circle cx="${px(bases.bravo.x)}" cy="${px(bases.bravo.z)}" r="6" fill="#f87171" stroke="#fff"/>
<text x="10" y="18" fill="#fff" font-size="13" font-family="monospace">${name} — cyan=approach, orange=carry (caps=${caps})</text>
</svg>`;
writeFileSync(resolve(import.meta.dir, `out/captrace_${name}.svg`), svg);
console.log(`wrote _tools/sweeps/out/captrace_${name}.svg`);
