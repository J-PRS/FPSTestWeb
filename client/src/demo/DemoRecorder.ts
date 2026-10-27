// Demo recording engine - captures frames and events into circular buffers.
// Zero overhead when disabled: all public methods early-out on `!recording`.

import { CircularBuffer } from './CircularBuffer.js';
import {
  type DemoFrame, type ProjectileEvent, ProjectileEventType, type TargetEvent, type RemoteFrame, type DemoHeightmap,RemoteFrameFlags,
  createFrame,
  TEAM_CODE, CLS_CODE,
  type DemoFile,type DemoRosterEntry} from './types.js';

import type { IPlayerDataProvider, IInputProvider, Vec3 } from './interfaces.js';
import * as ev from './demoEvents.js';
import { buildDemoFile, extractClip } from './demoExtract.js';
import { hmapDownsample, hmapCorrections } from './demoHmap.js';
import type { Heightfield } from '../../../shared/heightfield.js';
import type { ResultToken } from '../../../shared/resultToken.ts';

const DEFAULT_BUFFER_SECONDS = 30;
const DEFAULT_TICK_RATE = 60; // frames per second
// Remote players don't need the local tick rate — the wire itself only
// carries ~20Hz, so sampling faster just stores duplicates.
const REMOTE_SAMPLE_HZ = 20;
// World-state sweep cadence — tight enough that a clip's baseline spawn
// is ≤2s stale, sparse enough to stay noise next to real edge events.
// Walkers drift several metres between keyframes and the playback lane only
// knows ballistic drift — 1s keeps parked-proxy error under a body length.
const TARGET_SNAPSHOT_INTERVAL = 1;
// Seek-checkpoint cadence — tail replay after a seek is bounded by one
// interval (see _docs/2026-10-14_DEMO_SEEK_CHECKPOINTS.md). 4 bytes per
// mark; matches the rolling ring's order so marks stay inside the window.
const SEEK_SNAPSHOT_INTERVAL = 30;

// Splice out all events with timestamp < cutoff in one batch (list is
// append-ordered, so binary search finds the first keeper index).
function pruneEventsBefore<T extends { timestamp: number }>(events: T[], cutoff: number, pool: T[]): void {
  if (events.length === 0 || events[0].timestamp >= cutoff) {return;}
  let lo = 0, hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].timestamp < cutoff) {lo = mid + 1;}
    else {hi = mid;}
  }
  // Retired events go back on the freelist — recording is always-on now,
  // so a churn-free spool keeps GC out of the steady frame.
  for (const e of events.splice(0, lo)) {pool.push(e);}
}

/** Projectile prune — same rolling-window drop EXCEPT a Fired whose shell
 *  is still live survives: a mortar/bolt can outfly the buffer window, and
 *  its terminal edge (Hit/Destroyed) then audits as a phantom blast. */
function pruneProjEvents(events: ProjectileEvent[], cutoff: number, pool: ProjectileEvent[], live: Set<number>): void {
  if (events.length === 0 || events[0]!.timestamp >= cutoff) {return;}
  let lo = 0, hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid]!.timestamp < cutoff) {lo = mid + 1;}
    else {hi = mid;}
  }
  let keep = 0;
  for (let i = 0; i < lo; i += 1) {
    const e = events[i]!;
    if (e.eventType === ProjectileEventType.Fired && live.has(e.projectileId)) {events[keep] = e; keep += 1;}
    else {pool.push(e);}
  }
  // Survivors compacted to [0, keep); slide the post-cutoff tail left.
  events.copyWithin(keep, lo);
  events.length -= lo - keep;
}

// Minimal shape the recorder needs from a live remote player —
// RemotePlayer and the bots' entries both satisfy it.
export interface RemoteSample {
  id: string;
  posX: number; posY: number; posZ: number;
  velX: number; velY: number; velZ: number;
  yaw: number; pitch: number;
  dead: boolean; ski: boolean;
  // v8 meta — optional so old sources (bot entries without wire state)
  // still satisfy the shape; absent lanes encode 0.
  team?: string; health?: number; held?: number; sheep?: number;
  armorClass?: string; status?: number; weapon?: number;
}

