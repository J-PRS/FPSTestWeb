// Accelerated bot-match soak WITH a live DemoRecorder — same lane routing
// as tools/demorec.ts's observer but fed from the offline room (no wire):
// every broadcast goes through the same recorder calls the browser's net
// handlers make, remote frames sample the room roster at the real 20Hz
// remote cadence, and the best midair kill is cut out with extractClip —
// shotTime−PRE → kill+POST, the flytime itself inside the clip.
//   bun tools/midairclip.ts --hours 1.1 --map katabatic_bare --seed 99 --out demos_out/

import { readFileSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { mkRoom, watch, roomRng } from '../server_bun/tests/scenarios/harness.ts';
import { hmParseBin, hmHeight } from '../shared/heightfield.ts';
import { simNow, simNowReset, simNowAdvance } from '../server_bun/src/simClock.ts';
import { botRng, botRngRelease, tauntRng } from '../shared/botRand.ts';
import { WeaponType } from '../shared/weaponTable.ts';
import type { ServerMessage } from '../shared/protocol.ts';
import { DemoRecorder, type RemoteSample } from '../client/src/demo/DemoRecorder.ts';
import { serializeDemo } from '../client/src/demo/demoWriter.ts';
import { extractClip } from '../client/src/demo/demoExtract.ts';
import { getWeaponStats, jitteredTtl, idSeed } from '../shared/weapons.ts';
import { GRAVITY } from '../shared/movement.ts';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) => a.startsWith('--') ? [[a.slice(2), arr[i + 1] && !arr[i + 1]!.startsWith('--') ? arr[i + 1]! : 'true']] : [])
);
const HOURS = Number(args.hours ?? 1.1);
const MAP = String(args.map ?? 'katabatic_bare');
const BOTS = Number(args.bots ?? 20);
const SEED = Number(args.seed ?? 99);
const OUT = String(args.out ?? 'demos_out');
const PRE = Number(args.pre ?? 5);   // seconds before the shot
const POST = Number(args.post ?? 5); // seconds after the kill
const NOREC = args.norec === 'true' || args.norec === true;
const DT = 0.05;
const PROJ_FLOOR_Y = -220, PROJ_HARD_TTL = 30;

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

// ── Kill attribution (same ledgers as midairsoak) ──────────────────────
interface Attack { shooter: string; victim: string; airtime?: number; weapon: number; t: number }
const attacks: Attack[] = [];
const origBotAttack = room.messages.combat.botAttack.bind(room.messages.combat);
room.messages.combat.botAttack = (shooterId: string, targetId: string, weaponType: number, airtime?: number, shotId?: string) => {
  attacks.push({ shooter: shooterId, victim: targetId, airtime, weapon: weaponType, t: simNow() });
  if (attacks.length > 4000) attacks.splice(0, 2000);
  return origBotAttack(shooterId, targetId, weaponType, airtime, shotId);
};
interface Det { shooter: string; weapon: number; airtime: number; t: number; x: number; y: number; z: number; reach: number }
const dets: Det[] = [];
const origDet = room.projectiles.detonate.bind(room.projectiles);
room.projectiles.detonate = (proj: { id: string; ownerId: string; weaponType: number; stuck?: boolean; stats: { aoeRadius: number; cluster?: { count: number; radius: number } }; p: { pos: { x: number; y: number; z: number }; age: number } }, at: { x: number; y: number; z: number }, directHitId?: string | null, ballId?: number, bodyDirect?: boolean, crawlerId?: number) => {
  dets.push({
    shooter: proj.ownerId, weapon: proj.weaponType,
    airtime: proj.stuck ? 0 : proj.p.age, t: simNow(),
    x: at.x, y: at.y, z: at.z,
    reach: Math.max(proj.stats.aoeRadius, proj.stats.cluster ? proj.stats.cluster.radius + 20 : 0),
  });
  if (dets.length > 4000) dets.splice(0, 2000);
  return origDet(proj as never, at, directHitId, ballId, bodyDirect, crawlerId);
};

