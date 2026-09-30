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
 */
import { MoveSim, GRAVITY, type MoveState } from '../../shared/movement.ts';
import { hmHeight, type Heightfield } from '../../shared/heightfield.ts';
import { encodePosition, decodeTickFrame, isWireFrame } from '../../shared/wire.ts';
import { PERK_ORDER } from '../../shared/perks.ts';
import type { Vec3 } from '../../shared/protocol.ts';

// ---- args ---------------------------------------------------------------
const arg = (k: string, d: string): string => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
// Accepts ws/wss URLs, pasted https tunnel URLs, or bare tunnel hosts —
// the friend test uses `wss://<host>.trycloudflare.com/ws`.
const normUrl = (u: string): string => {
  if (!u.includes('://')) u = `wss://${u.includes('.') ? u : u + '.trycloudflare.com'}`;
  u = u.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
  if (!u.slice(u.indexOf('://') + 3).includes('/')) u += '/ws';
  return u;
};
const URL_ = normUrl(arg('url', 'ws://localhost:8000/ws'));
const N = parseInt(arg('bots', '8'), 10);
const ROOM = arg('room', 'default');
const MODE = arg('mode', 'dm');
const POS_HZ = parseInt(arg('posHz', '25'), 10);
const FIRE = arg('fire', '1') !== '0';
const MAP_PATH = arg('map', new URL('../heightmap.bin', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

// ---- surface ------------------------------------------------------------
const bunFile = (globalThis as { Bun?: { file(p: string): { arrayBuffer(): Promise<ArrayBuffer> } } }).Bun?.file;
if (!bunFile) throw new Error('netBot requires Bun');
const buf = new Uint8Array(await bunFile(MAP_PATH).arrayBuffer());
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const W = dv.getUint32(0, true), H = dv.getUint32(4, true);
const field: Heightfield = { size: W, data: buf.subarray(8), stride: 1 };
if (W !== H) throw new Error('non-square heightmap');
const gy = (x: number, z: number) => hmHeight(field, x, z);
const _gn = { x: 0, y: 1, z: 0 };
const surface = {
  getHeight: gy,
  getNormal(x: number, z: number, out: { x: number; y: number; z: number }) {
    const e = 0.5;
    out.x = (gy(x - e, z) - gy(x + e, z)) / (2 * e);
    out.y = 1;
    out.z = (gy(x, z - e) - gy(x, z + e)) / (2 * e);
    const l = Math.hypot(out.x, out.y, out.z);
    out.x /= l; out.y /= l; out.z /= l;
    return out;
  },
};

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const PERKS = PERK_ORDER.filter(p => p !== 'none');
const CLASSES = ['light', 'medium', 'heavy'];

interface Roster { pos: Vec3; vel: Vec3 }

const stats = { sent: 0, recv: 0, corrections: 0, shots: 0, errors: 0, closes: 0, joins: 0 };

class WireBot {
  id: string;
  ws: WebSocket;
  sim: MoveSim | null = null;
  roster = new Map<string, Roster>();
  seq = 0; inputSeq = 0; pingMs = 10;
  waypoint = { x: rand(-120, 120), z: rand(-120, 120) };
  jetUntil = 0; input = { forward: 1, right: 0, jump: 0, ski: 1, jet: 0, status: 0 };
  sentPingAt = 0; timers: ReturnType<typeof setInterval>[] = [];

  constructor(i: number) {
    this.id = `NB-${i}-${Math.random().toString(36).slice(2, 6)}`;
    this.ws = new WebSocket(URL_);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => {
      this.send({
        type: 'join', playerId: this.id, room: ROOM, mode: MODE,
        transport: 'ws',
        perk: PERKS[i % PERKS.length], armorClass: CLASSES[i % CLASSES.length],
      });
    };
    this.ws.onmessage = (e) => this.onMessage(e.data);
    this.ws.onerror = () => stats.errors++;
    this.ws.onclose = () => { stats.closes++; this.stop(); };
  }

  send(m: object): void {
    if (this.ws.readyState !== 1) return;
    this.ws.send(typeof m === 'string' ? m : JSON.stringify(m));
    stats.sent++;
  }
  sendBin(u8: Uint8Array): void {
    if (this.ws.readyState !== 1) return;
    this.ws.send(u8);
    stats.sent++;
  }

  onMessage(data: string | ArrayBuffer): void {
    stats.recv++;
    if (data instanceof ArrayBuffer) {
      const f = decodeTickFrame(new Uint8Array(data));
      if (f) for (const u of f.updates) {
        if (u.playerId === this.id) continue;
        this.roster.set(u.playerId, { pos: u.position, vel: u.velocity });
      }
      return;
    }
    const m = JSON.parse(data);
    switch (m.type) {
      case 'gameState': {
        // Seat the sim at our spawn and index the roster for aiming.
        for (const p of m.players ?? []) {
          if (p.playerId !== this.id) this.roster.set(p.playerId, { pos: p.position, vel: p.velocity ?? { x: 0, y: 0, z: 0 } });
        }
        const me = m.localPlayerState?.position ?? m.players?.find((p: { playerId: string }) => p.playerId === this.id)?.position
          ?? { x: rand(-20, 20), y: 40, z: rand(-20, 20) };
        this.sim = new MoveSim(surface, {
          pos: { x: me.x, y: me.y, z: me.z },
          vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, onGround: true,
        });
        stats.joins++;
        this.start();
        break;
      }
      case 'playerJoined': this.roster.set(m.playerId, { pos: m.position, vel: { x: 0, y: 0, z: 0 } }); break;
      case 'playerLeft': this.roster.delete(m.playerId); break;
      case 'pong': this.pingMs = Math.max(1, Date.now() - m.timestamp); break;
      case 'correction':
        // A real client rewinds to the server's truth — do the same.
        if (this.sim) {
          const s = this.sim.state;
          s.pos.x = m.position.x; s.pos.y = m.position.y; s.pos.z = m.position.z;
          s.vel.x = m.velocity.x; s.vel.y = m.velocity.y; s.vel.z = m.velocity.z;
          if (m.grounded !== undefined) s.onGround = m.grounded;
        }
        stats.corrections++;
        break;
    }
  }

  start(): void {
    const posMs = 1000 / POS_HZ;
    // Position stream — the binary lane real clients use.
    this.timers.push(setInterval(() => {
      if (!this.sim) return;
      this.step(posMs / 1000);
      const s = this.sim.state;
      this.sendBin(encodePosition(s.pos, { yaw: s.yaw, pitch: s.pitch }, s.vel, ++this.seq, this.pingMs, this.inputSeq));
    }, posMs));
    // inputMove journal — change-driven like a real client plus a
    // heartbeat so late seq gaps never starve the shadow.
    this.timers.push(setInterval(() => {
      this.inputSeq++;
      const s = this.sim?.state;
      this.send({
        type: 'inputMove', seq: this.inputSeq,
        input: { ...this.input },
        rotation: { yaw: s?.yaw ?? 0, pitch: 0 },
      });
    }, 400));
    this.timers.push(setInterval(() => {
      this.sentPingAt = Date.now();
      this.send({ type: 'ping', timestamp: this.sentPingAt });
    }, 2000));
    if (FIRE) this.timers.push(setInterval(() => this.fire(), rand(900, 2200)));
  }

  /** One honest sim step toward the current waypoint — ski held like any
   *  Tribes player, jet bursts when climbing, occasional hops. */
  private step(dt: number): void {
    const s = this.sim!.state;
    const dx = this.waypoint.x - s.pos.x, dz = this.waypoint.z - s.pos.z;
    if (dx * dx + dz * dz < 25) this.waypoint = { x: rand(-140, 140), z: rand(-140, 140) };
    s.yaw = Math.atan2(dx, dz);
    // Uphill climbs get a jet burst — same thing a human does.
    if (this.jetUntil < performance.now() && Math.random() < 0.004) this.jetUntil = performance.now() + rand(400, 1200);
    const jetting = performance.now() < this.jetUntil;
    this.input.jet = jetting ? 1 : 0;
    this.input.jump = Math.random() < 0.008 ? 1 : 0;
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
      s.pos.y = gy(s.pos.x, s.pos.z) + 2;
      s.vel.x = s.vel.y = s.vel.z = 0;
    }
  }

  private fire(): void {
    if (!this.sim || this.roster.size === 0) return;
    const s = this.sim.state;
    // Nearest wire target — aim claims must name a live peer id.
    let best: string | null = null, bd = 1e9;
    for (const [id, r] of this.roster) {
      const d = (r.pos.x - s.pos.x) ** 2 + (r.pos.y - s.pos.y) ** 2 + (r.pos.z - s.pos.z) ** 2;
      if (d < bd) { bd = d; best = id; }
    }
    if (!best || bd > 100 * 100) return;
    stats.shots++;
    if (Math.random() < 0.5) {
      // Hitscan claim — server clamps damage by weapon type.
      this.send({ type: 'shotFired', weaponType: 2 });
      this.send({ type: 'shot', targetId: best, weaponType: 2 });
    } else {
      // Disc AOE — legal as long as the blast point is within 500m.
      const t = this.roster.get(best)!;
      const jx = t.pos.x + rand(-4, 4), jz = t.pos.z + rand(-4, 4);
      this.send({ type: 'aoeShot', position: { x: jx, y: Math.max(gy(jx, jz), t.pos.y), z: jz }, weaponType: 0, airtime: rand(0.3, 1.6) });
    }
  }

  private stop(): void { for (const t of this.timers) clearInterval(t); }
}

const bots: WireBot[] = [];
for (let i = 0; i < N; i++) bots.push(new WireBot(i));

setInterval(() => {
  const s = stats;
  console.log(`[netBot] ${bots.length} bots | joins=${s.joins} sent=${s.sent} recv=${s.recv} shots=${s.shots} corr=${s.corrections} err=${s.errors} closes=${s.closes}`);
}, 5000);
