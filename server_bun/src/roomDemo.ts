/** roomDemo — the server's half of a unified demo capture. Taps
 *  connections.broadcast (the single point every wire message funnels
 *  through — producers use several aliases above it) and rides the
 *  room's sims registry to sample moveSim shadows into remoteFrames. Emits the same v7 DemoFile
 *  the client recorder produces, so demoAudit and the playback path read
 *  it unchanged.
 *
 *  A server demo IS ground truth — no packet loss, no interp, no
 *  prediction noise. Run a client's capture of the same match through
 *  demoAudit next to it and every delta is a dropped/corrupted wire fact.
 *
 *  `frames` (the first-person lane) stays empty — the server has no local
 *  player; remoteFrames carry every body on the field at tick rate.
 *  Scope: broadcast truth only — per-socket echoes (yourHealth/claimAck)
 *  and binary tick/ball lanes ride other funnels; the demo records what
 *  every observer shares. */
import type { Room } from './Room.ts';
import type { ServerMessage } from '../../shared/protocol.ts';
import type { DemoFile, DemoRosterEntry, RemoteFrame, ProjectileEvent, TargetEvent } from '../../client/src/demo/types.ts';
import {
  DEMO_MAGIC, DEMO_FORMAT_VERSION, RemoteFrameFlags,
  ProjectileEventType, TargetEventType, HIT_TARGET_NONE,
  TARGETTYPE_FLAG, TARGETTYPE_PICKUP_BASE, TARGETTYPE_KILL,
  TARGETTYPE_CREATURE_BASE, TARGETTYPE_DEPLOY_BASE,
  demoSpeciesIndex, creatureDemoId, demoDeployKindIndex, deployDemoId,
  flagDemoId, demoPickupKindIndex, pickupDemoId,
} from '../../client/src/demo/types.ts';