export interface DemoContext {
  room: string; mode: string; playerName: string;
}

// One live entity for the world-state sweep — ids/targetType are already
// in DEMO space (caller does creatureDemoId/deployDemoId etc).
export interface TargetSnapshot {
  targetId: number; targetType: number;
  pos: { x: number; y: number; z: number };
  vel: { x: number; y: number; z: number };
  health: number;
}

export class DemoRecorder implements IProjectileEventRecorder, ITargetEventRecorder {
  frameBuffer: CircularBuffer<DemoFrame>;
  projectileEvents: ProjectileEvent[] = [];
  targetEvents: TargetEvent[] = [];
  remoteFrames: RemoteFrame[] = [];
  /** Freed objects from the prune window — reused by the next push so the
   *  rolling window stops churning fresh literals every tick. */
  projectileEventPool: ProjectileEvent[] = [];
  targetEventPool: TargetEvent[] = [];
  remoteFramePool: RemoteFrame[] = [];
  rosterIdxById = new Map<string, number>();
  roster: DemoRosterEntry[] = [];
  /** Server projectile id -> minted u16 demo id, for remote-owned shells.
   *  Local shots mint at fire time via recordFired; remote shots arrive
   *  as string ids over the wire and need the same dedupe table so their
   *  Destroyed edge finds the Fired record. */
  remoteProjIdByServerId = new Map<string, number>();
  /** Minted demo ids of shells still in flight — the rolling event prune
   *  keeps their Fired edge so a long-lived shell's terminal edge never
   *  audits as an orphan (live capture showed ~12 phantom Destroyeds). */
  liveProjIds = new Set<number>();
  /** Server creature netId -> recorded targetType (64 + species idx).
   *  Die/evt edges arrive without a species name, so spawn/roster rows
   *  seed the table and it dies with the creature. */
  creatureTtByNetId = new Map<number, number>();
  /** Server deployable netId -> recorded targetType + last known pos —
   *  gone/down/up/hp edges arrive without a position, so the spawn and
   *  hp edges keep this table warm until the deployable dies. */
  deployInfoByNetId = new Map<number, { tt: number; x: number; y: number; z: number }>();
  /** Server pickup netId -> targetType + rest pos — pickupGone carries
   *  no position, so spawn seeds the table. */
  pickupInfoByNetId = new Map<number, { tt: number; x: number; y: number; z: number }>();
  /** Conquest node dedupe — last written sig per node id (see
   *  ev.recordNodeUpdate) plus the Spawned-once set. */
  nodeSeen = new Set<number>();
  nodeLast = new Map<number, number>();
  /** Flag demo ids already Spawned this window — flags live forever, so
   *  the lane emits one Spawned then only StateChanged keyframes. */
  flagSeen = new Set<number>();
  remoteSource: (() => Iterable<RemoteSample>) | null = null;
  lastRemoteSampleT = 0;
  /** Live world-state enumerator — polled every TARGET_SNAPSHOT_INTERVAL
   *  so clip baselines see entities whose lifecycle edges aged out. */
  targetSnapshotSource: (() => Iterable<TargetSnapshot>) | null = null;
  lastTargetSnapT = 0;
  /** Last stored sample per roster idx — the dead-reckon comparator.
   *  Lives outside remoteFrames so pooled/pruned frames don't alias it. */
  private lastRemoteByIdx = new Map<number, { posX: number; posY: number; posZ: number; velX: number; velY: number; velZ: number; yaw: number; pitch: number; flags: number }>();
  context: DemoContext = { room: '', mode: '', playerName: '' };
  /** Map look spec — captured at map-apply time so the clip replays the
   *  recorded haze/sky, not whatever map is live at playback. */
  atmo?: { fog?: unknown; weather?: unknown; atmosphere?: unknown; terrain?: unknown; terrainTex?: unknown; terrainPreset?: unknown; heightScale?: unknown; tileSize?: unknown; sky?: unknown };
  /** Seek-checkpoint marks (elapsed seconds, ascending) — emitted every
   *  SEEK_SNAPSHOT_INTERVAL while recording; serialized as SECTION_SNAP. */
  snapshots: number[] = [];
  private lastSnapshotT = -SEEK_SNAPSHOT_INTERVAL;
  /** v5 trailer: coarse u8 downsample of the match terrain — captured
   *  once at start so the file self-describes its battlefield even if
   *  the map file vanishes later. */
  heightmap: DemoHeightmap | null = null;

