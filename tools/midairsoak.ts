// Long accelerated bot-match soak — harvests every midair kill with its
// projectile's true flight age, shooter→victim distance, and weapon, so
// "the coolest shot" is a measured thing before any demo clip exists.
// Runs on the scenario harness (mkRoom/step/watch): real room, real map
// field, server bots, sim-clock warp — no sockets, no wire.
//   bun tools/midairsoak.ts --hours 2 --map henge --bots 20

import { readFileSync } from 'node:fs';
import { mkRoom, step, watch } from '../server_bun/tests/scenarios/harness.ts';
import { hmParseBin, hmHeight } from '../shared/heightfield.ts';
import { simNow, simNowReset } from '../server_bun/src/simClock.ts';
import { WeaponType } from '../shared/weaponTable.ts';
import type { ServerMessage } from '../shared/protocol.ts';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) => a.startsWith('--') ? [[a.slice(2), arr[i + 1] && !arr[i + 1]!.startsWith('--') ? arr[i + 1]! : 'true']] : [])
);
const HOURS = Number(args.hours ?? 1);
const MAP = String(args.map ?? 'henge');
const BOTS = Number(args.bots ?? 20);
const SEED = Number(args.seed ?? 4242);
const DT = 0.05;

const mapJson = JSON.parse(readFileSync(`maps/${MAP}.json`, 'utf8')) as {
  bases?: { alpha: { x: number; z: number }; bravo: { x: number; z: number } };
  teamSpawns?: Record<string, { x: number; z: number; r?: number; w?: number }[]>;
  terrain?: string;
  balls?: { base: number; perPlayer: number; max: number };
  creatures?: Record<string, number>;
  ambient?: Record<string, number>;
};
const field = hmParseBin(new Uint8Array(readFileSync(`maps/${mapJson.terrain ?? MAP + '.bin'}`)));

const ctf = !!mapJson.bases;
const baseAt = (x: number, z: number) => ({ x, y: hmHeight(field, x, z), z });
const spawnAt = (x: number, z: number, r: number, w: number) => ({ x, y: hmHeight(field, x, z), z, r, w });
const teamSpawns = ctf ? {
  alpha: mapJson.teamSpawns?.alpha ?? [{ ...mapJson.bases!.alpha, r: 50, w: 90 }],
  bravo: mapJson.teamSpawns?.bravo ?? [{ ...mapJson.bases!.bravo, r: 50, w: 90 }],
} : undefined;
const mode = ctf ? 'ctf' : 'tdm';

const room = mkRoom({
  mode, bots: BOTS, botFill: BOTS,
  balls: mapJson.balls, creatures: mapJson.creatures, ambient: mapJson.ambient,
  ...(ctf ? {
    bases: { alpha: baseAt(mapJson.bases!.alpha.x, mapJson.bases!.alpha.z), bravo: baseAt(mapJson.bases!.bravo.x, mapJson.bases!.bravo.z) },
    teamSpawns: Object.fromEntries(
      Object.entries(teamSpawns!).map(([t, ss]) => [t, ss.map((s) => spawnAt(s.x, s.z, s.r ?? 50, s.w ?? 90))]),
    ),
  } : {}),
}, mode, SEED, false, field);

// Attack ledger — the killing projectile's real flight age rides
// botAttack(..., airtime). Every contact lands here, killed or not, so
// the LAST attack against a victim is the kill hit (unless it fell or
// ate a non-projectile death, which has no airtime and never wins anyway).
interface Attack { shooter: string; victim: string; airtime?: number; weapon: number; t: number }
const attacks: Attack[] = [];
const origBotAttack = room.messages.combat.botAttack.bind(room.messages.combat);
room.messages.combat.botAttack = (shooterId: string, targetId: string, weaponType: number, airtime?: number, shotId?: string) => {
  attacks.push({ shooter: shooterId, victim: targetId, airtime, weapon: weaponType, t: simNow() });
  if (attacks.length > 4000) attacks.splice(0, 2000);
  return origBotAttack(shooterId, targetId, weaponType, airtime, shotId);
};

// AOE-kill ledger — botAttack only fires on direct body hits; a grenade
// or mortar blast kills inside serverBlast without ever touching it.
// Every detonation carries the projectile's REAL flight age, so a victim
// dying within the blast envelope attributes to the shell that popped.
interface Det { shooter: string; weapon: number; airtime: number; t: number; x: number; y: number; z: number; reach: number }
const dets: Det[] = [];
const origDet = room.projectiles.detonate.bind(room.projectiles);
room.projectiles.detonate = (proj: { id: string; ownerId: string; weaponType: number; stuck?: boolean; stats: { aoeRadius: number; cluster?: { count: number; radius: number } }; p: { pos: { x: number; y: number; z: number }; age: number } }, at: { x: number; y: number; z: number }, directHitId?: string | null, ballId?: number, bodyDirect?: boolean, crawlerId?: number) => {
  dets.push({
    shooter: proj.ownerId, weapon: proj.weaponType,
    // A glued bomb's fuse ages while stuck — fuse-time isn't flight, so
    // a stuck detonation reports age 0 (never wins a midair ranking).
    airtime: proj.stuck ? 0 : proj.p.age, t: simNow(),
    x: at.x, y: at.y, z: at.z,
    // Bomblets scatter inside the carrier's cluster radius — the kill
    // envelope is the union of carrier pop + rain coverage.
    reach: Math.max(proj.stats.aoeRadius, proj.stats.cluster ? proj.stats.cluster.radius + 20 : 0),
  });
  if (dets.length > 4000) dets.splice(0, 2000);
  return origDet(proj as never, at, directHitId, ballId, bodyDirect, crawlerId);
};

