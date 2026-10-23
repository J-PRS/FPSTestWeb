/**
 * netBot — wire-level client bots for networking stress tests.
 *
 * Each bot opens a REAL WebSocket to the server and plays a legal
 * client: join → binary position stream + inputMove journal + fire
 * claims through the normal protocol. Movement runs the shared MoveSim
 * over the server's own heightmap so positions reconcile against the
 * shadow instead of reading as cheats. Corrections are honored like a
 * real client would.
 *
 *   bun tools/netBot.ts                       # 8 bots, ws://localhost:8000, room 'default'
 *   bun tools/netBot.ts --bots 32 --room stress --mode dm --posHz 30
 *   bun tools/netBot.ts --bots 4 --fire 0     # position/input only, no claims
 *
 * Args: --url ws://host:port  --bots N  --room name  --mode id
 *       --posHz N  --fire 0|1  --map path-to-heightmap.bin
 *       --net best|rtc|ws — best probes /rtcs (WebRTC datachannel via
 *         node-datachannel) then falls back to /ws like a real client.
 */
import { MoveSim, ENERGY } from '../../shared/movement.ts';
import { hmHeight, type Heightfield } from '../../shared/heightfield.ts';
import { encodePosition, encodeInputMove, decodeTickFrame, decodeBallSegment, decodeWireJson, iterBatch, encodePosClaim, encodeShot, decodeHit, decodeWidPos, decodeShotEv, decodeKnock, decodeKill } from '../../shared/wire.ts';
import { PERK_ORDER } from '../../shared/perks.ts';
import { CLASS_STATS, type ArmorClass } from '../../shared/botClasses.ts';
import { WeaponType } from '../../shared/weaponTable.ts';
import { WEAPONS } from '../../shared/weaponRows.ts';
import type { Vec3 } from '../../shared/protocol.ts';
import { connectRtc, type Link } from './netLink.ts';
import { resolveRoomTerrain, makeTerrainLoader, surfaceFor } from './netTerrain.ts';