  /** Call once the room's field has loaded — snapshots a ~9KB coarse
   *  grid + a fingerprint of the full-res source for the match check. */
  setHeightmap(field: Heightfield | null): void {
    this.heightmap = field ? hmapDownsample(field) : null;
    if (field && this.heightmap) {this.heightmap.corr = hmapCorrections(field, this.heightmap);}
  }

  recording = false;
  /** Dedupe bit-identical frames (local + remote). Off = verbatim every
   *  tick, for analysis tooling that wants an unbroken sample stream. */
  deadReckon = true;
  frameNumber = 0;
  startTime = 0;
  elapsedTime = 0;
  lastTickTime = 0;
  /** (elapsed sec, wall ms) anchors — elapsedTime drifts from real time
   *  under throttle, so video-clip windows map through these marks. */
  wallMarks: { wall: number; t: number }[] = [];
  private lastWallMarkT = -1;
  tickInterval: number;
  bufferSeconds: number;
  nextProjectileId = 1;

  /** Server-signed result receipt — embedded into the demo on save. */
  public matchToken: ResultToken | null = null;
  private playerData: IPlayerDataProvider | null = null;
  private inputData: IInputProvider | null = null;

  // Event rate limiting
  eventCountThisSecond = 0;
  lastEventResetTime = 0;

  constructor(bufferSeconds: number = DEFAULT_BUFFER_SECONDS, tickRate: number = DEFAULT_TICK_RATE) {
    this.bufferSeconds = bufferSeconds;
    const capacity = Math.ceil(bufferSeconds * tickRate);
    this.frameBuffer = new CircularBuffer<DemoFrame>(capacity);
    this.tickInterval = 1 / tickRate;
  }

  get isRecording(): boolean { return this.recording; }
  get frameCount(): number { return this.frameBuffer.Count; }
  get duration(): number { return this.elapsedTime; }

  /** Map a recorder-time stamp to wall ms by lerping the anchor marks —
   *  exact regardless of throttle drift. Extrapolates flatly past the
   *  mark ends; null only before any mark exists. */
  wallForElapsed(t: number): number | null {
    const m = this.wallMarks;
    if (m.length === 0) {return null;}
    if (t <= m[0].t) {return m[0].wall - (m[0].t - t) * 1000;}
    for (let i = 1; i < m.length; i += 1) {
      if (t <= m[i].t) {
        const a = m[i - 1], b = m[i];
        return a.wall + ((t - a.t) / (b.t - a.t)) * (b.wall - a.wall);
      }
    }
    const last = m[m.length - 1];
    return last.wall + (t - last.t) * 1000;
  }

  start(playerData: IPlayerDataProvider, inputData: IInputProvider): void {
    if (this.recording) {return;}
    this.recording = true;
    this.frameNumber = 0;
    this.nextProjectileId = 1;
    this.startTime = performance.now() / 1000;
    this.elapsedTime = 0;
    this.lastTickTime = 0;
    this.wallMarks = [];
    this.lastWallMarkT = -1;
    this.lastEventResetTime = 0;
    this.eventCountThisSecond = 0;
    this.projectileEvents = [];
    this.targetEvents = [];
    this.remoteFrames = [];
    this.rosterIdxById.clear();
    this.roster = [];
    this.remoteProjIdByServerId.clear();
    this.liveProjIds.clear();
    this.creatureTtByNetId.clear();
    this.deployInfoByNetId.clear();
    this.pickupInfoByNetId.clear();
    this.flagSeen.clear();
    this.lastRemoteSampleT = 0;
    this.lastTargetSnapT = 0;
    this.snapshots = [];
    this.lastSnapshotT = -SEEK_SNAPSHOT_INTERVAL;
    this.lastRemoteByIdx.clear();
    this.frameBuffer.clear();
    this.playerData = playerData;
    this.inputData = inputData;
  }