// ── Demo recorder wiring — observer routing, offline source ────────────
// Local "camera": --shooter <name> pins it to a known killer (two-pass
// workflow — pass 1 --norec prints the leaderboard, pass 2 reruns with
// the winner's shooter so the clip rides the shooter's eyes). Default is
// the first bot, which makes a spectator clip but a boring POV.
const localBot = String(args.shooter ?? '') || [...room.players.getAllPlayers().keys()][0]!;
if (!room.players.getPlayer(localBot)) {
  console.error(`[midairclip] --shooter "${localBot}" not a player in this room`);
  simNowReset(); process.exit(1);
}
const rec = new DemoRecorder(HOURS * 3600 + 60, 60);
const remoteProjSim = new Map<string, { pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number }; age: number; ttl: number; gravity: boolean }>();
const ballVariants = new Map<number, number>();

rec.setRemoteSource(function* (): Iterable<RemoteSample> {
  for (const p of room.players.getAllPlayers().values()) {
    if (p.id === localBot) continue;
    yield {
      id: p.id, posX: p.position.x, posY: p.position.y, posZ: p.position.z,
      velX: p.velocity.x, velY: p.velocity.y, velZ: p.velocity.z,
      yaw: p.rotation.yaw, pitch: p.rotation.pitch, dead: p.isDead, ski: false,
    };
  }
});
rec.setContext({ room: MAP, mode, playerName: localBot });
rec.setHeightmap(field);
const self = () => room.players.getPlayer(localBot)!;
rec.start({
  get posX() { return self().position.x; }, get posY() { return self().position.y; }, get posZ() { return self().position.z; },
  get velX() { return self().velocity.x; }, get velY() { return self().velocity.y; }, get velZ() { return self().velocity.z; },
  get yaw() { return self().rotation.yaw; }, get pitch() { return self().rotation.pitch; }, get weaponType() { return localWeapon; },
}, {
  get inputFlags() { return 0; }, get mouseDeltaX() { return 0; }, get mouseDeltaY() { return 0; },
  get jetpackFlags() { return 0; }, get jetpackFuel() { return 0; },
});