// ---- args ---------------------------------------------------------------
const arg = (k: string, d: string): string => {
  const i = process.argv.indexOf(`--${k}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
// Accepts ws/wss URLs, pasted https tunnel URLs, or bare tunnel hosts —
// the friend test uses `wss://<host>.trycloudflare.com/ws`.
const normUrl = (u: string): string => {
  if (!u.includes('://')) {u = `wss://${u.includes('.') ? u : `${u  }.trycloudflare.com`}`;}
  u = u.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
  if (!u.slice(u.indexOf('://') + 3).includes('/')) {u += '/ws';}
  return u;
};
const URL_ = normUrl(arg('url', 'ws://localhost:8000/ws'));
const N = Number.parseInt(arg('bots', '8'), 10);
const ROOM = arg('room', 'default');
// --roomspec base=K: bot i joins `${base}-${(i % K) + 1}` — many small
// rooms from one process (per-proc spawn limits otherwise cap room count).
const ROOM_BASE = arg('roombase', '');
const ROOM_K = Number.parseInt(arg('roomk', '0'), 10);
const roomOf = (i: number): string => (ROOM_K > 0 && ROOM_BASE ? `${ROOM_BASE}-${(i % ROOM_K) + 1}` : ROOM);
const MODE = arg('mode', 'dm');
const POS_HZ = Number.parseInt(arg('posHz', '25'), 10);
const FIRE = arg('fire', '1') !== '0';
// Transport negotiation mirrors the browser client: best = RTC datachannel
// first (unreliable lane kills head-of-line stutter), WS as the floor.
// WebTransport has no client stack in Bun — skipped like a Firefox client.
const NET = arg('net', 'best');

// ---- surface ------------------------------------------------------------
const { path: MAP_PATH, field } = await resolveRoomTerrain(ROOM, arg('map', ''));
console.log(`[netBot] terrain: ${MAP_PATH}`);
const loadTerrain = makeTerrainLoader(field);
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const PERKS = PERK_ORDER.filter(p => p !== 'none');
const CLASSES: ArmorClass[] = ['light', 'medium', 'heavy'];

interface Roster { pos: Vec3; vel: Vec3; team?: 'alpha' | 'bravo'; dead?: boolean }

const stats = { sent: 0, recv: 0, corrections: 0, shots: 0, rejected: 0, errors: 0, closes: 0, joins: 0, tickGaps: 0, tickJit: 0, ballSegs: 0, ballWarps: 0, ballMaxJump: 0, crawlEvts: 0, crawlWarps: 0, crawlMaxJump: 0, rtc: 0, gems: 0, belowGround: 0, gapSamples: [] as string[] };

// Warp detector: consecutive updates for an entity should move it about
// speed·dt. A jump far past that is a visible teleport — server truth uses
// the segment's own sim-time `t`, so late delivery doesn't false-positive.

class WireBot {
  id: string;
  link: Link | null = null;
  tier: 'ws' | 'rtc' = 'ws';
  sim: MoveSim | null = null;
  roster = new Map<string, Roster>();
  /** v3 roster: u16 -> playerId — gameState snapshot + 'wireIds' deltas. */
  private readonly wireIds = new Map<number, string>();
  private readonly tickPool = { slots: [] as never[], byId: new Map<number, never>(), resolveId: (id: number) => this.wireIds.get(id) };
  seq = 0; inputSeq = 0; pingMs = 10;
  waypoint = { x: rand(-120, 120), z: rand(-120, 120) };
  jetUntil = 0; input = { forward: 1, right: 0, jump: 0, ski: 1, jet: 0, status: 0 };
  // The server's shadow models a real fuel tank and refuses jets at 0 —
  // a bot that thrusts on an infinite tank climbs tens of meters past
  // its shadow and reads as a teleport-scale cheat.
  energy = ENERGY.max;
  sentPingAt = 0; timers: ReturnType<typeof setInterval>[] = [];
  lastTickSeq = -1; lastTickAt = 0;
  balls = new Map<number, Vec3>(); crawls = new Map<number, Vec3>();
  pickups = new Map<number, Vec3>(); // gem/tag drops — sought in team modes
  ownShots: { id: string; until: number; usedShot: boolean; usedAoe: boolean }[] = []; shotN = 0;
  // Claims waiting for their server id, correlated to the echo by
  // spawn signature — FIFO alone breaks when a spawn is rejected
  // (its echo never comes, so the next echo binds off-by-one).
  pendingClaims: { pid?: string; wt: number; vx: number; vy: number; vz: number; exp: number }[] = [];
  // Room generation — bumped on every re-seat so a claim timer armed in
  // the old room can't fire into the new one with stale ids.
  private gen = 0;
  nextDeploy = 0; nextChat = 0; nextTeleport = 0; nextHeal = 0; nextLoadout = 0; nextEnvDmg = 0; nextSwitch = 0;
  // Right after a reseat (teleport, respawn) the server's last known
  // position lags until the next report lands — a spawn claim in that
  // gap reads as "implausible origin". Wait out the report grace.
  private fireHoldUntil = 0;
  // envDamage is a creature-contact report — no creature event in ~0.6s
  // means our tracked positions are stale (interest thinning, die)
  // and the server's live-sim check will call it implausible.
  private lastCreatureEvtAt = 0;
  private hopAlt = false;
  wasJump = false; wasJet = false;
  private lastSentInput = '';

  /** Real clients report input on change edges — the 400ms heartbeat
   *  alone makes the shadow replay each jet burst 400ms late, which
   *  reads as multi-meter false divergence. */
  private pushInput(): void {
    const key = JSON.stringify(this.input);
    if (key === this.lastSentInput) {return;}
    this.lastSentInput = key;
    this.sendBin(encodeInputMove(++this.inputSeq, { ...this.input }));
  }
  dead = false; // yourHealth<=0 until playerRespawn — dead clients go quiet
  team?: 'alpha' | 'bravo'; // own team — friendly targets are unshootable
  // The join-declared tier: the shadow skis at its speedScale, so the
  // local sim must too — a 1.0-sim against a 0.78 heavy shadow is a
  // permanent ~20% overspeed that reads as a movement cheat.
  private armorClass: ArmorClass;
  private pendingClass: ArmorClass | null = null; // classUpdate applies at respawn
  private applyClass(cls: ArmorClass): void {
    this.armorClass = cls;
    if (this.sim) {this.sim.speedScale = CLASS_STATS[cls].speedScale;}
  }
  // Warp state is per-bot — each socket sees its own (possibly interest-
  // filtered) stream, so comparing across sockets invents teleports.
  private lastSeg = new Map<string, { t: number; x: number; y: number; z: number; sp: number; judge: boolean }>();
  // Per-bot terrain: rooms can sit on different heightfields.
  private myField: Heightfield = field;
  private mySurf = surfaceFor(field);
  private myGy = (x: number, z: number) => hmHeight(this.myField, x, z);

  private segJump(kind: 'ball' | 'crawl', id: number, x: number, y: number, z: number, sp: number, t: number, segKind = ''): void {
    // Only judged→judged pairs are compared, but every segment updates
    // the anchor — otherwise a retarget→pounce→retarget run reads the
    // lunge's whole displacement as one wire jump. Balls judge 'bounce'
    // only (lunge/hit/teleport relocate legitimately); crawlers judge
    // the ground-travel kinds (pounce/charge/bite land wherever the
    // lunge ended).
    const judge = kind === 'ball'
      ? segKind === 'bounce'
      : (segKind === 'retarget' || segKind === 'windup' || segKind === 'fire');
    const key = `${kind}${id}`;
    const prev = this.lastSeg.get(key);
    this.lastSeg.set(key, { t, x, y, z, sp, judge });
    if (!prev || !judge || !prev.judge) {return;}
    const dt = t - prev.t;
    if (dt <= 0) {return;} // stale or replayed segment
    // Interest-scoped delivery drops segments — a >0.5s gap can hide a
    // legit relocation (hit/knockback between bounces), so only judge
    // tight sample pairs where a jump is provably discontinuous.
    if (dt > 0.5) {return;}
    const jump = Math.hypot(x - prev.x, y - prev.y, z - prev.z);
    const expected = Math.max(4, prev.sp * dt * 2 + 2); // slack for unseen accel
    if (jump > expected) {
      if (kind === 'ball') { stats.ballWarps++; stats.ballMaxJump = Math.max(stats.ballMaxJump, jump); }
      else { stats.crawlWarps++; stats.crawlMaxJump = Math.max(stats.crawlMaxJump, jump); }
    }
    if (this.lastSeg.size > 400) {this.lastSeg.clear();}
  }

  constructor(private i: number) {
    this.id = `NB-${i}-${Math.random().toString(36).slice(2, 6)}`;
    this.armorClass = CLASSES[i % CLASSES.length]!;
    void this.connect();
  }

  private async connect(): Promise<void> {
    if (NET !== 'ws') {
      this.link = await connectRtc(URL_, (d) => this.onMessage(d), () => { stats.closes++; console.log(`[netBot] ${this.id} rtc closed`); this.stop(); });
      if (this.link) { this.tier = 'rtc'; stats.rtc++; }
    }
    if (!this.link) {
      if (NET === 'rtc') { stats.errors++; return; }
      const ws = new WebSocket(URL_);
      ws.binaryType = 'arraybuffer';
      this.tier = 'ws';
      ws.onopen = () => this.onLinkOpen();
      ws.onmessage = (e) => this.onMessage(e.data);
      ws.onerror = () => stats.errors++;
      ws.onclose = (e) => { stats.closes++; console.log(`[netBot] ${this.id} closed ${e.code} ${e.reason}`); this.stop(); };
      this.link = {
        send: (d) => { if (ws.readyState === 1) {ws.send(d);} },
        close: () => ws.close(),
        open: () => ws.readyState === 1,
      };
      return; // join goes out in ws.onopen
    }
    this.onLinkOpen();
  }

  private onLinkOpen(): void {
    this.send({
      type: 'join', playerId: this.id, room: roomOf(this.i), mode: MODE,
      transport: this.tier,
      perk: PERKS[this.i % PERKS.length], armorClass: this.armorClass,
      ...(arg('spec', '') ? { map: arg('spec', '') } : {}),
    });
  }

  send(m: object): void {
    if (!this.link?.open()) {return;}
    this.link.send(typeof m === 'string' ? m : JSON.stringify(m));
    stats.sent++;
  }
  sendBin(u8: Uint8Array): void {
    if (!this.link?.open()) {return;}
    this.link.send(u8);
    stats.sent++;
  }

  onMessage(data: string | ArrayBuffer): void {
    stats.recv++;
    if (data instanceof ArrayBuffer) {
      const u8 = new Uint8Array(data);
      // Server ships one merged send per conn per tick — demux first:
      // len-prefixed subframes, each a complete wire frame (WIRE_JSON
      // carries reliable events back through the text path).
      if (u8[0] === 0x54 && u8[1] === 0x0D) {
        for (const sub of iterBatch(u8)) {this.onBinarySubframe(sub);}
        return;
      }
      this.onBinarySubframe(u8);
      return;
    }
    this.onJsonText(data);
  }

  /** One complete wire frame (whole datagram or a batch subframe). */
  private onBinarySubframe(u8: Uint8Array): void {
    if (u8[0] === 0x54 && u8[1] === 0x09) {
      const text = decodeWireJson(u8);
      if (text !== null) {this.onJsonText(text);}
      return;
    }
    // playerHit on the binary lane — resolve wireIds, run the same
    // JSON-path handler the string event used (seq dedupe preserved).
    if (u8[1] === 0x13) {
      const h = decodeHit(u8);
      const targetId = h ? this.wireIds.get(h.targetWid) : undefined;
      const shooterId = h ? (h.shooterWid === 0 ? 'environment' : this.wireIds.get(h.shooterWid)) : undefined;
      if (h && targetId && shooterId) {
        this.onMessage({ type: 'playerHit', shooterId, targetId, damage: h.damage, health: h.health, armor: h.armor, seq: h.seq, shotId: h.shotId, gd: h.gd });
      }
      return;
    }
    // wireId+pos event family — demux into the same onMessage the JSON
    // relay used (kind 0x14-0x18 share the decodeWidPos/etc codecs).
    if (u8[0] === 0x54 && u8[1]! >= 0x14 && u8[1]! <= 0x19) {
      const kind = u8[1]!;
      if (kind === 0x14 || kind === 0x15 || kind === 0x16) {
        const w = decodeWidPos(u8, kind);
        const pid = w ? this.wireIds.get(w.wid) : undefined;
        if (w && pid) {this.onMessage((kind === 0x16 ? { type: 'landed', playerId: pid, pos: w.pos, impact: w.extra } : { type: kind === 0x14 ? 'jump' : 'jetpack', playerId: pid, position: w.pos }) as never);}
      } else if (kind === 0x17) {
        const s = decodeShotEv(u8);
        const pid = s ? this.wireIds.get(s.wid) : undefined;
        if (s && pid) {this.onMessage({ type: 'playerShot', id: pid, weaponType: s.weaponType, pos: s.pos, dir: s.dir });}
      } else if (kind === 0x18) {
        const k = decodeKnock(u8);
        const tid = k ? this.wireIds.get(k.wid) : undefined;
        if (k && tid) {this.onMessage({ type: 'knockback', targetId: tid, position: k.pos, force: k.force, pull: k.pull, yank: k.yank });}
      } else if (kind === 0x19) {
        const k = decodeKill(u8);
        const tid = k ? this.wireIds.get(k.targetWid) : undefined;
        const sid = k ? (k.shooterWid === 0 ? 'environment' : this.wireIds.get(k.shooterWid)) : undefined;
        if (k && tid && sid) {this.onMessage({ type: 'playerKill', shooterId: sid, targetId: tid, weapon: k.weapon, streak: k.streak, air: k.air, steal: k.steal });}
      }
      return;
    }
    const f = decodeTickFrame(u8, this.tickPool as never);
    if (f) {
      // Tick-seq gaps = dropped frames → remote players stutter/warp.
      if (f.tickSeq > this.lastTickSeq + 1 && this.lastTickSeq >= 0) {
        stats.tickGaps += f.tickSeq - this.lastTickSeq - 1;
        if (stats.gapSamples.length < 20) {stats.gapSamples.push(`${this.lastTickSeq}->${f.tickSeq}`);}
      }
      this.lastTickSeq = Math.max(this.lastTickSeq, f.tickSeq);
      const now = performance.now();
      if (this.lastTickAt > 0) {
        const gap = now - this.lastTickAt;
        stats.tickJit = Math.max(stats.tickJit, gap);
      }
      this.lastTickAt = now;
    }
    const seg = decodeBallSegment(u8);
    if (seg) {
      stats.ballSegs++;
      this.segJump('ball', seg.id, seg.position.x, seg.position.y, seg.position.z,
        Math.hypot(seg.velocity.x, seg.velocity.y, seg.velocity.z), seg.t, seg.kind);
      this.balls.set(seg.id, seg.position);
      this.lastCreatureEvtAt = performance.now();
      if (this.balls.size > 300) {this.balls.clear();}
    }
    // Pooled slots: updates[] outlives the frame — past `count` is
    // stale tail from earlier, larger frames.
    if (f) {for (let ui = 0; ui < f.count; ui++) {
      const u = f.updates[ui]!;
      if (!u.playerId || u.playerId === this.id) {continue;}
      // Merge — overwriting drops team/dead fields that only the
      // announce path carries, and would silently re-enable friendly
      // fire + corpse-shooting every tick.
      const r = this.roster.get(u.playerId) ?? { pos: u.position, vel: u.velocity };
      r.pos = u.position; r.vel = u.velocity; r.dead = u.isDead;
      this.roster.set(u.playerId, r);
    }}
  }

  private onJsonText(data: string): void {
    const m = JSON.parse(data);
    switch (m.type) {
      case 'wireIds': {
        for (const [id, pid] of Object.entries(m.add as Record<string, string>)) {
          const wid = Number(id);
          // Re-seat without remove — the departed owner's baseline must
          // not feed the new owner's masked deltas.
          if (this.wireIds.has(wid)) {this.tickPool.byId.delete(wid);}
          this.wireIds.set(wid, pid);
        }
        for (const id of (m.remove ?? []) as number[]) {this.wireIds.delete(id); this.tickPool.byId.delete(id);}
        break;
      }
      case 'gameState': {
        // A re-seat (switchRoom hop) replaces the whole room: old-room
        // roster ids read as 'unknown target' on claims, entity anchors
        // read as 300m warps, and projectile ids minted over there read
        // as 'blast with no known projectile' here. Reset all of it.
        this.roster.clear();
        this.wireIds.clear();
        this.tickPool.byId.clear();
        if (m.wireIds) {for (const [id, pid] of Object.entries(m.wireIds as Record<string, string>)) {this.wireIds.set(Number(id), pid);}}
        this.lastSeg.clear();
        this.balls.clear();
        this.crawls.clear();
        this.pickups.clear();
        this.ownShots.length = 0;
        this.pendingClaims.length = 0;
        this.gen++;
        this.fireHoldUntil = performance.now() + 600;
        // The sim is rebuilt after the async terrain load — until then
        // this.sim is the OLD room's sim at an old-room position, and a
        // claim fired from it reads as a 100m+ implausible spawn.
        this.sim = null;
        // Tick seqs are per-room — a hop lands mid-sequence in the new
        // room's domain, not a dropped frame.
        this.lastTickSeq = -1;
        // Seat the sim at our spawn and index the roster for aiming.
        this.team = m.team;
        for (const p of m.players ?? []) {
          // gameState roster uses `id` (not `playerId` like tick records).
          const pid = p.id ?? p.playerId;
          if (pid !== this.id) {this.roster.set(pid, { pos: p.position, vel: p.velocity ?? { x: 0, y: 0, z: 0 }, team: p.team });}
        }
        for (const pk of m.pickups ?? []) {this.pickups.set(pk.id, pk.pos);}
        const me = m.localPlayerState?.position ?? m.players?.find((p: { id?: string; playerId?: string }) => (p.id ?? p.playerId) === this.id)?.position
          ?? { x: rand(-20, 20), y: 40, z: rand(-20, 20) };
        void loadTerrain(m.map?.terrain ?? 'heightmap.bin').then((f) => {
          this.myField = f;
          this.mySurf = surfaceFor(f);
          this.sim = new MoveSim(this.mySurf, {
            pos: { x: me.x, y: me.y, z: me.z },
            vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, onGround: true,
          });
          this.sim.speedScale = CLASS_STATS[this.armorClass].speedScale;
          stats.joins++;
          // Re-seat (switchRoom, reconnect) revives: the corpse flag belongs
          // to the room we just left — no respawn message ever arrives for
          // it in the new one.
          this.dead = false;
          this.start();
        });
        break;
      }
      case 'playerJoined': { this.roster.set(m.playerId, { pos: m.position, vel: { x: 0, y: 0, z: 0 }, team: m.team }); break;
      }
      case 'teamUpdate': {
        if (m.playerId === this.id) {this.team = m.team;}
        else { const r = this.roster.get(m.playerId); if (r) {r.team = m.team;} }
        break;
      }
      case 'projectileCreated': {
        // Server-assigned id — destroy claims must name this one.
        if (m.ownerId === this.id) {
          this.ownShots.push({ id: m.projectileId, until: performance.now() + 2500, usedShot: false, usedAoe: false });
          const ci = this.pendingClaims.findIndex((c) =>
            c.exp > performance.now() &&
            c.wt === (m.weaponType ?? -1) &&
            Math.hypot(c.vx - m.velocity.x, c.vy - m.velocity.y, c.vz - m.velocity.z) < 1);
          if (ci !== -1) {this.pendingClaims.splice(ci, 1)[0]!.pid = m.projectileId;}
        }
        break;
      }
      case 'playerLeft': { this.roster.delete(m.playerId); break;
      }
      case 'pong': { this.pingMs = Math.max(1, Date.now() - m.timestamp); break;
      }
      case 'shotRejected': {
        stats.rejected++;
        if (stats.rejected <= 10) {console.log(`[netBot] ${this.id} shotRejected: ${m.reason}`);}
        break;
      }
      case 'crawlEvt': {
        stats.crawlEvts++;
        this.segJump('crawl', m.id, m.position.x, m.position.y, m.position.z,
          Math.hypot(m.velocity?.x ?? 0, m.velocity?.y ?? 0, m.velocity?.z ?? 0), m.t, m.kind);
        this.crawls.set(m.id, m.position);
        this.lastCreatureEvtAt = performance.now();
        if (this.crawls.size > 300) {this.crawls.clear();}
        break;
      }
      case 'pickupSpawn': { this.pickups.set(m.id, m.pos); break;
      }
      case 'pickupGone': { this.pickups.delete(m.id); if (m.by === this.id) {stats.gems++;} break;
      }
      case 'ballDie': { this.balls.delete(m.id); this.lastSeg.delete(`ball${m.id}`); break;
      }
      case 'crawlDie': { this.crawls.delete(m.id); this.lastSeg.delete(`crawl${m.id}`); break;
      }
      case 'correction': {
        // A real client rewinds to the server's truth — do the same.
        if (this.sim) {
          const s = this.sim.state;
          s.pos.x = m.position.x; s.pos.y = m.position.y; s.pos.z = m.position.z;
          s.vel.x = m.velocity.x; s.vel.y = m.velocity.y; s.vel.z = m.velocity.z;
          if (m.grounded !== undefined) {s.onGround = m.grounded;}
        }
        stats.corrections++;
        break;
      }
      case 'playerKill': {
        // Death arrives as a kill broadcast — the corpse goes quiet.
        if (m.targetId === this.id) {this.dead = true;}
        else if (m.targetId) {
          const r = this.roster.get(m.targetId);
          if (r) {r.dead = true;}
        }
        break;
      }
      case 'knockback': {
        // The server's shadow received this impulse too — a client that
        // doesn't apply it reports an unshoved trajectory and reads as a
        // teleport-scale divergence until the judge kicks it.
        if (m.targetId === this.id && this.sim) {
          const s = this.sim.state;
          const dx = s.pos.x - m.position.x, dy = s.pos.y - m.position.y, dz = s.pos.z - m.position.z;
          const d = Math.hypot(dx, dy, dz);
          if (d > 0) {
            if (m.pull) { s.vel.x -= (dx / d) * m.force; s.vel.y += 0.3 * m.force; s.vel.z -= (dz / d) * m.force; }
            else { s.vel.x += (dx / d) * m.force; s.vel.y += 0.5 * m.force; s.vel.z += (dz / d) * m.force; }
          }
        }
        break;
      }
      case 'yourHealth': {
        if (m.health <= 0) {this.dead = true;}
        break;
      }
      case 'teleport': {
        // A remote's declared warp — update the aim roster immediately
        // instead of shooting the pre-warp ghost until the next tick.
        if (m.playerId && m.playerId !== this.id) {
          const r = this.roster.get(m.playerId);
          if (r) { r.pos.x = m.position.x; r.pos.y = m.position.y; r.pos.z = m.position.z; }
        }
        break;
      }
      case 'playerRespawn': {
        // Our own respawn — a real client snaps to the spawn point.
        // Without this the local sim keeps reporting from the corpse
        // spot and the judge reads 100m+ of "teleport" divergence.
        if (m.playerId === this.id && this.sim) {
          const s = this.sim.state;
          s.pos.x = m.position.x; s.pos.y = m.position.y; s.pos.z = m.position.z;
          s.vel.x = 0; s.vel.y = 0; s.vel.z = 0;
          s.onGround = true;
          this.energy = ENERGY.max; // respawn refills the tank
          if (this.pendingClass) { this.applyClass(this.pendingClass); this.pendingClass = null; }
          this.waypoint = { x: rand(-140, 140), z: rand(-140, 140) };
          this.dead = false;
          this.fireHoldUntil = performance.now() + 600;
        } else if (m.playerId && m.playerId !== this.id) {
          const r = this.roster.get(m.playerId);
          if (r) { r.pos.x = m.position.x; r.pos.y = m.position.y; r.pos.z = m.position.z; r.dead = false; }
        }
        break;
      }
    }
  }

  start(): void {
    // Idempotent — a second gameState (switchRoom re-seat) must reset the
    // cadence, not stack another copy of every interval.
    this.stop();
    this.timers.length = 0;
    const posMs = 1000 / POS_HZ;
    // Position stream — the binary lane real clients use.
    this.timers.push(setInterval(() => {
      if (!this.sim) {return;}
      // Dead players stop streaming — the server drops their reports
      // anyway, and a corpse walking is exactly the anomaly the judge
      // exists to catch. The respawn broadcast reseats us.
      if (this.dead) {return;}
      this.step(posMs / 1000);
      const s = this.sim.state;
      this.sendBin(encodePosition(s.pos, { yaw: s.yaw, pitch: s.pitch }, s.vel, ++this.seq, this.pingMs, this.inputSeq));
    }, posMs));
    // inputMove journal — change-driven like a real client plus a
    // heartbeat so late seq gaps never starve the shadow.
    this.timers.push(setInterval(() => {
      this.lastSentInput = ''; // heartbeat — re-push whatever is current
      this.pushInput();
    }, 400));
    this.timers.push(setInterval(() => {
      this.sentPingAt = Date.now();
      this.send({ type: 'ping', timestamp: this.sentPingAt });
    }, 2000));
    if (FIRE) {this.timers.push(setInterval(() => this.fire(), rand(900, 2200)));}
    // The rest of the client vocabulary, at a human-plausible cadence:
    // deployables, chat, teleports, heals, loadout edits, creature claims,
    // projectile destroys. snapshotRequest once — that's what a real client
    // asks for right after joining a live room.
    this.send({ type: 'snapshotRequest' });
    this.timers.push(setInterval(() => this.misc(), 500));
    this.nextDeploy = performance.now() + rand(8000, 20_000);
    this.nextChat = performance.now() + rand(15_000, 45_000);
    this.nextTeleport = performance.now() + rand(30_000, 80_000);
    this.nextHeal = performance.now() + rand(20_000, 60_000);
    this.nextLoadout = performance.now() + rand(45_000, 120_000);
    this.nextEnvDmg = performance.now() + rand(30_000, 90_000);
    // First hop lands early enough for a soak to see it — after that
    // the 2-4min cadence applies.
    this.nextSwitch = performance.now() + rand(20_000, 80_000);
  }

  /** Everything else a legal client says, rolled at plausible rates. */
  private misc(): void {
    const s = this.sim?.state;
    if (!s || this.dead) {return;}
    const now = performance.now();

    // Own-projectile cleanup — clients destroy their live shells on
    // impact/expiry; ours live ~1.5s of airtime.
    while (this.ownShots.length > 0 && this.ownShots[0]!.until <= now) {
      const {id} = this.ownShots.shift()!;
      this.send({ type: 'projectileDestroy', projectileId: id });
    }

    if (now >= this.nextDeploy) {
      this.nextDeploy = now + rand(15_000, 40_000);
      const kinds = ['turret', 'mine', 'station', 'drone'] as const;
      this.send({ type: 'deploy', kind: kinds[Math.floor(rand(0, 4))], position: { x: s.pos.x, y: s.pos.y, z: s.pos.z } });
    }
    if (now >= this.nextChat) {
      this.nextChat = now + rand(20_000, 60_000);
      const lines = ['wp', 'incoming!', 'disc jump incoming', 'need a pickup', 'flag runner left', 'lag check'];
      // Half the chatter goes team-scoped — exercises the fanout filter.
      this.send({ type: 'chat', text: lines[Math.floor(rand(0, lines.length))], team: rand(0, 1) < 0.5 });
    }
    if (now >= this.nextTeleport) {
      // Warp-blink cadence — the server caps teleports at ~1/s anyway.
      this.nextTeleport = now + rand(25_000, 70_000);
      const tx = s.pos.x + rand(-30, 30), tz = s.pos.z + rand(-30, 30);
      s.pos.x = tx; s.pos.z = tz; s.pos.y = this.myGy(tx, tz) + 1;
      s.vel.x *= 0.5; s.vel.y = 0; s.vel.z *= 0.5;
      this.send({ type: 'teleport', position: { ...s.pos }, rotation: { yaw: s.yaw, pitch: s.pitch }, velocity: { ...s.vel } });
      this.fireHoldUntil = performance.now() + 600;
    }
    if (now >= this.nextHeal) {
      this.nextHeal = now + rand(25_000, 70_000);
      this.send({ type: 'heal', amount: Math.round(rand(5, 25)) });
    }
    if (now >= this.nextLoadout) {
      this.nextLoadout = now + rand(60_000, 150_000);
      this.pendingClass = CLASSES[Math.floor(rand(0, 3))]!;
      this.send({ type: 'classUpdate', armorClass: this.pendingClass });
      this.send({ type: 'perkUpdate', perk: PERKS[Math.floor(rand(0, PERKS.length))] });
    }
    if (now >= this.nextEnvDmg) {
      // Legal claims only: the server flags env damage with no creature
      // within ~15m as implausible, so bots only report when something's
      // actually on them.
      // Tracked positions go stale between events — the server measures
      // against live sims, so keep slack below its plausibility gate.
      this.nextEnvDmg = now + rand(40_000, 120_000);
      if (now - this.lastCreatureEvtAt <= 600) {
        let near = false;
        for (const p of this.crawls.values()) {
          const d = (p.x - s.pos.x) ** 2 + (p.y - s.pos.y) ** 2 + (p.z - s.pos.z) ** 2;
          if (d < 10 * 10) { near = true; break; }
        }
        if (!near) {for (const p of this.balls.values()) {
          const d = (p.x - s.pos.x) ** 2 + (p.y - s.pos.y) ** 2 + (p.z - s.pos.z) ** 2;
          if (d < 10 * 10) { near = true; break; }
        }}
        if (near) {this.send({ type: 'environmentDamage', amount: Math.round(rand(5, 15)) });}
      }
    }
    if (now >= this.nextSwitch) {
      // Room-hop stress path — full teardown + rejoin, rare like a real hop.
      // Alternate target: hopping into ROOM itself is a server-side no-op.
      this.nextSwitch = now + rand(120_000, 240_000);
      this.hopAlt = !this.hopAlt;
      this.send({ type: 'switchRoom', room: this.hopAlt ? `${ROOM}-alt` : ROOM, mode: MODE });
    }

    // Creature claims — only when something's actually in reach, same
    // rule a real client's input resolves by.
    const reach = (p: Vec3) => (p.x - s.pos.x) ** 2 + (p.y - s.pos.y) ** 2 + (p.z - s.pos.z) ** 2 < 20 * 20;
    for (const [id, p] of this.balls) {
      if (reach(p)) { this.send({ type: 'creatureHit', id, damage: Math.round(rand(10, 30)) }); break; }
    }
    for (const [id, p] of this.crawls) {
      if (reach(p)) { this.send({ type: 'crawlerHit', id, damage: Math.round(rand(10, 30)) }); break; }
    }
  }

  /** One honest sim step toward the current waypoint — ski held like any
   *  Tribes player, jet bursts when climbing, occasional hops. */
  private step(dt: number): void {
    const s = this.sim!.state;
    // Team-mode objective play: nearest drop inside 80m outranks the
    // wander waypoint — bots farm gems and earn their heal credit like
    // a player instead of claiming heals they never touched.
    if (MODE === 'nuggets' || MODE === 'ctf') {
      let bd = 80 * 80, bp: Vec3 | null = null;
      for (const p of this.pickups.values()) {
        const d = (p.x - s.pos.x) ** 2 + (p.z - s.pos.z) ** 2;
        if (d < bd) { bd = d; bp = p; }
      }
      if (bp) {this.waypoint = { x: bp.x, z: bp.z };}
    }
    const dx = this.waypoint.x - s.pos.x, dz = this.waypoint.z - s.pos.z;
    if (dx * dx + dz * dz < 25) {this.waypoint = { x: rand(-140, 140), z: rand(-140, 140) };}
    s.yaw = Math.atan2(dx, dz);
    // Uphill climbs get a jet burst — same thing a human does. Fuel is
    // real: thrust drains 15/s, idle recharges 8/s, empty tank = no jets
    // (the server's shadow enforces the identical model).
    if (this.jetUntil < performance.now() && this.energy > 20 && Math.random() < 0.004) {this.jetUntil = performance.now() + rand(400, 1200);}
    const jetting = performance.now() < this.jetUntil && this.energy > 0;
    if (jetting) {this.energy = Math.max(0, this.energy - ENERGY.jetDrain * dt);}
    else {this.energy = Math.min(ENERGY.max, this.energy + ENERGY.jetCharge * dt);}
    this.input.jet = jetting ? 1 : 0;
    this.input.jump = Math.random() < 0.008 ? 1 : 0;
    this.pushInput();
    // Rising-edge event reports — real clients announce jump/jet starts
    // so remotes see the launch, not just the position drift.
    if (this.input.jump === 1 && !this.wasJump) {this.sendBin(encodePosClaim(0x0E, { x: s.pos.x, y: s.pos.y, z: s.pos.z }));}
    if (jetting && !this.wasJet) {this.sendBin(encodePosClaim(0x0F, { x: s.pos.x, y: s.pos.y, z: s.pos.z }));}
    this.wasJump = this.input.jump === 1; this.wasJet = jetting;
    this.sim!.setInput({
      forward: 1, right: 0,
      jumpHeld: this.input.jump === 1,
      jumpPressed: this.input.jump === 1,
      skiHeld: true,
      jetHeld: jetting,
    });
    this.sim!.update(dt);
    // Gravity safety net: MoveSim integrates but a stray NaN poisons
    // every subsequent report — clamp like a client's own sanity check.
    if (!Number.isFinite(s.pos.x + s.pos.y + s.pos.z)) {
      s.pos.y = this.myGy(s.pos.x, s.pos.z) + 2;
      s.vel.x = s.vel.y = s.vel.z = 0;
    }
    // Terrain penetration probe: a fast descent can tunnel below the
    // field — reports from under the map read as clipping cheats.
    const depth = this.myGy(s.pos.x, s.pos.z) - s.pos.y;
    if (depth > 2) {stats.belowGround++;}
  }

  private fire(): void {
    if (!this.sim || this.roster.size === 0 || this.dead) {return;}
    if (performance.now() < this.fireHoldUntil) {return;}
    const s = this.sim.state;
    // Nearest wire target — aim claims must name a live peer id, and
    // never a teammate (friendly fire is rejected outright).
    let best: string | null = null, bd = 1e9;
    for (const [id, r] of this.roster) {
      if (this.team && r.team === this.team) {continue;}
      if (r.dead) {continue;}
      const d = (r.pos.x - s.pos.x) ** 2 + (r.pos.y - s.pos.y) ** 2 + (r.pos.z - s.pos.z) ** 2;
      if (d < bd) { bd = d; best = id; }
    }
    if (!best || bd > 100 * 100) {return;}
    stats.shots++;
    const t = this.roster.get(best)!;
    const dist = Math.max(Math.sqrt(bd), 1);
    // Disc: the one launcher shell with gravity:false — the linear-flight
    // claim math below is exactly true for it (the old 2:0 mix also
    // hardcoded speeds against the table's real 40/120 — claims could
    // never have matched a server shell). direct picks the body-hit
    // claim path, else the blast-landing path — both stay exercised.
    const direct = Math.random() < 0.5;
    const weaponType = WeaponType.Disc;
    const {speed} = WEAPONS[weaponType];
    const dir = { x: (t.pos.x - s.pos.x) / dist, y: (t.pos.y - s.pos.y) / dist, z: (t.pos.z - s.pos.z) / dist };
    // A claim only resolves against a shell the ledger watched launch —
    // the spawn report goes first, the server-assigned id arrives on the
    // projectileCreated echo (claims may omit the id → latest-of-type).
    // shotFired is the fire intent for server-simmed weapons — the
    // server spawns the authoritative shell off dir+weapon-speed and
    // echoes shotId on projectileCreated (the 'shot' type never
    // existed on the wire — every spawn + claim silently rejected).
    this.sendBin(encodeShot({ weaponType, dir, pos: { x: s.pos.x, y: s.pos.y + 1.6, z: s.pos.z } }));
    // Muzzle velocity = dir*speed + 50% shooter velocity — the SAME
    // inheritance the server applies (RoomProjectiles.spawn). The pid
    // binding below matches the echo's velocity, so the claim must
    // record the inherited velocity or a moving bot's shells never bind.
    const vx = dir.x * speed + 0.5 * s.vel.x;
    const vy = dir.y * speed + 0.5 * s.vel.y;
    const vz = dir.z * speed + 0.5 * s.vel.z;
    const flightSpeed = Math.hypot(vx, vy, vz) || 1;
    const airtime = dist / flightSpeed;
    const firedAt = performance.now();
    // The claim must outlive its own airtime — the server rejects a
    // detonation whose claimed flight time exceeds the shell's age. And
    // it must name THIS shell's id: a bare claim resolves the newest
    // matching projectile, so a shell fired mid-flight would inherit
    // our airtime against its own fresh age.
    // Expiry = airtime + echo slack — a spawn rejected server-side never
    // echoes, and its stale entry must not bind a LATER spawn's echo.
    const mine: { pid?: string; wt: number; vx: number; vy: number; vz: number; exp: number } = {
      wt: weaponType, vx, vy, vz,
      exp: firedAt + airtime * 1000 + 400,
    };
    this.pendingClaims.push(mine);
    // A rejected spawn never echoes — its entry must leave the queue at
    // claim time or it steals the NEXT projectileCreated binding and
    // every later claim names a shell that isn't its own.
    const unpend = () => {
      const i = this.pendingClaims.indexOf(mine);
      if (i !== -1) {this.pendingClaims.splice(i, 1);}
    };
    let waited = 0;
    const {gen} = this;
    const claim = () => {
      if (gen !== this.gen) {return;} // armed in a room we already left
      // The echo can lag the airtime deadline on unordered lanes — a
      // bare claim would resolve the NEWEST matching shell and paint
      // our airtime onto its fresh age. Hold briefly for the id.
      if (!mine.pid && waited < 400) { waited += 40; setTimeout(claim, 40); return; }
      unpend();
      // No echo = the spawn was rejected: there is nothing to claim on.
      // A bare claim would invoke the latest-of-type fallback, which
      // tombstones EVERY matching live shell — stealing other pending
      // claims' projectiles.
      if (!mine.pid) {return;}
      const {pid} = mine;
      if (direct) {
        // A real client only claims what it hit — if the target drifted
        // since we fired, that shell just missed; claim nothing. A dead
        // target is an untouchable corpse — also claim nothing.
        const cur = this.roster.get(best);
        // No roster entry = the target hopped or left mid-flight — a real
        // client lost its bead too; claiming at the stale spot reads as
        // an impossible reach.
        if (!cur || cur.dead) {return;}
        // Team balance flips land between fire and claim — re-check or
        // the hit lands as friendly fire.
        if (this.team && cur.team === this.team) {return;}
        // Drift check must be 3D — a target falling 100m+ shares x/z but
        // the claimed hit reads as an impossible reach server-side.
        if ((cur.pos.x - t.pos.x) ** 2 + (cur.pos.y - t.pos.y) ** 2 + (cur.pos.z - t.pos.z) ** 2 > 36) {return;}
        this.sendBin(encodeShot({ weaponType }));
        // Direct-hit claim: the client's own shape — excludeTargetId
        // names the direct victim so the AOE ring doesn't double-pay.
        this.send({ type: 'aoeShot', position: { ...cur.pos }, weaponType, excludeTargetId: best, airtime, projectileId: pid, directHit: true });
      } else {
        // The blast claim must sit where the shell actually flew — the
        // reach check recomputes the trajectory, so aiming at where the
        // target moved reads as an impossible detonation.
        const ex = s.pos.x + vx * airtime;
        const ez = s.pos.z + vz * airtime;
        const ey = Math.max(this.myGy(ex, ez), s.pos.y + vy * airtime);
        this.send({ type: 'aoeShot', position: { x: ex, y: ey, z: ez }, weaponType, airtime, projectileId: pid });
      }
    };
    // Claims land at real impact time — claiming early on a long shot
    // sends an airtime the shell hasn't flown yet and the server's reach
    // check reads it as an impossible endpoint.
    setTimeout(claim, airtime * 1000);
  }

  private stop(): void { for (const t of this.timers) {clearInterval(t);} }
}

const bots: WireBot[] = [];
for (let i = 0; i < N; i++) {bots.push(new WireBot(i));}

setInterval(() => {
  const s = stats;
  const pings = bots.map((b) => b.pingMs).filter((p) => p > 0).sort((a, b) => a - b);
  const ping = pings.length > 0
    ? ` ping=${pings[0]}/${pings[Math.floor(pings.length / 2)]}/${pings[pings.length - 1]}ms`
    : '';
  console.log(`[netBot] ${bots.length} bots (${s.rtc} rtc) | joins=${s.joins} sent=${s.sent} recv=${s.recv} shots=${s.shots} rej=${s.rejected} gems=${s.gems} corr=${s.corrections} belowGnd=${s.belowGround} err=${s.errors} closes=${s.closes} tickGaps=${s.tickGaps} maxTickGap=${Math.round(s.tickJit)}ms ball=${s.ballSegs}/${s.ballWarps}w max${s.ballMaxJump.toFixed(0)}m crawl=${s.crawlEvts}/${s.crawlWarps}w max${s.crawlMaxJump.toFixed(0)}m${ping}${s.gapSamples.length > 0 ? ` gaps[${s.gapSamples.join(' ')}]` : ''}`);
}, 5000);