  stop(): void {
    this.recording = false;
  }

  // Who/where the clip happened — stamped into every file written from now on
  setContext(ctx: Partial<DemoContext>): void {
    Object.assign(this.context, ctx);
  }

  // Live remote-player source; polled at REMOTE_SAMPLE_HZ while recording
  setRemoteSource(source: (() => Iterable<RemoteSample>) | null): void {
    this.remoteSource = source;
  }

  // Live target-entity source; polled every TARGET_SNAPSHOT_INTERVAL
  setTargetSnapshotSource(source: (() => Iterable<TargetSnapshot>) | null): void {
    this.targetSnapshotSource = source;
  }

  private sampleRemotes(now: number): void {
    if (!this.remoteSource) {return;}
    if (now - this.lastRemoteSampleT < 1 / REMOTE_SAMPLE_HZ) {return;}
    this.lastRemoteSampleT = now;
    for (const s of this.remoteSource()) {
      let idx = this.rosterIdxById.get(s.id);
      if (idx === undefined) {
        idx = this.roster.length;
        this.rosterIdxById.set(s.id, idx);
        this.roster.push({ name: s.id });
      }
      let flags = (s.dead ? RemoteFrameFlags.Dead : 0) | (s.ski ? RemoteFrameFlags.Ski : 0);
      // Respawn/reclaim jumps read as impossible speed in audit — mark
      // them like the server recorder does (>8m between samples = a
      // seat re-root, not motion; 160m/s is the audit flight envelope).
      const prev = this.lastRemoteByIdx.get(idx);
      if (prev && Math.hypot(s.posX - prev.posX, s.posY - prev.posY, s.posZ - prev.posZ) > 8) {
        flags |= RemoteFrameFlags.Teleport;
      }
      // Same dead-reckon skip as the local frame: an identical sample
      // reproduces exactly under playback's timestamp lerp.
      if (this.deadReckon && this.remoteUnchanged(idx, s, flags)) {continue;}
      const f = this.remoteFramePool.pop() ?? ({ timestamp: 0, rosterIdx: 0, posX: 0, posY: 0, posZ: 0, velX: 0, velY: 0, velZ: 0, yaw: 0, pitch: 0, flags: 0 } as RemoteFrame);
      f.timestamp = now;
      f.rosterIdx = idx;
      f.posX = s.posX; f.posY = s.posY; f.posZ = s.posZ;
      f.velX = s.velX; f.velY = s.velY; f.velZ = s.velZ;
      f.yaw = s.yaw; f.pitch = s.pitch;
      f.flags = flags;
      // v8 meta — encode wire strings to the u8 lanes; absent stays 0.
      f.team = s.team ? (TEAM_CODE[s.team] ?? 0) : 0;
      f.hp = Math.max(0, Math.min(255, Math.round(s.health ?? 0)));
      f.held = Math.max(0, Math.min(255, s.held ?? 0));
      f.sheep = Math.max(0, Math.min(255, s.sheep ?? 0));
      f.cls = s.armorClass ? (CLS_CODE[s.armorClass] ?? 0) : 0;
      f.status = (s.status ?? 0) & 0xFF;
      f.wid = (s.weapon ?? 0) & 0xFF;
      this.remoteFrames.push(f);
    }
  }

  private sampleTargets(now: number): void {
    if (!this.targetSnapshotSource) {return;}
    if (now - this.lastTargetSnapT < TARGET_SNAPSHOT_INTERVAL) {return;}
    this.lastTargetSnapT = now;
    ev.recordTargetSnapshots(this, this.targetSnapshotSource());
  }