// Offline soak records at 20fps — dead-reckon dedup can eat EVERY local
// frame across a still-bot window and then extractClip has nothing to
// anchor the camera to. Real client clips keep dedup on; this harness
// can afford the writes.
rec.deadReckon = false;
let killRouteSeen = 0, killRouteNull = 0;
// Viewmodel drives off the recorder's weaponType getter — feed it the last
// thing the local bot actually fired or the clip's gun animates a wrong
// (default) weapon. Local shells ride the same remote-fired lane as
// everyone else's: the demo's "local shot" distinction is about input
// replay, and we record no inputs — the projectile just needs to exist.
let localWeapon = 0;
const route = (m: ServerMessage) => {
  const r = rec;
  switch (m.type) {
    case 'ballSpawn':
      ballVariants.set(m.id, m.variant);
      r.recordTargetSpawned(m.id, m.position, m.velocity, m.variant);
      break;
    case 'ballSegment':
      r.recordTargetBounce(m.id, m.position, m.velocity, ballVariants.get(m.id) ?? 0);
      break;
    case 'ballRoster':
      for (const b of m.balls) {
        ballVariants.set(b.id, b.variant);
        r.recordTargetSpawned(b.id, b.position, b.velocity, b.variant);
      }
      break;
    case 'ballDie':
      r.recordTargetDestroyed(m.id, m.position, ballVariants.get(m.id) ?? 0);
      ballVariants.delete(m.id);
      break;
    case 'crawlSpawn': r.recordCreatureSpawned(m.id, m.species, m.position); break;
    case 'crawlEvt': r.recordCreatureEdge(m.id, m.position, m.velocity); break;
    case 'crawlRoster':
      for (const c of m.crawlers) r.recordCreatureRoster(c.id, c.species, c.position, c.velocity);
      break;
    case 'crawlDie': r.recordCreatureDie(m.id, m.position); break;
    case 'deploySpawn': r.recordDeploySpawned(m.id, m.kind, m.pos); break;
    case 'deployGone': r.recordDeployGone(m.id); break;
    case 'deployHp': r.recordDeployHp(m.id, m.hp); break;
    case 'deployDown': r.recordDeployHp(m.id, 0); break;
    case 'deployUp': r.recordDeployHp(m.id, 1); break;
    case 'turretShot': {
      const t = room.players.getPlayer(m.targetId)?.position ?? null;
      if (t) r.recordDeployShot(m.id, t);
      break;
    }
    case 'sentryShot': r.recordDeployShot(m.id, { x: m.x, y: m.y, z: m.z }); break;
    case 'mineBoom': r.recordDeployBoom(m.id, m.pos); break;
    case 'flagUpdate':
      for (const f of m.flags) r.recordFlagUpdate(f.team, f.state, f.pos, f.carrier);
      break;
    case 'pickupSpawn': r.recordPickupSpawned(m.id, m.kind ?? 'gem', m.pos); break;
    case 'pickupGone': r.recordPickupGone(m.id); break;
    case 'playerKill': {
      killRouteSeen++;
      const victimPos = room.players.getPlayer(m.targetId)?.position ?? null;
      if (victimPos) r.recordKill(m.shooterId === 'environment' ? null : m.shooterId, m.targetId, m.weapon ?? 0, victimPos);
      else killRouteNull++;
      break;
    }
    case 'projectileCreated': {
      if (m.ownerId === localBot) localWeapon = m.weaponType ?? 0;
      const stats = m.weaponType !== undefined ? getWeaponStats(m.weaponType) : undefined;
      remoteProjSim.set(m.projectileId, {
        pos: { ...m.position }, vel: { ...m.velocity }, age: 0,
        ttl: (stats && jitteredTtl(stats, idSeed(m.projectileId))) ?? PROJ_HARD_TTL,
        gravity: stats?.gravity ?? false,
      });
      if (m.ownerId === localBot) {
        // Local-lane event (shooter field 0): it's the POV bot's own gun —
        // playback kicks the viewmodel on these, like a real first-person
        // clip. Still register the pairing so Destroyed edges resolve.
        const id = r.recordFired(m.position, m.velocity, m.weaponType ?? 0);
        if (id !== 0) r.remoteProjIdByServerId.set(m.projectileId, id);
      } else {
        r.recordRemoteFired(m.projectileId, m.position, m.velocity, m.weaponType ?? 0, m.ownerId);
      }
      break;
    }
    case 'projectileDestroyed': {
      const sim = remoteProjSim.get(m.projectileId);
      if (sim) {
        r.recordRemoteDestroyed(m.projectileId, sim.pos);
        remoteProjSim.delete(m.projectileId);
      }
      break;
    }
  }
};

// Broadcast interception: recorder routing + kill-time position stamps.
interface KillStamp { _sx?: number; _sy?: number; _sz?: number; _vx?: number; _vy?: number; _vz?: number; _st?: number }
const msgs: (ServerMessage & KillStamp)[] = [];
room.connections.broadcast = (m: ServerMessage) => {
  const km = m as ServerMessage & KillStamp;
  if (m.type === 'playerKill') {
    const k = m as { shooterId?: string; targetId?: string };
    const s = k.shooterId ? room.players.getPlayer(k.shooterId) : undefined;
    const v = k.targetId ? room.players.getPlayer(k.targetId) : undefined;
    km._sx = s?.position.x ?? 0; km._sy = s?.position.y ?? 0; km._sz = s?.position.z ?? 0;
    km._vx = v?.position.x ?? 0; km._vy = v?.position.y ?? 0; km._vz = v?.position.z ?? 0;
    // Kill happens inside THIS tick — drain stamps at batch end, which
    // can sit ~100 sim-s later and shove the clip window off the shot.
    km._st = simTicks * DT;
  }
  msgs.push(km);
  if (!NOREC) route(m);
};

