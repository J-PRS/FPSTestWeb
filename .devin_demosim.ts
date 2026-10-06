// Simulate 60s of a dense 10v10 through DemoRecorder, serialize, report size.
import { DemoRecorder } from './client/src/demo/DemoRecorder.js';
import type { RemoteSample } from './client/src/demo/DemoRecorder.js';
import { serializeDemo } from './client/src/demo/demoWriter.js';
import { buildDemoFile } from './client/src/demo/demoExtract.js';

const DT = 1 / 60;
const SECONDS = 60;
const REMOTES = 19; // 10v10 minus the local player

const rec = new DemoRecorder(90, 60); // buffer must exceed the clip length we extract

// --- local player: skiing at speed, slight weave; occasionally still ---
const local = {
  posX: 0, posY: 50, posZ: 0, velX: 38, velY: 0, velZ: 8,
  yaw: 0, pitch: -0.1, weaponType: 2,
};
const input = { inputFlags: 0x21 /* Forward|Ski */, mouseDeltaX: 0, mouseDeltaY: 0, jetpackFlags: 1, jetpackFuel: 80 };

// --- 19 remotes, all moving ---
const remotes: RemoteSample[] = [];
for (let i = 0; i < REMOTES; i++) {
  remotes.push({
    id: `player${i}`, posX: (i - 9) * 80, posY: 40 + (i % 4) * 5, posZ: (i % 5) * 120,
    velX: 20 + (i % 7) * 4, velY: 0, velZ: (i % 2 ? -1 : 1) * (12 + i),
    yaw: i * 0.4, pitch: 0, dead: false, ski: i % 3 === 0,
  });
}
rec.setRemoteSource(() => remotes);
rec.setContext({ room: 'tenvten', mode: 'ctf', playerName: 'pov' });
rec.start(local as never, input);

// --- combat: ~0.8 shots/sec from local, each gets bounce+hit; ~15 target events ---
let nextFire = 0.5, targetSeq = 1;
const live = new Set<number>();
let t = 0;
for (let step = 0; step < SECONDS * 60; step++) {
  t += DT;
  // advance local + remotes (everyone moving => no dead-reckon skips)
  local.posX += local.velX * DT; local.posZ += local.velZ * DT;
  local.yaw = Math.sin(t * 0.3) * 0.4; local.weaponType = 2 + (Math.floor(t / 10) % 2);
  for (const r of remotes) {
    r.posX += r.velX * DT; r.posZ += r.velZ * DT; r.yaw += DT * 0.2;
    if (Math.floor(t) % 13 === Math.floor(r.posX / 80 + 9)) r.dead = true; else r.dead = false;
  }
  // local fires ~0.8/s; each projectile resolves in ~0.6s
  if (t >= nextFire) {
    nextFire += 1.25;
    live.add(rec.recordFired({ x: local.posX, y: local.posY, z: local.posZ }, { x: local.velX + 200, y: 20, z: local.velZ }, 2));
  }
  if (step % 36 === 0 && live.size > 0) {
    const id = live.values().next().value!; live.delete(id);
    if (id % 3 === 0) rec.recordHit(id, { x: local.posX + 40, y: 40, z: local.posZ }, 1, 2);
    else rec.recordDestroyed(id, { x: local.posX + 120, y: 20, z: local.posZ });
  }
  if (step % 240 === 0) { // occasional creature/deployable target events
    rec.recordTargetSpawned(targetSeq, { x: 100, y: 40, z: 200 }, { x: 0, y: 0, z: 0 }, 1);
    rec.recordTargetHit(targetSeq, { x: 100, y: 40, z: 200 }, { x: 0, y: 0, z: 0 }, 1, 120);
    rec.recordTargetDestroyed(targetSeq++, { x: 100, y: 40, z: 200 }, 1);
  }
  // -- complete-coverage lanes: remote shots, creatures, deploys, kills, flags, pickups --
  if (step % 45 === 0) { // remote shots — ~1.3/s across the field
    rec.recordRemoteFired(`srv${step % 65000}`, { x: 50, y: 60, z: 50 }, { x: 150, y: 10, z: -40 }, 2);
  }
  if (step % 180 === 0) { // creatures — spawn/edge/die waves
    const id = 100 + (step % 12);
    if (step % 720 === 0) rec.recordCreatureSpawned(id, 'crawler', { x: 300, y: 40, z: 300 });
    rec.recordCreatureEdge(id, { x: 300, y: 40, z: 300 }, { x: 10, y: 0, z: 5 });
    if (step % 720 === 360) rec.recordCreatureDie(id, { x: 300, y: 40, z: 300 });
  }
  if (step % 300 === 0) { // deployables — spawn/hp/boom churn
    const id = 200 + ((step / 300) | 0) % 5;
    if (step % 1500 === 0) rec.recordDeploySpawned(id, 'turret', { x: -200, y: 40, z: 100 }, 'alpha');
    if (step % 1500 === 600) rec.recordDeployShot(id, { x: 0, y: 50, z: 0 });
    if (step % 1500 === 1200) rec.recordDeployBoom(id, { x: -200, y: 40, z: 100 });
  }
  if (step % 120 === 0) { // kills — ~0.5/s in a dense firefight
    rec.recordKill(`player${(step / 120 | 0) % REMOTES}`, `player${((step / 120 | 0) + 5) % REMOTES}`, 2, { x: 100, y: 40, z: 100 });
  }
  if (step % 900 === 0) { // flag transitions — carry/drop/return
    const states = ['carried', 'dropped', 'home'];
    rec.recordFlagUpdate('alpha', states[(step / 900 | 0) % 3], { x: -400, y: 42, z: 0 }, step % 900 === 0 ? 'player1' : null);
  }
  if (step % 600 === 0) { // pickups — spawn then gone 5s later
    const id = 300 + ((step / 600 | 0) % 4);
    if (step % 1200 === 0) rec.recordPickupSpawned(id, 'gem', { x: 20, y: 40, z: 20 });
    else rec.recordPickupGone(id - 1);
  }
  rec.update(DT);
}

const file = buildDemoFile(rec, '10v10 sim');
const buf = serializeDemo(file);
const kb = (n: number) => (n / 1024).toFixed(1);
console.log(`frames(local): ${file.frames.length}  remoteFrames: ${file.remoteFrames.length}`);
console.log(`projectileEvents: ${file.projectileEvents.length}  targetEvents: ${file.targetEvents.length}`);
console.log(`roster: ${file.roster.length}`);
console.log(`TOTAL: ${buf.byteLength} bytes = ${kb(buf.byteLength)} KiB (${(buf.byteLength / SECONDS / 1024).toFixed(1)} KiB/s)`);