  /** Bit-exact change test for the remote dead-reckon skip; also updates
   *  the stored sample when it differs. */
  private remoteUnchanged(idx: number, s: RemoteSample, flags: number): boolean {
    let prev = this.lastRemoteByIdx.get(idx);
    if (!prev) {
      prev = { posX: 0, posY: 0, posZ: 0, velX: 0, velY: 0, velZ: 0, yaw: 0, pitch: 0, flags: -1 };
      this.lastRemoteByIdx.set(idx, prev);
    }
    const same = prev.posX === s.posX && prev.posY === s.posY && prev.posZ === s.posZ &&
      prev.velX === s.velX && prev.velY === s.velY && prev.velZ === s.velZ &&
      prev.yaw === s.yaw && prev.pitch === s.pitch && prev.flags === flags;
    if (same) {return true;}
    prev.posX = s.posX; prev.posY = s.posY; prev.posZ = s.posZ;
    prev.velX = s.velX; prev.velY = s.velY; prev.velZ = s.velZ;
    prev.yaw = s.yaw; prev.pitch = s.pitch; prev.flags = flags;
    return false;
  }

  /** Bit-exact change test for the local dead-reckon skip — any field
   *  that differs (including under future physics like drag) forces a write. */
  private frameIdentical(last: DemoFrame, p: IPlayerDataProvider, i: IInputProvider): boolean {
    return last.posX === p.posX && last.posY === p.posY && last.posZ === p.posZ &&
      last.velX === p.velX && last.velY === p.velY && last.velZ === p.velZ &&
      last.yaw === p.yaw && last.pitch === p.pitch &&
      last.inputFlags === i.inputFlags &&
      last.mouseDeltaX === i.mouseDeltaX && last.mouseDeltaY === i.mouseDeltaY &&
      last.jetpackFlags === i.jetpackFlags && last.jetpackFuel === i.jetpackFuel &&
      last.weaponType === p.weaponType &&
      last.health === p.health && last.armor === p.armor;
  }

  private markWall(now: number): void {
    this.lastWallMarkT = now;
    this.wallMarks.push({ wall: performance.now(), t: now });
    const cutoff = now - this.bufferSeconds;
    while (this.wallMarks.length > 0 && this.wallMarks[0].t < cutoff) {this.wallMarks.shift();}
  }

  // Called every game frame. Only records at tick interval.
  // dt is seconds since last game frame.
  update(dt: number): void {
    if (!this.recording || !this.playerData || !this.inputData) {return;}

    this.elapsedTime += dt;
    const now = this.elapsedTime;

    // Wall-clock anchor pair — elapsedTime accumulates CLAMPED dt, so it
    // drifts from real time under throttling. A raw (wall, elapsed) mark
    // per tick lets clip windows map to the video ring's wall stamps
    // exactly instead of guessing from `now - duration`.
    if (now - this.lastWallMarkT >= 0.2) {this.markWall(now);}

    // Only record at tick rate
    if (now - this.lastTickTime < this.tickInterval) {return;}
    this.lastTickTime = now;

    const p = this.playerData;
    const i = this.inputData;

    // Dead-reckoned skip: a frame identical to the last stored one
    // carries zero information — playback lerps between timestamps and
    // would reproduce the same constants anyway. Idle stretches cost
    // ~12 compares instead of a 49B write each.
    const last = this.deadReckon && this.frameBuffer.Count > 0 ? this.frameBuffer.peekNewest() : undefined;
    if (last && this.frameIdentical(last, p, i)) {
      this.housekeep(now);
      return;
    }

    // Reuse the slot's existing frame object — the ring overwrites it
    // anyway, so allocating per tick is pure churn.
    const slot = this.frameBuffer.slotForNext();
    const frame = this.frameBuffer.rawAt(slot) ?? createFrame(this.frameNumber, now);
    frame.frameNumber = this.frameNumber; frame.timestamp = now;
    frame.posX = p.posX; frame.posY = p.posY; frame.posZ = p.posZ;
    frame.velX = p.velX; frame.velY = p.velY; frame.velZ = p.velZ;
    frame.yaw = p.yaw; frame.pitch = p.pitch;
    frame.inputFlags = i.inputFlags;
    frame.mouseDeltaX = i.mouseDeltaX;
    frame.mouseDeltaY = i.mouseDeltaY;
    frame.jetpackFlags = i.jetpackFlags;
    frame.jetpackFuel = i.jetpackFuel;
    frame.weaponType = p.weaponType;
    frame.health = p.health; frame.armor = p.armor;

    this.frameBuffer.add(frame);
    // Ring-write invariant: the frame we just stored must be the newest
    // AND adjacent to the prior write. A splice here means slotForNext
    // returned a live slot — the exact corruption the audit caught in
    // live_botfight.demo (f#3969 sitting mid-sequence). Names the fault
    // at write time instead of leaving it for post-hoc file analysis.
    const newest = this.frameBuffer.peekNewest();
    if (newest !== frame || (this.frameBuffer.Count > 1 && newest.timestamp < this.frameBuffer.getUnsafe(this.frameBuffer.Count - 2).timestamp)) {
      console.warn(`[demo] frame ring splice: wrote f#${  frame.frameNumber  } t=${  frame.timestamp.toFixed(3)
         } newest=${  newest === frame  } count=${  this.frameBuffer.Count}`);
    }
    this.frameNumber = (this.frameNumber + 1) % 65_536;

    this.housekeep(now);
  }