interface MidairKill { t: number; shooter: string; victim: string; airtime: number; weapon: number; dist: number; blast: boolean; victimAlt: number; shooterAlt: number }
const kills: MidairKill[] = [];
let totalKills = 0, instant = 0, unclaimed = 0;
let simTicks = 0, msgCur = 0;
const drainMsgs = () => {
  for (; msgCur < msgs.length; msgCur++) {
    const m = msgs[msgCur]!;
    if (m.type !== 'playerKill') continue;
    totalKills++;
    const km = m as { shooterId: string; targetId: string; weapon?: number };
    if (!km.shooterId || km.shooterId === 'environment' || km.shooterId === km.targetId) { instant++; continue; }
    let atk: Attack | undefined;
    for (let i = attacks.length - 1; i >= 0; i--) {
      if (attacks[i]!.victim === km.targetId) { atk = attacks[i]; break; }
    }
    const kp = m;
    const kpx = kp._vx ?? 0, kpy = kp._vy ?? 0, kpz = kp._vz ?? 0;
    const ground = (x: number, z: number) => Math.max(field ? hmHeight(field, x, z) : 0, room.moveSim.structureTop(x, z));
    const vAlt = kpy - ground(kpx, kpz);
    const sAlt = (kp._sy ?? 0) - ground(kp._sx ?? 0, kp._sz ?? 0);
    const kdist = Math.hypot((kp._sx ?? 0) - kpx, (kp._sy ?? 0) - kpy, (kp._sz ?? 0) - kpz);
    if (atk && atk.airtime !== undefined && atk.airtime > 0) {
      kills.push({ t: km._st ?? simTicks * DT, shooter: km.shooterId, victim: km.targetId, airtime: atk.airtime, weapon: atk.weapon ?? km.weapon ?? -1, dist: kdist, blast: false, victimAlt: vAlt, shooterAlt: sAlt });
      continue;
    }
    const det = [...dets].reverse().find((d) =>
      (km._st ?? 0) * 1000 - d.t <= 400 &&
      Math.hypot(kpx - d.x, kpy - d.y, kpz - d.z) <= d.reach * 1.15);
    if (det && det.airtime > 0) {
      kills.push({ t: km._st ?? simTicks * DT, shooter: det.shooter, victim: km.targetId, airtime: det.airtime, weapon: det.weapon, dist: kdist, blast: true, victimAlt: vAlt, shooterAlt: sAlt });
      continue;
    }
    if (!atk) { unclaimed++; continue; }
    instant++;
  }
};

const totalTicks = Math.round(HOURS * 3600 / DT);
const BATCH = 2000;
const wname = (wt: number) => WeaponType[wt] ?? `w${wt}`;
console.log(`[midairclip] ${MAP}/${mode} ${BOTS} bots seed ${SEED}, ${HOURS}h sim, recording...`);
const wall0 = performance.now();
// Per-tick drive, not harness step(): the recorder samples live positions
// and feeds them its own elapsedTime — both must advance with the sim.
// The room's seeded streams stay injected for the whole run — same
// objects step() wraps per call, so draws land identical to batch-soak
// order (that's what reproduces the kill table midairsoak printed).
const rng = roomRng(room);
if (rng.bot) botRng(rng.bot);
if (rng.taunt) tauntRng(rng.taunt);
for (let done = 0; done < totalTicks; done++) {
  for (const s of room.sims) s.tick(DT);
  simNowAdvance(DT * 1000);
  for (const [id, p] of remoteProjSim) {
    p.age += DT;
    p.pos.x += p.vel.x * DT; p.pos.y += p.vel.y * DT; p.pos.z += p.vel.z * DT;
    if (p.gravity) p.vel.y += GRAVITY * DT;
    if (p.age >= p.ttl || p.pos.y < PROJ_FLOOR_Y) {
      rec.recordRemoteDestroyed(id, p.pos);
      remoteProjSim.delete(id);
    }
  }
  if (!NOREC) rec.update(DT);
  simTicks++;
  if (done % BATCH === BATCH - 1) {
    // midairsoak parity: respawnTick runs between step() calls, i.e. with
    // the streams released — keep the same rng environment so respawn
    // draws land identical and the kill table reproduces.
    if (rng.bot) botRngRelease();
    if (rng.taunt) tauntRng(Math.random);
    room.messages.respawnTick(simNow());
    if (rng.bot) botRng(rng.bot);
    if (rng.taunt) tauntRng(rng.taunt);
    drainMsgs();
    const wallMs = performance.now() - wall0;
    if (done % (BATCH * 18) === BATCH - 1 || done === 0) {
      console.log(`  ${(simTicks * DT / 60).toFixed(0)} sim-min | ${(wallMs / 1000).toFixed(0)}s wall | ${totalKills} kills, ${kills.length} midair | ${remoteProjSim.size} live shells`);
    }
  }
}
if (rng.bot) botRngRelease();
if (rng.taunt) tauntRng(Math.random);

