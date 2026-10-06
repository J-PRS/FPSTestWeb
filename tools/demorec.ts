// Headless demo recorder — boots a real GameServer, fills the room with
// real NetBot fighters, attaches an OBSERVER NetClient that feeds the
// actual client DemoRecorder the same way the browser's net handlers do,
// then writes .demo files to disk. Usage:
//   bun tools/demorec.ts --duration 60 --bots 10 --matches 2 --out demos_out/

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { GameServer } from '../server_bun/src/GameServer.ts';
import { RtcServer } from '../server_bun/src/RtcServer.ts';
import type { WebSocketData } from '../server_bun/src/types.ts';
import type { ServerMessage } from '../shared/protocol.ts';
import { NetClient } from './netbot/netClient.ts';
import { NetBot } from './netbot/bot.ts';
import { LatencyLink } from './netbot/latency.ts';
import { BOT_LOADOUTS, botClassForLoadout } from '../shared/botLoadouts.ts';
import { DemoRecorder } from '../client/src/demo/DemoRecorder.ts';
import type { RemoteSample } from '../client/src/demo/DemoRecorder.ts';
import { serializeDemo } from '../client/src/demo/demoWriter.ts';
import { getWeaponStats, idSeed, jitteredTtl } from '../shared/weapons.ts';
import { GRAVITY } from '../shared/movement.ts';

// Wire projectiles never carry a destroy edge for claim-path shots — the
// replica dies locally on fuse/terrain. Mirror the browser: jitteredTtl
// seeded by the server id pops the replica at the same age.
const PROJ_FLOOR_Y = -220;
const PROJ_HARD_TTL = 30;

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) => a.startsWith('--') ? [[a.slice(2), arr[i + 1] && !arr[i + 1]!.startsWith('--') ? arr[i + 1]! : 'true']] : [])
);
const DURATION = Number(args.duration ?? 60);
const BOTS = Number(args.bots ?? 10);
const MATCHES = Number(args.matches ?? 2);
const OUT = String(args.out ?? 'demos_out');
const ROOM = String(args.room ?? '');
const MODE = String(args.mode ?? '');
const SERVERBOTS = Number(args.serverbots ?? 0);
const PLANT = args.plant === 'true'; // a scripted client plants deployables
const CAPPERS = Number(args.cappers ?? 2); // fighters pinned to the flag-run role
const BUFFER_SECONDS = DURATION + 30; // keep the whole match in the ring

function bootServer() {
  const gs = new GameServer();
  const rtc = new RtcServer(gs);
  const server = Bun.serve<WebSocketData>({
    port: 0,
    websocket: {
      data: {} as WebSocketData,
      open(ws) { ws.data.rtcs ? rtc.onOpen(ws) : gs.onOpen(ws); },
      message(ws, m) { (ws.data.rtcs ? rtc : gs).onMessage(ws, m as string | ArrayBuffer); },
      close(ws) { ws.data.rtcs ? rtc.onClose(ws) : gs.onClose(ws); },
      drain(ws) { if (!ws.data.rtcs) gs.onDrain(ws); },
    },
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === '/ws' || url.pathname === '/rtcs') {
        if (srv.upgrade(req, { data: { playerId: '', connectedAt: Date.now(), rtcs: url.pathname === '/rtcs' } })) return undefined;
        return new Response('upgrade failed', { status: 400 });
      }
      return new Response('nf', { status: 404 });
    },
  });
  gs.setBunServer(server);
  return { gs, server, url: `ws://127.0.0.1:${server.port}/ws` };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Observer: a NetClient whose every ServerMessage is also fed into the
 *  DemoRecorder lanes — same routing the browser net/ handlers use. */
