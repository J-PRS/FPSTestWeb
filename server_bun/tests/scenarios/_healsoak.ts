// Heal-beam soak — a tdm room of bots stepping ~10 sim-minutes.
// Reports whether medics actually fire the beam: heal.beam hb ticks,
// tank-refusals, pace-drops, medic role coverage, and healed-hp
// totals (ticks × HEALBEAM_PER_TICK, no misses — the beam is hitscan).
//   bun tests/scenarios/_healsoak.ts [bots] [simSecs]
import { mkRoom, step } from './harness.ts';
import { WeaponType, HEALBEAM_PER_TICK, HEALBEAM_ENERGY } from '../../../shared/weapons.ts';

const bots = Number(process.argv[2] ?? 16);
const simS = Number(process.argv[3] ?? 600);
const mode = process.argv[4] ?? 'tdm';

const room = mkRoom({ mode, bots, botFill: bots }, mode, 9001);
const ctl = room.bots as unknown as {
  loadouts: Map<string, { near: number; mid: number; far: number; belt: number; side: number }>;
  roster: { roles: Map<string, string>; roleInfo: Map<string, string> };
};

// Who carries the beam/nade — coverage BEFORE stepping so a zero-count
// soak reports 'nobody drew it' rather than 'they chose not to fire'.
const HB = WeaponType.HealBeam;
let carriers = 0;
for (const [id, lo] of ctl.loadouts) {
  const has = lo.near === HB || lo.mid === HB || lo.far === HB || lo.side === HB;
  if (has) {carriers += 1; console.log(`  beam kit  ${id}  near=${lo.near} mid=${lo.mid} far=${lo.far} side=${lo.side}`);}
}
const roles = [...ctl.roster.roles.entries()].filter(([, r]) => r === 'medic');
const teamed = [...room.players.getAllPlayers().values()].filter((p) => p.team).length;
console.log(`soak: ${bots} bots ${mode} — ${carriers} beam kits, ${roles.length} medic roles, ${teamed} teamed players`);

const t0 = Date.now();
const ticks = Math.round(simS / 0.05);
// Chunked steps so long runs print progress instead of looking hung.
for (let done = 0; done < ticks; done += 2400) {
  step(room, Math.min(2400, ticks - done));
  if ((done + 2400) % 7200 === 0 || done + 2400 >= ticks) {
    const s = (done + 2400) * 0.05;
    console.log(`  t=${s}s  heal.beam=${room.health.get('heal.beam') ?? 0}  tankDry=${room.health.get('drop.tankDry') ?? 0}  pace=${room.health.get('drop.healPace') ?? 0}`);
    // Diagnose: for each beam carrier, count hurt allies in latch range
    // — answers "never fires" as 'no patients' vs 'patients exist, still silent'.
    for (const [id, lo] of ctl.loadouts) {
      const has = lo.near === HB || lo.mid === HB || lo.far === HB || lo.side === HB;
      if (!has) {continue;}
      const p = room.players.getPlayer(id);
      if (!p || p.isDead) {continue;}
      let patients = 0, hurtTotal = 0, nearest = 1e9;
      for (const [aid, a] of room.players.getAllPlayers()) {
        if (aid === id || a.team !== p.team || a.isDead) {continue;}
        if (a.health >= a.maxHealth * 0.85) {continue;}
        hurtTotal += 1;
        const d = Math.hypot(a.position.x - p.position.x, a.position.y - p.position.y, a.position.z - p.position.z);
        nearest = Math.min(nearest, d);
        if (d <= 30.8) {patients += 1;}
      }
      console.log(`    ${id}@${p.team} hurt allies=${hurtTotal} inReach=${patients} nearest=${nearest === 1e9 ? '—' : nearest.toFixed(0)}m energy=${room.moveSim.energyOf(id)?.toFixed(0)}`);
    }
    const medics = [...ctl.roster.roleInfo.entries()].filter(([, r]) => r === 'medic');
    console.log(`    medic roles now: ${medics.length}`);
  }
}

const ticksBeam = room.health.get('heal.beam') ?? 0;
const dry = room.health.get('drop.tankDry') ?? 0;
const pace = room.health.get('drop.healPace') ?? 0;
console.log(`\nDONE ${simS}s sim in ${((Date.now() - t0) / 1000).toFixed(1)}s wall`);
console.log(`heal.beam ticks: ${ticksBeam}  (~${ticksBeam * HEALBEAM_PER_TICK} hp restored, ~${ticksBeam * HEALBEAM_ENERGY} energy spent)`);
console.log(`drop.tankDry: ${dry}   drop.healPace: ${pace}`);
// Non-heal sanity — the room actually fought, so hurt allies existed.
for (const [k, v] of [...room.health.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18)) {
  console.log(`  ${k}: ${v}`);
}