drainMsgs();
rec.stop();

// Pick the winner: longest non-AOE midair kill (a direct hit reads as
// "the shot", an aoe splash reads as "the blast" — JP's pick was direct).
// --minalt N filters to airborne shooters (N meters above ground) — a
// stationary artillery bot's POV is authentic but reads as a frozen cam.
const MINALT = Number(args.minalt ?? '0');
const pool = kills.filter((k) => !k.blast && k.shooterAlt >= MINALT);
pool.sort((a, b) => b.airtime - a.airtime);
console.log(`\n${totalKills} kills: ${kills.length} midair (${pool.length} direct), ${instant} instant, ${unclaimed} unattributed`);
console.log(`top 10 direct midair:`);
for (const [i, k] of pool.slice(0, 10).entries()) {
  console.log(`  ${i + 1}. ${k.airtime.toFixed(2)}s ${wname(k.weapon)} ${k.dist.toFixed(0)}m v+${k.victimAlt.toFixed(0)} s+${k.shooterAlt.toFixed(0)} ${k.shooter} -> ${k.victim} @${(k.t / 60).toFixed(1)}m`);
}
const PICK = Number(args.pick ?? '1') - 1;
const best = pool[PICK] ?? pool[0];
if (!best) { console.log('no direct midair kill — nothing to clip'); simNowReset(); process.exit(0); }
if (NOREC) {
  console.log(`[norec] pick #${PICK + 1}: ${wname(best.weapon)} ${best.airtime.toFixed(2)}s — shooter ${best.shooter} (pass 2: --shooter ${best.shooter})`);
  simNowReset(); process.exit(0);
}

// shotTime = killTime − airtime; clip = PRE before the shot → POST after
// the kill. Times are recorder elapsedTime = simTicks*DT — same domain.
const killT = best.t, shotT = best.t - best.airtime;
const clipStart = Math.max(0, shotT - PRE), clipEnd = killT + POST;
const desc = `${wname(best.weapon)} ${best.airtime.toFixed(2)}s air, ${best.dist.toFixed(0)}m — ${best.shooter} -> ${best.victim}`;
const inWin = rec.remoteFrames.filter((f) => f.timestamp >= clipStart && f.timestamp <= clipEnd).length;
console.log(`[dbg] buffers: local ${rec.frameBuffer.Count}, remote ${rec.remoteFrames.length} (${inWin} in clip window), proj ${rec.projectileEvents.length}, tgt ${rec.targetEvents.length}`);
console.log(`[dbg] remote ts range ${rec.remoteFrames[0]?.timestamp.toFixed(1)} .. ${rec.remoteFrames[rec.remoteFrames.length - 1]?.timestamp.toFixed(1)}`);
console.log(`[dbg] killRoute seen=${killRouteSeen} nullVictim=${killRouteNull}; rec.targetEvents with kill type=${rec.targetEvents.filter((e) => e.targetType === 224).length}`);
console.log(`[dbg] kills in clip window: ${rec.targetEvents.filter((e) => e.targetType === 224 && e.timestamp >= clipStart && e.timestamp <= clipEnd).length}, kill event ts near killT: ${rec.targetEvents.filter((e) => e.targetType === 224 && Math.abs(e.timestamp - killT) < 10).map((e) => e.timestamp.toFixed(2)).join(',') || 'none'}`);
console.log(`[dbg] local buf span: ${rec.frameBuffer.Count ? rec.frameBuffer.peekOldest().timestamp.toFixed(1) : '-'} .. ${rec.frameBuffer.Count ? rec.frameBuffer.peekNewest().timestamp.toFixed(1) : '-'}`);
const clip = extractClip(rec, clipStart, clipEnd, desc, best.airtime);
if (!clip) { console.log('extractClip returned null (buffer window missed the shot)'); simNowReset(); process.exit(1); }