  /** Remote sampling + rolling-window prune — runs on every tick whether
   *  the local frame was written or dead-reckon skipped. */
  private housekeep(now: number): void {
    this.sampleRemotes(now);
    this.sampleTargets(now);
    // Checkpoint mark — a seek landing past here replays at most one
    // interval of tail instead of the whole file (see demoPlayback).
    if (now - this.lastSnapshotT >= SEEK_SNAPSHOT_INTERVAL) {
      this.lastSnapshotT = now;
      this.snapshots.push(now);
    }
    const cutoff = this.elapsedTime - this.bufferSeconds;
    pruneProjEvents(this.projectileEvents, cutoff, this.projectileEventPool, this.liveProjIds);
    pruneEventsBefore(this.targetEvents, cutoff, this.targetEventPool);
    pruneEventsBefore(this.remoteFrames, cutoff, this.remoteFramePool);
    // Marks older than the ring are unseekable — the tail they anchor is gone.
    while (this.snapshots.length > 0 && this.snapshots[0]! < cutoff) {this.snapshots.shift();}
  }

  // Event recorders — the rate-limited projectile/target event spool
  // lives in demoEvents.ts; these keep the interface shape.
  recordFired(position: Vec3, velocity: Vec3, weaponType: number, shooterId?: string): number {
    return ev.recordFired(this, position, velocity, weaponType, shooterId);
  }
  recordBounce(projectileId: number, position: Vec3, velocity: Vec3, surfaceNormal: Vec3): void {
    ev.recordBounce(this, projectileId, position, velocity, surfaceNormal);
  }
  recordHit(projectileId: number, position: Vec3, targetId: number, weaponType: number, targetType: number): void {
    ev.recordHit(this, projectileId, position, targetId, weaponType, targetType);
  }
  recordDestroyed(projectileId: number, position: Vec3): void {
    ev.recordDestroyed(this, projectileId, position);
  }
  recordTargetSpawned(targetId: number, position: Vec3, velocity: Vec3, targetType: number): void {
    ev.recordTargetSpawned(this, targetId, position, velocity, targetType);
  }
  recordTargetBounce(targetId: number, position: Vec3, velocity: Vec3, targetType: number): void {
    ev.recordTargetBounce(this, targetId, position, velocity, targetType);
  }
  recordTargetPeak(targetId: number, position: Vec3, velocity: Vec3, targetType: number): void {
    ev.recordTargetPeak(this, targetId, position, velocity, targetType);
  }
  recordTargetHit(targetId: number, position: Vec3, velocity: Vec3, targetType: number, health: number): void {
    ev.recordTargetHit(this, targetId, position, velocity, targetType, health);
  }
  recordTargetDestroyed(targetId: number, position: Vec3, targetType: number, health = 0): void {
    ev.recordTargetDestroyed(this, targetId, position, targetType, health);
  }