interface MidairKill {
  t: number; shooter: string; victim: string; airtime: number;
  weapon: number; dist: number; carryKm: number; // spawn->impact arc span
  blast?: boolean; // killed by the shell's blast, not the body
  victimAlt: number;  // victim height above terrain at death — the
  // "true midair" test: a 3s shell into a grounded runner isn't the clip
  shooterAlt: number; // shooter's own altitude — air-to-air vs ground snipe
}
const kills: MidairKill[] = [];
let totalKills = 0, meleeOrEnv = 0, unclaimed = 0;

const w = watch(room, () => simTicks * DT);
// Kill-time positions: msgs drain per batch, up to 100 sim-s late — a
// respawned pair would measure spawn-to-field, not the fight. Snapshot
// both ends as the broadcast fires (inside applyHit, at the kill tick).
interface KillStamp { _sx?: number; _sy?: number; _sz?: number; _vx?: number; _vy?: number; _vz?: number }
const origBroadcast = room.connections.broadcast;
room.connections.broadcast = (m: ServerMessage) => {
  if (m.type === 'playerKill') {
    const km = m as { shooterId?: string; targetId?: string } & KillStamp;
    const s = km.shooterId ? room.players.getPlayer(km.shooterId) : undefined;
    const v = km.targetId ? room.players.getPlayer(km.targetId) : undefined;
    km._sx = s?.position.x ?? 0; km._sy = s?.position.y ?? 0; km._sz = s?.position.z ?? 0;
    km._vx = v?.position.x ?? 0; km._vy = v?.position.y ?? 0; km._vz = v?.position.z ?? 0;
  }
  return origBroadcast(m);
};
let simTicks = 0;
let msgCur = 0;
const drainMsgs = () => {
  for (; msgCur < w.msgs.length; msgCur++) {
    const m = w.msgs[msgCur] as ServerMessage & { type: string };
    if (m.type !== 'playerKill') continue;
    totalKills++;
    const km = m as { shooterId: string; targetId: string; weapon?: number };
    if (!km.shooterId || km.shooterId === 'environment' || km.shooterId === km.targetId) { meleeOrEnv++; continue; }
    // Attribute: last attack ON this victim — the kill hit is the most
    // recent contact by construction (victim's dead afterwards).
    let atk: Attack | undefined;
    for (let i = attacks.length - 1; i >= 0; i--) {
      if (attacks[i]!.victim === km.targetId) { atk = attacks[i]; break; }
    }
    const kp = m as KillStamp;
    // victim Alt/dist read the kill-tick snapshot, not the (possibly
    // respawned) live roster position.
    const kpx = kp._vx ?? 0, kpy = kp._vy ?? 0, kpz = kp._vz ?? 0;
    const vAlt = kpy - Math.max(field ? hmHeight(field, kpx, kpz) : 0, room.moveSim.structureTop(kpx, kpz));
    const sAlt = (kp._sy ?? 0) - Math.max(field ? hmHeight(field, kp._sx ?? 0, kp._sz ?? 0) : 0, room.moveSim.structureTop(kp._sx ?? 0, kp._sz ?? 0));
    const kdist = Math.hypot((kp._sx ?? 0) - kpx, (kp._sy ?? 0) - kpy, (kp._sz ?? 0) - kpz);
    if (atk && atk.airtime !== undefined && atk.airtime > 0) {
      kills.push({
        t: simTicks * DT, shooter: km.shooterId, victim: km.targetId,
        airtime: atk.airtime, weapon: atk.weapon ?? km.weapon ?? -1,
        dist: kdist, carryKm: 0, blast: false, victimAlt: vAlt, shooterAlt: sAlt,
      });
      continue;
    }
    // No airtime attack → either an instant kill (hitscan/melee — never
    // midair) or a blast kill (grenade/mortar detonation inside whose
    // envelope the victim died). A covering detonation ≤400 sim-ms back
    // is the proximal lethal; otherwise the instant chip was the killer.
    const det = [...dets].reverse().find((d) =>
        simNow() - d.t <= 400 &&
        Math.hypot(kpx - d.x, kpy - d.y, kpz - d.z) <= d.reach * 1.15);
    if (det && det.airtime > 0) {
      kills.push({
        t: simTicks * DT, shooter: det.shooter, victim: km.targetId,
        airtime: det.airtime, weapon: det.weapon, dist: kdist,
        carryKm: 0, blast: true, victimAlt: vAlt, shooterAlt: sAlt,
      });
      continue;
    }
    if (!atk) { unclaimed++; continue; }
    meleeOrEnv++; // hitscan/melee — instant, never midair
  }
};