class DemoObserver extends NetClient {
  rec = new DemoRecorder(BUFFER_SECONDS, 60);
  ballVariants = new Map<number, number>();
  remoteProjSim = new Map<string, {
    pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number };
    age: number; ttl: number; gravity: boolean;
  }>();

  /** Ballistic step for the remote-replica fuse sim — same math the
   *  client Projectile runs for non-stuck shells. */
  stepRemoteProjectiles(dt: number): void {
    for (const [id, p] of this.remoteProjSim) {
      p.age += dt;
      p.pos.x += p.vel.x * dt;
      p.pos.y += p.vel.y * dt;
      p.pos.z += p.vel.z * dt;
      if (p.gravity) p.vel.y += GRAVITY * dt;
      if (p.age >= p.ttl || p.pos.y < PROJ_FLOOR_Y) {
        this.rec.recordRemoteDestroyed(id, p.pos);
        this.remoteProjSim.delete(id);
      }
    }
  }

  constructor(url: string, joinOpts: ConstructorParameters<typeof NetClient>[3] = {}) {
    super(url, 'demo_observer', new LatencyLink({ pingMs: 0, jitterMs: 0, lossRate: 0 }), joinOpts);
    const nc = this;
    this.rec.setRemoteSource(function* (): Iterable<RemoteSample> {
      for (const [id, e] of nc.roster) {
        yield { id, posX: e.pos.x, posY: e.pos.y, posZ: e.pos.z, velX: e.vel.x, velY: e.vel.y, velZ: e.vel.z, yaw: 0, pitch: 0, dead: e.isDead, ski: false };
      }
    });
    this.rec.setContext({ room: 'headless', mode: 'ctf', playerName: this.id });
  }

  startRecording(): void {
    const nc = this;
    this.rec.start({
      get posX() { return nc.self.pos.x; }, get posY() { return nc.self.pos.y; }, get posZ() { return nc.self.pos.z; },
      get velX() { return nc.self.vel.x; }, get velY() { return nc.self.vel.y; }, get velZ() { return nc.self.vel.z; },
      get yaw() { return 0; }, get pitch() { return 0; }, get weaponType() { return 0; },
    }, {
      get inputFlags() { return 0; }, get mouseDeltaX() { return 0; }, get mouseDeltaY() { return 0; },
      get jetpackFlags() { return 0; }, get jetpackFuel() { return 0; },
    });
  }

  onMessage(m: ServerMessage): void {
    super.onMessage(m);
    const r = this.rec;
    switch (m.type) {
      case 'ballSpawn':
        this.ballVariants.set(m.id, m.variant);
        r.recordTargetSpawned(m.id, m.position, m.velocity, m.variant);
        break;
      case 'ballSegment':
        r.recordTargetBounce(m.id, m.position, m.velocity, this.ballVariants.get(m.id) ?? 0);
        break;
      case 'ballRoster':
        for (const b of m.balls) {
          this.ballVariants.set(b.id, b.variant);
          r.recordTargetSpawned(b.id, b.position, b.velocity, b.variant);
        }
        break;
      case 'ballDie':
        r.recordTargetDestroyed(m.id, m.position, this.ballVariants.get(m.id) ?? 0);
        this.ballVariants.delete(m.id);
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
        const t = this.roster.get(m.targetId)?.pos ?? (m.targetId === this.id ? this.self.pos : null);
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
        const victimPos = this.roster.get(m.targetId)?.pos ?? (m.targetId === this.id ? this.self.pos : null);
        if (victimPos) r.recordKill(m.shooterId === 'environment' ? null : m.shooterId, m.targetId, m.weapon ?? 0, victimPos);
        break;
      }
      case 'projectileCreated': {
        if (m.ownerId === this.id) break;
        const stats = m.weaponType !== undefined ? getWeaponStats(m.weaponType) : undefined;
        this.remoteProjSim.set(m.projectileId, {
          pos: { ...m.position }, vel: { ...m.velocity }, age: 0,
          ttl: (stats && jitteredTtl(stats, idSeed(m.projectileId))) ?? PROJ_HARD_TTL,
          gravity: stats?.gravity ?? false,
        });
        r.recordRemoteFired(m.projectileId, m.position, m.velocity, m.weaponType ?? 0);
        break;
      }
      case 'projectileDestroyed': {
        const sim = this.remoteProjSim.get(m.projectileId);
        if (sim) {
          r.recordRemoteDestroyed(m.projectileId, sim.pos);
          this.remoteProjSim.delete(m.projectileId);
        }
        break;
      }
    }
  }
}