// POV swap: the recording "local" is an arbitrary observer bot — reseat
// the clip's local lane on the WINNING shooter by promoting his own
// remote samples to local frames (his recorded pos/vel/yaw at 20Hz —
// plenty for a camera track). His remote replicas and shooter-stamped
// Fired events get re-read as local too: no body glued to the camera,
// and the viewmodel kicks on HIS shots.
if (best.shooter !== localBot) {
  const shooterIdx = rec.rosterIdxById.get(best.shooter);
  if (shooterIdx === undefined) { console.log(`shooter ${best.shooter} never entered roster — keeping observer POV`); }
  else {
    const sFrames = rec.remoteFrames.filter((f) => f.rosterIdx === shooterIdx && f.timestamp >= clipStart && f.timestamp <= clipEnd);
    if (sFrames.length === 0) { console.log('shooter has no remote samples in window — keeping observer POV'); }
    else {
      // His fired weapons by time — remote-fired events stamped
      // targetId=shooterIdx+1 carry the weapon id.
      const shots = clip.projectileEvents.filter((e) => e.eventType === 0 && e.targetId === shooterIdx + 1)
        .sort((a, b) => a.timestamp - b.timestamp);
      let si = 0, curW = 0;
      clip.frames = sFrames.map((f, n) => {
        while (si < shots.length && shots[si]!.timestamp <= f.timestamp) { curW = shots[si]!.weaponType; si++; }
        return {
          frameNumber: n % 65_536, timestamp: f.timestamp - clipStart,
          posX: f.posX, posY: f.posY, posZ: f.posZ, velX: f.velX, velY: f.velY, velZ: f.velZ,
          yaw: f.yaw, pitch: f.pitch,
          inputFlags: 0, mouseDeltaX: 0, mouseDeltaY: 0, jetpackFlags: 0, jetpackFuel: 0,
          weaponType: curW,
        };
      });
      clip.remoteFrames = clip.remoteFrames.filter((f) => f.rosterIdx !== shooterIdx);
      for (const e of clip.projectileEvents) { if (e.eventType === 0 && e.targetId === shooterIdx + 1) e.targetId = 0; }
      clip.header.playerName = best.shooter;
      const f0 = clip.frames[0]!;
      clip.header.startPosX = f0.posX; clip.header.startPosY = f0.posY; clip.header.startPosZ = f0.posZ;
      clip.header.startYaw = f0.yaw; clip.header.startPitch = f0.pitch;
      clip.header.startVelX = f0.velX; clip.header.startVelY = f0.velY; clip.header.startVelZ = f0.velZ;
      clip.header.totalFrames = clip.frames.length;
      console.log(`[clip] POV reseated on shooter ${best.shooter} (${sFrames.length} promoted frames)`);
    }
  }
}
const buf = serializeDemo(clip);
await mkdir(OUT, { recursive: true });
const path = join(OUT, `midair_${wname(best.weapon)}_${best.airtime.toFixed(2)}s_${MAP}.demo`);
await writeFile(path, new Uint8Array(buf));
console.log(`\n[clip] ${desc}`);
console.log(`[clip] window [${clipStart.toFixed(1)}s .. ${clipEnd.toFixed(1)}s] (shot ${shotT.toFixed(1)}s, kill ${killT.toFixed(1)}s)`);
console.log(`[clip] wrote ${path}: ${buf.byteLength} bytes (${clip.frames.length} local, ${clip.remoteFrames.length} remote, ${clip.projectileEvents.length} proj, ${clip.targetEvents.length} tgt, ${clip.killEvents?.length ?? 0} kills)`);
const pitches = clip.remoteFrames.map((f) => f.pitch);
console.log(`[clip] remote pitch: nonzero ${pitches.filter((p) => Math.abs(p) > 0.01).length}/${pitches.length}, min ${Math.min(...pitches).toFixed(2)}, max ${Math.max(...pitches).toFixed(2)}`);
const wallMs = performance.now() - wall0;
console.log(`[done] ${(simTicks * DT / 3600).toFixed(2)} sim-hours in ${(wallMs / 1000).toFixed(0)}s wall (${(simTicks * DT / (wallMs / 1000)).toFixed(1)}x)`);
simNowReset();