import { serializeDemo } from '../../client/src/demo/demoWriter.ts';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class RoomDemo {
  /** Sim-seconds recorded — the clock the frames stamp. */
  private t = 0;
  private nextFrame = 0;
  private readonly remoteFrames: RemoteFrame[] = [];
  private readonly projectileEvents: ProjectileEvent[] = [];
  private readonly targetEvents: TargetEvent[] = [];
  private readonly roster: DemoRosterEntry[] = [];
  private readonly rosterIdx = new Map<string, number>();
  private readonly projIds = new Map<string, number>();
  private nextProjId = 1;
  /** Last sampled pos per seat — >TELEPORT_M between ticks stamps the
   *  Teleport flag so audits don't call respawns wire corruption. */
  private lastPos = new Map<string, { x: number; y: number; z: number; t: number }>();
  /** Respawn distances are unbounded (cross-map base hops); 10m at 20Hz
   *  is ~200m/s — past every legal flight envelope. */
  private static TELEPORT_M = 10;
  /** Last flag state code per flag id — flagUpdate is a roster frame;
   *  demos want edges. */
  private flagLast = new Map<number, number>();
  /** The gone verbs drop `kind`/`species` on the wire (deployGone,
   *  pickupGone, crawlDie all carry id+pos only) — remember each
   *  namespaced demo id's spawn-lane type or a Destroyed lands on the
   *  default lane and orphans against its own Spawned. */
  private kindTypes = new Map<number, number>();

  constructor(private room: Room) {
    for (const id of room.players.getAllPlayers().keys()) {this.seat(id);}
    room.sims.push({ name: 'demo', tick: (dt): void => this.tick(dt) });
    // Tap the CONNECTIONS funnel, not room.broadcast — producers route
    // through several lambdas (MessageHandler, MessageHandler deps,
    // tickRecords) that call connections.broadcast directly; anything
    // higher misses them (the audit's orphan-Destroyeds caught exactly
    // this). Every wire message passes this one point.
    const orig = room.connections.broadcast.bind(room.connections);
    room.connections.broadcast = (msg, exclude): void => {
      try { this.onBroadcast(msg); } catch { /* recording must never break the wire */ }
      orig(msg, exclude);
    };
  }
  private baselineDone = false;
  /** Baseline spawns — initial-pool deployables/pickups/crawlers live via
   *  worldState (join replay), never emit broadcast edges; without
   *  synthetic Spawned entries every later Destroyed reads as a mid-clip
   *  orphan (the client's leading-edge baseline, same idea). Deferred to
   *  the first tick — the recorder attaches mid-ctor, before the deploy/
   *  pickup sims exist. */
  private baseline(): void {
    this.baselineDone = true;
    for (const d of this.room.deployables.snapshot()) {
      const type = TARGETTYPE_DEPLOY_BASE + demoDeployKindIndex(d.kind);
      this.kindTypes.set(deployDemoId(d.id), type);
      this.targetEvents.push({
        eventType: TargetEventType.Spawned, timestamp: this.now,
        posX: d.pos.x, posY: d.pos.y, posZ: d.pos.z, velX: 0, velY: 0, velZ: 0,
        targetId: deployDemoId(d.id), targetType: type,
        health: 0, hasPeakPosition: false, peakPosX: 0, peakPosY: 0, peakPosZ: 0,
      });
    }
    for (const p of this.room.pickups?.snapshot() ?? []) {
      const type = TARGETTYPE_PICKUP_BASE + demoPickupKindIndex(p.kind);
      this.kindTypes.set(pickupDemoId(p.id), type);
      this.targetEvents.push({
        eventType: TargetEventType.Spawned, timestamp: this.now,
        posX: p.pos.x, posY: p.pos.y, posZ: p.pos.z, velX: 0, velY: 0, velZ: 0,
        targetId: pickupDemoId(p.id), targetType: type,
        health: 0, hasPeakPosition: false, peakPosX: 0, peakPosY: 0, peakPosZ: 0,
      });
    }
    for (const c of this.room.creatureSim.roster()) {
      const pos = (c as { pos?: { x: number; y: number; z: number } }).pos ?? { x: 0, y: 0, z: 0 };
      const type = TARGETTYPE_CREATURE_BASE + demoSpeciesIndex((c as { species?: string }).species ?? 'crawler');
      this.kindTypes.set(creatureDemoId(c.id), type);
      this.targetEvents.push({
        eventType: TargetEventType.Spawned, timestamp: this.now,
        posX: pos.x, posY: pos.y, posZ: pos.z, velX: 0, velY: 0, velZ: 0,
        targetId: creatureDemoId(c.id), targetType: type,
        health: 0, hasPeakPosition: false, peakPosX: 0, peakPosY: 0, peakPosZ: 0,
      });
    }
  }

  /** Wire clock is sim-seconds — deterministic, matches shared/ rules. */
  private get now(): number { return this.t; }

  private seat(pid: string): number {
    let idx = this.rosterIdx.get(pid);
    if (idx === undefined) {
      idx = this.roster.length;
      this.roster.push({ name: pid });
      this.rosterIdx.set(pid, idx);
    }
    return idx;
  }

  private projId(serverId: string): number {
    let id = this.projIds.get(serverId);
    if (id === undefined) { id = this.nextProjId++ & 0xFF_FF; this.projIds.set(serverId, id); }
    return id;
  }

  /** Per-tick player sample — the authoritative shadow states, at the
   *  sim's own cadence. Dead/ski flags mirror what clients render. */
  private tick(dt: number): void {
    this.t += dt;
    if (!this.baselineDone) {this.baseline();}
    if (this.t < this.nextFrame) {return;}
    this.nextFrame = this.t + 0.05; // ~20Hz — the wire cadence, no denser
    // Seat lazily — a joiner whose announce path skipped broadcast (test
    // harnesses addPlayer directly) still lands on the roster here.
    for (const pid of this.room.players.getAllPlayers().keys()) {this.seat(pid);}
    for (const [pid, idx] of this.rosterIdx) {
      const s = this.room.moveSim.simState(pid);
      if (!s) {continue;}
      const dead = this.room.players.getPlayer(pid)?.isDead ?? false;
      const prev = this.lastPos.get(pid);
      const dtp = prev ? this.t - prev.t : 0;
      const jumped = prev !== undefined
        && Math.hypot(s.pos.x - prev.x, s.pos.y - prev.y, s.pos.z - prev.z) > RoomDemo.TELEPORT_M;
      this.lastPos.set(pid, { x: s.pos.x, y: s.pos.y, z: s.pos.z, t: this.t });
      // Recorded vel is REALIZED displacement — what the body did, which
      // is what clients see. The sim's internal vel is intent (a bot
      // pinned on a wall holds 44m/s while moving 2m/s); writing intent
      // would have playback show a parked body skating. Teleport frames
      // keep sim vel — the resync's outgoing state is the truth there.
      const dtv = dtp > 0 && !jumped ? dtp : 0;
      this.remoteFrames.push({
        timestamp: this.t, rosterIdx: idx,
        posX: s.pos.x, posY: s.pos.y, posZ: s.pos.z,
        velX: dtv ? (s.pos.x - prev!.x) / dtv : s.vel.x,
        velY: dtv ? (s.pos.y - prev!.y) / dtv : s.vel.y,
        velZ: dtv ? (s.pos.z - prev!.z) / dtv : s.vel.z,
        yaw: s.yaw, pitch: 0,
        flags: (dead ? RemoteFrameFlags.Dead : RemoteFrameFlags.None)
          | (jumped ? RemoteFrameFlags.Teleport : 0),
      });
    }
  }

  /** One line in Room.broadcast — this sees every wire event verbatim. */
  onBroadcast(msg: ServerMessage): void {
    const m = msg as Record<string, unknown>;
    const v = (p: unknown): { x: number; y: number; z: number } =>
      (p ?? { x: 0, y: 0, z: 0 }) as { x: number; y: number; z: number };
    switch (msg.type) {
      case 'playerJoined': { this.seat(m.playerId as string); break; }
      case 'projectileCreated': {
        const pos = v(m.position); const vel = v(m.velocity);
        this.projectileEvents.push({
          eventType: ProjectileEventType.Fired, timestamp: this.now,
          posX: pos.x, posY: pos.y, posZ: pos.z,
          velX: vel.x, velY: vel.y, velZ: vel.z,
          projectileId: this.projId(m.projectileId as string),
          weaponType: (m.weaponType as number) ?? 0,
          surfaceNormalX: 0, surfaceNormalY: 0, surfaceNormalZ: 0,
          targetId: 0, targetType: HIT_TARGET_NONE,
          hasPeakPosition: false, peakPosX: 0, peakPosY: 0, peakPosZ: 0,
        });
        break;
      }
      case 'projectileDestroyed': {
        const pos = v(m.position);
        this.projectileEvents.push({
          eventType: ProjectileEventType.Destroyed, timestamp: this.now,
          posX: pos.x, posY: pos.y, posZ: pos.z,
          velX: 0, velY: 0, velZ: 0,
          projectileId: this.projId(m.projectileId as string),
          weaponType: 0, surfaceNormalX: 0, surfaceNormalY: 0, surfaceNormalZ: 0,
          targetId: 0, targetType: HIT_TARGET_NONE,
          hasPeakPosition: false, peakPosX: 0, peakPosY: 0, peakPosZ: 0,
        });
        break;
      }
      case 'playerKill': {
        const victimIdx = this.seat(m.targetId as string);
        const shooterIdx = m.shooterId ? this.seat(m.shooterId as string) : -1;
        const s = this.room.moveSim.simState(m.targetId as string);
        const pos = s?.pos ?? { x: 0, y: 0, z: 0 };
        this.targetEvents.push({
          eventType: TargetEventType.Destroyed, timestamp: this.now,
          posX: pos.x, posY: pos.y, posZ: pos.z,
          velX: 0, velY: 0, velZ: 0,
          targetId: victimIdx, targetType: TARGETTYPE_KILL,
          health: (m.weapon as number) ?? 0,
          hasPeakPosition: true, peakPosX: shooterIdx + 1, peakPosY: 0, peakPosZ: 0,
        });
        break;
      }
      case 'flagUpdate': {
        for (const f of msg.flags) {
          const id = flagDemoId(f.team === 'alpha' ? 0 : 1);
          const code = f.state === 'home' ? 0 : f.state === 'carried' ? 1 : 2;
          if (this.flagLast.get(id) === code) {continue;}
          this.flagLast.set(id, code);
          this.targetEvents.push({
            eventType: TargetEventType.StateChanged, timestamp: this.now,
            posX: f.pos.x, posY: f.pos.y, posZ: f.pos.z,
            velX: 0, velY: 0, velZ: 0,
            targetId: id, targetType: TARGETTYPE_FLAG, health: code,
            hasPeakPosition: true,
            peakPosX: f.carrier ? this.seat(f.carrier) + 1 : 0, peakPosY: 0, peakPosZ: 0,
          });
        }
        break;
      }
      case 'ballSpawn': case 'ballDie': {
        const pos = v(m.position); const vel = v(m.velocity);
        // ballDie's 'gone' decl carries id+pos+by — no variant. Remember
        // it at spawn or every death orphans against its own Spawned
        // (same lane-drift class as deployGone/pickupGone).
        const spawned = msg.type === 'ballSpawn';
        const id = m.id as number;
        const type = spawned ? ((m.variant as number) ?? 0) : (this.kindTypes.get(id) ?? 0);
        if (spawned) {this.kindTypes.set(id, type);}
        this.targetEvents.push({
          eventType: spawned ? TargetEventType.Spawned : TargetEventType.Destroyed,
          timestamp: this.now, posX: pos.x, posY: pos.y, posZ: pos.z,
          velX: vel.x, velY: vel.y, velZ: vel.z,
          targetId: id, targetType: type,
          health: 0, hasPeakPosition: false, peakPosX: 0, peakPosY: 0, peakPosZ: 0,
        });
        break;
      }
      case 'crawlSpawn': case 'crawlDie': {
        const pos = v(m.position);
        const id = creatureDemoId(m.id as number);
        const spawned = msg.type === 'crawlSpawn';
        const type = spawned
          ? TARGETTYPE_CREATURE_BASE + demoSpeciesIndex((m.species as string) ?? 'crawler')
          : this.kindTypes.get(id) ?? TARGETTYPE_CREATURE_BASE;
        if (spawned) {this.kindTypes.set(id, type);}
        this.targetEvents.push({
          eventType: spawned ? TargetEventType.Spawned : TargetEventType.Destroyed,
          timestamp: this.now, posX: pos.x, posY: pos.y, posZ: pos.z,
          velX: 0, velY: 0, velZ: 0,
          targetId: id, targetType: type,
          health: 0, hasPeakPosition: false, peakPosX: 0, peakPosY: 0, peakPosZ: 0,
        });
        break;
      }
      case 'deploySpawn': case 'deployGone': {
        const pos = v(m.pos);
        const id = deployDemoId(m.id as number);
        const spawned = msg.type === 'deploySpawn';
        const type = spawned
          ? TARGETTYPE_DEPLOY_BASE + demoDeployKindIndex((m.kind as string) ?? 'turret')
          : this.kindTypes.get(id) ?? TARGETTYPE_DEPLOY_BASE;
        if (spawned) {this.kindTypes.set(id, type);}
        this.targetEvents.push({
          eventType: spawned ? TargetEventType.Spawned : TargetEventType.Destroyed,
          timestamp: this.now, posX: pos.x, posY: pos.y, posZ: pos.z,
          velX: 0, velY: 0, velZ: 0,
          targetId: id, targetType: type,
          health: 0, hasPeakPosition: false, peakPosX: 0, peakPosY: 0, peakPosZ: 0,
        });
        break;
      }
      case 'pickupSpawn': case 'pickupGone': {
        const pos = v(m.pos);
        const id = pickupDemoId(m.id as number);
        const spawned = msg.type === 'pickupSpawn';
        const type = spawned
          ? TARGETTYPE_PICKUP_BASE + demoPickupKindIndex((m.kind as string) ?? 'gem')
          : this.kindTypes.get(id) ?? TARGETTYPE_PICKUP_BASE;
        if (spawned) {this.kindTypes.set(id, type);}
        this.targetEvents.push({
          eventType: spawned ? TargetEventType.Spawned : TargetEventType.Destroyed,
          timestamp: this.now, posX: pos.x, posY: pos.y, posZ: pos.z,
          velX: 0, velY: 0, velZ: 0,
          targetId: id, targetType: type,
          health: 0, hasPeakPosition: false, peakPosX: 0, peakPosY: 0, peakPosZ: 0,
        });
        break;
      }
    }
  }

  /** Serialize the current capture to `dir` without tearing the room
   *  down — the live-match flush (admin/demodump, periodic forensic
   *  snapshots). Returns the written path. */
  flush(dir: string, tag = ''): string {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${this.room.name.replace(/[^A-Za-z0-9_-]/g, '_')}${tag}-${Date.now()}.demo`);
    writeFileSync(file, Buffer.from(serializeDemo(this.buildFile(`server capture room=${this.room.name}`))));
    return file;
  }

  /** Assemble the DemoFile — same shape the client buildDemoFile emits. */
  buildFile(description = ''): DemoFile {
    const first = this.remoteFrames[0];
    return {
      header: {
        magic: DEMO_MAGIC, formatVersion: DEMO_FORMAT_VERSION,
        gameVersion: '1.0.0', timestamp: Date.now(),
        duration: this.t, totalFrames: 0,
        projectileEventCount: this.projectileEvents.length,
        targetEventCount: this.targetEvents.length,
        checksum: 0, description,
        startPosX: first?.posX ?? 0, startPosY: first?.posY ?? 0, startPosZ: first?.posZ ?? 0,
        startYaw: first?.yaw ?? 0, startPitch: 0,
        startVelX: first?.velX ?? 0, startVelY: first?.velY ?? 0, startVelZ: first?.velZ ?? 0,
        projectileLifetime: 0,
        room: this.room.name, mode: this.room.mode, playerName: 'server',
        tableHash: 0, runSeed: this.room.rngSeed ?? 0,
      },
      frames: [], // no first-person lane on the authority side
      projectileEvents: [...this.projectileEvents],
      targetEvents: [...this.targetEvents],
      roster: this.roster.map((e): DemoRosterEntry => ({ name: e.name })),
      remoteFrames: [...this.remoteFrames],
    };
  }
}