for (let match = 0; match < MATCHES; match++) {
  const env = bootServer();
  const roomOpts = { ...(ROOM ? { room: ROOM } : {}), ...(MODE ? { mode: MODE } : {}), ...(SERVERBOTS ? { bots: SERVERBOTS } : {}) };
  const obs = new DemoObserver(env.url, roomOpts);
  await obs.connect();
  const bots: { nc: NetClient; bot: NetBot }[] = [];
  for (let i = 0; i < BOTS; i++) {
    const lo = BOT_LOADOUTS[i % BOT_LOADOUTS.length]!;
    const nc = new NetClient(env.url, `fighter_${i}`, new LatencyLink({ pingMs: 30, jitterMs: 15, lossRate: 0 }), { ...roomOpts, armorClass: botClassForLoadout(lo) });
    const bot = new NetBot(nc, { loadout: lo, capper: i < CAPPERS });
    bots.push({ nc, bot });
    await nc.connect();
    await sleep(60);
  }
  // Scripted planter: exercises the deploy lane (spawn/hp/gone + turret
  // tracers + mine booms) and the 'nugget' kind mints ground gems for the
  // pickup lane — NetBots themselves never plant.
  let planter: NetClient | undefined;
  let plantTimer: ReturnType<typeof setInterval> | undefined;
  if (PLANT) {
    planter = new NetClient(env.url, 'planter', new LatencyLink({ pingMs: 20, jitterMs: 10, lossRate: 0 }), roomOpts);
    await planter.connect();
    const kinds = ['turret', 'sentry', 'mine', 'station', 'beacon', 'nugget'];
    let ki = 0;
    plantTimer = setInterval(() => {
      if (!planter) return;
      const p = planter.self.pos;
      planter.send({ type: 'deploy', kind: kinds[ki++ % kinds.length]!, position: { x: p.x + 3, y: p.y, z: p.z + 3 } });
    }, 7000);
  }
  // v5 HMAP trailer — wait for the observer's heightfield fetch (async
  // loadField rides alongside connect), then snapshot the coarse grid.
  for (let i = 0; i < 100 && !obs.field; i++) await sleep(50);
  obs.rec.setHeightmap(obs.field);
  for (const b of bots) b.bot.start();
  obs.startRecording();
  console.log(`[demorec] match ${match + 1}: ${BOTS} fighters + observer, ${DURATION}s`);

  // Wall-clock dt — timer coalescing under load would otherwise
  // under-record the clip's true duration.
  let lastTick = Date.now();
  const tickTimer = setInterval(() => {
    const now = Date.now();
    const dt = (now - lastTick) / 1000;
    obs.stepRemoteProjectiles(dt);
    obs.rec.update(dt);
    lastTick = now;
  }, 1000 / 60);
  await sleep(DURATION * 1000);
  clearInterval(tickTimer);
  obs.rec.stop();

  const file = obs.rec.buildDemoFile(`headless bot match ${match + 1} (${BOTS}v${BOTS === 1 ? 0 : BOTS})`);
  const buf = serializeDemo(file);
  await mkdir(OUT, { recursive: true });
  const path = join(OUT, `match_${match + 1}_${DURATION}s_${BOTS}bots.demo`);
  await writeFile(path, new Uint8Array(buf));
  console.log(`[demorec] wrote ${path}: ${buf.byteLength} bytes ` +
    `(${file.frames.length} local, ${file.remoteFrames.length} remote, ` +
    `${file.projectileEvents.length} proj, ${file.targetEvents.length} tgt, roster ${file.roster.length})`);

  for (const b of bots.splice(0)) { b.bot.stop(); b.nc.close(); }
  if (plantTimer) clearInterval(plantTimer);
  planter?.close();
  obs.close();
  env.server.stop(true);
  env.gs.stop();
}
console.log('[demorec] done');