  /** Remote-owned shell spawned on the wire — mints and remembers the
   *  demo id so its Destroyed edge pairs with this Fired record. */
  recordRemoteFired(serverId: string, position: Vec3, velocity: Vec3, weaponType: number, ownerId?: string): void {
    ev.recordRemoteFired(this, serverId, position, velocity, weaponType, ownerId);
  }
  recordRemoteDestroyed(serverId: string, position: Vec3): void {
    ev.recordRemoteDestroyed(this, serverId, position);
  }

  /** Creature lifecycle — netId is the server creature id; the demo
   *  targetId is namespaced (top bit) so it can't alias a ball's id. */
  recordCreatureSpawned(netId: number, species: string, position: Vec3): void {
    ev.recordCreatureSpawned(this, netId, species, position);
  }
  recordCreatureEdge(netId: number, position: Vec3, velocity: Vec3): void {
    ev.recordCreatureEdge(this, netId, position, velocity);
  }
  recordCreatureRoster(netId: number, species: string, position: Vec3, velocity: Vec3): void {
    ev.recordCreatureRoster(this, netId, species, position, velocity);
  }
  recordCreatureDie(netId: number, position: Vec3): void {
    ev.recordCreatureDie(this, netId, position);
  }

  /** Deployable lifecycle — netId is the server deploy id; the demo
   *  target space namespaces it (0x4000 bit) away from balls/creatures. */
  recordDeploySpawned(netId: number, kind: string, position: Vec3): void {
    ev.recordDeploySpawned(this, netId, kind, position);
  }
  recordDeployGone(netId: number): void {
    ev.recordDeployGone(this, netId);
  }
  recordDeployHp(netId: number, hp: number): void {
    ev.recordDeployHp(this, netId, hp);
  }
  recordDeployShot(netId: number, target: Vec3): void {
    ev.recordDeployShot(this, netId, target);
  }
  recordDeployBoom(netId: number, position: Vec3): void {
    ev.recordDeployBoom(this, netId, position);
  }

  /** Game-state edges — kill markers, flag state, pickup lifecycle. */
  recordKill(shooterId: string | null, targetId: string, weapon: number, position: Vec3): void {
    ev.recordKill(this, shooterId, targetId, weapon, position);
  }
  recordFlagUpdate(team: string, state: string, position: Vec3, carrier: string | null): void {
    ev.recordFlagUpdate(this, team, state, position, carrier);
  }
  recordNodeUpdate(r: { id: number; pos: Vec3; owner: string; core: boolean; hp: number; buildBy: string | null; show: boolean; hot: boolean; gx: number; gz: number }): void {
    ev.recordNodeUpdate(this, r);
  }
  recordPickupSpawned(netId: number, kind: string, position: Vec3): void {
    ev.recordPickupSpawned(this, netId, kind, position);
  }
  recordPickupGone(netId: number): void {
    ev.recordPickupGone(this, netId);
  }

  // Extract all recorded data into a DemoFile
  buildDemoFile(description = ''): DemoFile { return buildDemoFile(this, description); }

  // Extract a clip: frames and events within [startTime, endTime].
  // Times are relative to recording start (elapsedTime).
  extractClip(startTime: number, endTime: number, description: string, projectileLifetime = 0): DemoFile | null {
    return extractClip(this, startTime, endTime, description, projectileLifetime);
  }

}

export interface IProjectileEventRecorder {
  recordFired(position: Vec3, velocity: Vec3, weaponType: number, shooterId?: string): number;
  recordBounce(projectileId: number, position: Vec3, velocity: Vec3, surfaceNormal: Vec3): void;
  recordHit(projectileId: number, position: Vec3, targetId: number, weaponType: number, targetType: number): void;
  recordDestroyed(projectileId: number, position: Vec3): void;
}

export interface ITargetEventRecorder {
  recordTargetSpawned(targetId: number, position: Vec3, velocity: Vec3, targetType: number): void;
  recordTargetBounce(targetId: number, position: Vec3, velocity: Vec3, targetType: number): void;
  recordTargetPeak(targetId: number, position: Vec3, velocity: Vec3, targetType: number): void;
  recordTargetHit(targetId: number, position: Vec3, velocity: Vec3, targetType: number, health: number): void;
  recordTargetDestroyed(targetId: number, position: Vec3, targetType: number, health?: number): void;
}