const totalTicks = Math.round(HOURS * 3600 / DT);
const BATCH = 2000; // 100 sim-seconds per batch
const wname = (wt: number) => WeaponType[wt] ?? `w${wt}`;
console.log(`[midairsoak] ${MAP}/${mode} ${BOTS} bots, ${HOURS}h sim (${totalTicks} ticks)`);
const wall0 = performance.now();
for (let done = 0; done < totalTicks; done += BATCH) {
  step(room, Math.min(BATCH, totalTicks - done), DT);
  // Sim-paced respawn pass — the wall setTimeout respawn lags hours of
  // sim-time behind at warp; without this the room bleeds to a few
  // survivors within minutes (fastSoak does the same call).
  room.messages.respawnTick(simNow());
  simTicks += Math.min(BATCH, totalTicks - done);
  drainMsgs();
  const wallMs = performance.now() - wall0;
  if (done % (BATCH * 18) === 0) {
    console.log(`  ${(simTicks * DT / 60).toFixed(0)} sim-min | ${(wallMs / 1000).toFixed(0)}s wall | ${totalKills} kills, ${kills.length} midair | simx ${(simTicks * DT / (wallMs / 1000)).toFixed(1)}`);
  }
}
drainMsgs();

// Launch-speed proxy for arc distance: airtime * muzzle speed isn't in
// the ledger, so report dist (straight-line) as the measured quantity.
kills.sort((a, b) => b.airtime - a.airtime);
const top = kills.slice(0, 30);
console.log(`\n=== ${totalKills} total kills: ${kills.length} midair, ${unclaimed} unattributed, ${meleeOrEnv} env/melee/self ===`);
console.log(`\nTOP ${top.length} longest midair kills (${MAP}, ${HOURS}h):`);
console.log(`  #  airtime  dist   vAlt   sAlt  weapon              shooter -> victim            t(sim)`);
for (const [i, k] of top.entries()) {
  console.log(`  ${String(i + 1).padStart(2)} ${k.airtime.toFixed(2).padStart(6)}s ${k.dist.toFixed(0).padStart(5)}m ${k.victimAlt.toFixed(0).padStart(4)}m ${k.shooterAlt.toFixed(0).padStart(4)}m  ${(wname(k.weapon) + (k.blast ? ' [aoe]' : '')).padEnd(18)} ${k.shooter.padEnd(14)} -> ${k.victim.padEnd(14)} ${(k.t / 60).toFixed(1)}m`);
}
// TRUE midair table — victim actually airborne at death (>3m). Long-air
// shells into grounded runners are long shots, not midair kills.
const trueAir = kills.filter((k) => k.victimAlt > 3).sort((a, b) => b.airtime - a.airtime).slice(0, 15);
console.log(`\nTRUE MIDAIR (victim >3m above terrain): ${kills.filter((k) => k.victimAlt > 3).length} of ${kills.length} midair kills`);
for (const [i, k] of trueAir.entries()) {
  console.log(`  ${String(i + 1).padStart(2)} ${k.airtime.toFixed(2).padStart(6)}s ${k.dist.toFixed(0).padStart(5)}m v+${k.victimAlt.toFixed(0).padStart(3)}m s+${k.shooterAlt.toFixed(0).padStart(3)}m  ${(wname(k.weapon) + (k.blast ? ' [aoe]' : '')).padEnd(18)} ${k.shooter.padEnd(14)} -> ${k.victim.padEnd(14)} ${(k.t / 60).toFixed(1)}m`);
}
const byWeapon = new Map<string, { n: number; best: number; sum: number }>();
for (const k of kills) {
  const e = byWeapon.get(wname(k.weapon)) ?? { n: 0, best: 0, sum: 0 };
  e.n++; e.sum += k.airtime; if (k.airtime > e.best) e.best = k.airtime;
  byWeapon.set(wname(k.weapon), e);
}
console.log(`\nper-weapon: kills / mean / longest airtime`);
for (const [name, e] of [...byWeapon.entries()].sort((a, b) => b[1].best - a[1].best)) {
  console.log(`  ${name.padEnd(16)} ${String(e.n).padStart(5)}  ${(e.sum / e.n).toFixed(2)}s  ${e.best.toFixed(2)}s`);
}
const wallMs = performance.now() - wall0;
console.log(`\n[done] ${(simTicks * DT / 3600).toFixed(2)} sim-hours in ${(wallMs / 1000).toFixed(0)}s wall (${(simTicks * DT / (wallMs / 1000)).toFixed(1)}x)`);
simNowReset();
