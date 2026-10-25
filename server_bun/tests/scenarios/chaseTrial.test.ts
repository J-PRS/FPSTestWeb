import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkRoom, step, watch } from './harness.ts';
import { hmParseBin, hmHeight } from '../../../shared/heightfield.ts';
import { BOT_LOADOUTS } from '../../../shared/botLoadouts.ts';
import { WeaponType } from '../../../shared/weapons.ts';

// Chaser-vs-capper weapon trials: a light pull-disc capper runs the
// peaks route while one ldefense chaser pursues with ONE weapon forced
// into every fire slot. Per weapon we score the honest chase metrics —
// shots, hits, min gap, whether the carrier dies or caps, and the
// transit time — so the pursuit kit is chosen by data, not vibes.
const field = hmParseBin(new Uint8Array(readFileSync(`${import.meta.dir}/../../../maps/peaks.bin`)));
const baseAt = (x: number, z: number) => ({ x, y: hmHeight(field, x, z), z });
const BASES = { alpha: baseAt(-150, 0), bravo: baseAt(150, 0) };

const TRIALS: { name: string; weapon: WeaponType }[] = [
  { name: 'chaingun', weapon: WeaponType.Chaingun },
  { name: 'lightning', weapon: WeaponType.Lightning },
  { name: 'railgun', weapon: WeaponType.Railgun },
  { name: 'bolt', weapon: WeaponType.BoltLauncher },
  { name: 'disc', weapon: WeaponType.Disc },
];

interface Trial {
  name: string;
  shots: number; hits: number;
  minGap: number; avgGap: number;
  killT: number;       // sim-s to carrier death (0 = survived)
  capT: number;        // sim-s to cap (0 = no cap)
  dealt: number;
}

function chase(trialWeapon: WeaponType, name: string): Trial {
  const room = mkRoom({
    mode: 'ctf', bots: 2,
    bases: BASES,
  }, 'ctf', 9001, false, field);
  const w = watch(room);

  const bots = [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
  const capper = bots.find((p) => p.team === 'alpha')!;
  const chaser = bots.find((p) => p.team === 'bravo')!;
  const ctl = room.bots as unknown as {
    loadouts: Map<string, (typeof BOT_LOADOUTS)[number]>;
    roster: { roles: Map<string, string>; refitClass(id: string): void };
  };
  // Runner: featherjets light + pull disc, capper job.
  ctl.loadouts.set(capper.id, { ...BOT_LOADOUTS[0]!, belt: WeaponType.Implodisc });
  ctl.roster.refitClass(capper.id);
  ctl.roster.roles.set(capper.id, 'capper');
  // Chaser: trial weapon in every fire slot so the pick can't dodge it;
  // belt stays a propel tool — pursuit still needs the speed.
  const lo = BOT_LOADOUTS[0]!;
  ctl.loadouts.set(chaser.id, { ...lo, near: trialWeapon, mid: trialWeapon, far: trialWeapon });
  ctl.roster.refitClass(chaser.id);
  ctl.roster.roles.set(chaser.id, 'ldefense');

  const t: Trial = { name, shots: 0, hits: 0, minGap: Infinity, avgGap: 0, killT: 0, capT: 0, dealt: 0 };
  const dt = 0.05;
  let simT = 0;
  let gapSum = 0, gapN = 0;
  for (let i = 0; i < 60 * 180 && !t.killT && !t.capT; i++) {
    step(room, 1, dt);
    simT += dt;
    // Score the duel only once the flag is actually moving.
    const bravoFlag = room.flags!.flags.get('bravo')!;
    if (bravoFlag.carrier === capper.id) {
      const gap = Math.hypot(
        capper.position.x - chaser.position.x,
        capper.position.y - chaser.position.y,
        capper.position.z - chaser.position.z);
      t.minGap = Math.min(t.minGap, gap);
      gapSum += gap; gapN++;
      if (bravoFlag.state === 'home') {t.capT = simT;}
    }
    if (capper.isDead && bravoFlag.carrier !== capper.id) {t.killT = simT;}
    // Late events land after the flag check — read the wire each tick.
    for (const m of w.msgs.splice(0)) {
      const mm = m as unknown as Record<string, unknown>;
      if (mm.type === 'playerShot' && mm.id === chaser.id) {t.shots++;}
      if (mm.type === 'playerHit' && mm.shooterId === chaser.id && mm.targetId === capper.id) {
        t.hits++; t.dealt += Number(mm.damage) || 0;
      }
    }
  }
  t.avgGap = gapN ? gapSum / gapN : 0;
  if (t.minGap === Infinity) {t.minGap = 0;}
  return t;
}

describe('scenario: chaser weapon trials', () => {
  it('one chaser vs one escaping capper — rank the pursuit weapons', () => {
    const rows: Trial[] = [];
    for (const tr of TRIALS) {rows.push(chase(tr.weapon, tr.name));}
    console.log('  chase trials (peaks 300m, light capper vs one ldefense):');
    console.log('  weapon      shots  hits  dealt  minGap  avgGap  killT   capT');
    for (const r of rows) {
      console.log(
        `  ${r.name.padEnd(11)} ${String(r.shots).padStart(5)} ${String(r.hits).padStart(5)} ` +
        `${r.dealt.toFixed(0).padStart(6)} ${r.minGap.toFixed(0).padStart(6)} ${r.avgGap.toFixed(0).padStart(7)} ` +
        `${(r.killT ? r.killT.toFixed(1) : '-').padStart(6)} ${(r.capT ? r.capT.toFixed(1) : '-').padStart(6)}`,
      );
    }
    // The duel has to resolve one way or the other — a chase where the
    // capper neither dies nor caps means the pursuit goal never engaged.
    expect(rows.some((r) => r.killT > 0 || r.capT > 0)).toBe(true);
  }, 300_000);
});
