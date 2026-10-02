// NetBot behavior — a REAL BotBrain driving a REAL wire client. Movement
// goes out on the position channel (the bot owns its own kinematics like a
// v1 client); fire decisions go through the real claim chain the browser
// client uses: spawn `shot` → hit claim `shot` / blast claim `aoeShot`,
// bound by shotId. That chain is exactly what the deferred-claim and
// seq-watermark fixes protect, which is what this harness exists to
// exercise — a server-internal bot can never produce a reject.

import { BotBrain, type BotEnemy, type BrainCtx } from '../../shared/botBrain.ts';
import { BOT_LOADOUTS, pickBotWeapon } from '../../shared/botLoadouts.ts';
import { WEAPONS } from '../../shared/weaponTable.ts';
import { WEAPON_FIRE_INTERVAL_S } from '../../shared/weapons.ts';
import { HEAVY_ONLY_WEAPONS } from '../../shared/botClasses.ts';
import type { WeaponType } from '../../shared/weaponTable.ts';
import type { Vec3 } from '../../shared/protocol.ts';
import type { NetClient } from './netClient.ts';

const THINK_S = 0.3;
const POS_HZ = 10;
/** Client-side cruise speed — roughly a medium on skis. */
const CRUISE = 32;
/** Bots miss on purpose — a claim rate humans actually produce. */
const DIRECT_P = 0.55;
const BLAST_P = 0.25;

interface Shell {
  shotId: string;
  weaponType: number;
  targetId: string;
  /** Flight seconds — the claim's airtime value. */
  flightS: number;
  /** When the client-side flight should land. */
  impactAt: number;
  impactPos: Vec3;
  rolled: boolean;
}

export class NetBot {
  private brain: BotBrain;
  private loadout = BOT_LOADOUTS[Math.floor(Math.random() * BOT_LOADOUTS.length)] ?? BOT_LOADOUTS[0]!;
  private shells: Shell[] = [];
  private shotN = 0;
  private thinkTimer: ReturnType<typeof setInterval> | null = null;
  private lastFireAt = 0;
  private posTimer: ReturnType<typeof setInterval> | null = null;
  private claimTimer: ReturnType<typeof setInterval> | null = null;
  private hopTimer: ReturnType<typeof setInterval> | null = null;
  private rand: () => number;

  constructor(private nc: NetClient, opts: { hopEveryMs?: number; seed?: () => number } = {}) {
    this.brain = new BotBrain({ x: 0, y: 60, z: 0 });
    this.rand = opts.seed ?? Math.random;
    if (opts.hopEveryMs) {
      this.hopTimer = setInterval(() => {
        // Mid-match room hop — the seq-watermark bug class lives here.
        nc.send({ type: 'switchRoom', room: this.rand() < 0.5 ? 'netbot-a' : 'netbot-b', mode: 'dm' });
        nc.tel.hops++;
      }, opts.hopEveryMs);
    }
  }

  start(): void {
    this.thinkTimer = setInterval(() => this.think(), THINK_S * 1000);
    this.posTimer = setInterval(() => this.sendPos(), 1000 / POS_HZ);
    this.claimTimer = setInterval(() => this.settle(), 50);
  }

  stop(): void {
    for (const t of [this.thinkTimer, this.posTimer, this.claimTimer, this.hopTimer]) {
      if (t) clearInterval(t);
    }
  }

  private enemies(): BotEnemy[] {
    const out: BotEnemy[] = [];
    for (const [id, e] of this.nc.roster) {
      if (e.isDead) continue;
      if (this.nc.self.team && e.team === this.nc.self.team) continue;
      out.push({ id, pos: { x: e.pos.x, y: e.pos.y, z: e.pos.z }, vel: { x: e.vel.x, y: e.vel.y, z: e.vel.z }, alive: true });
    }
    return out;
  }

  private ctx(): BrainCtx {
    const nc = this.nc;
    return {
      pos: { x: nc.self.pos.x, y: nc.self.pos.y, z: nc.self.pos.z },
      vel: { x: nc.self.vel.x, y: nc.self.vel.y, z: nc.self.vel.z },
      enemies: this.enemies(),
      groundY: (_x, _z) => nc.self.pos.y, // flat-world approximation — combat is what matters here
      now: Date.now(),
      healthFrac: nc.self.health / 100,
      energy: 100,
      weaponSpeed: (dist) => WEAPONS[this.legalWeapon(dist)]?.speed ?? 60,
      weaponGravity: (dist) => WEAPONS[this.legalWeapon(dist)]?.gravity ?? false,
    };
  }

  /** The brain picks by range band, but a light-class bot can't claim
   *  heavy-tier ordnance — the server's class-lock gate would (rightly)
   *  reject it as a doctored-client claim. Fall back to the sidearm. */
  private legalWeapon(dist: number): number {
    const w = pickBotWeapon(this.loadout, dist, dist);
    return HEAVY_ONLY_WEAPONS.has(w) ? this.loadout.side : w;
  }

  private think(): void {
    const nc = this.nc;
    if (nc.self.isDead) return;
    const out = this.brain.think(THINK_S, this.ctx());

    // The brain's objective goals ignore enemies it can't see, and a
    // 8s test can't wait for spawns 250m apart to wander into LOS —
    // steer toward the nearest live enemy when the brain isn't firing.
    if (!out.fire) {
      let nearest: BotEnemy | null = null;
      let nd = Infinity;
      for (const e of this.ctx().enemies) {
        const d = Math.hypot(e.pos.x - nc.self.pos.x, e.pos.y - nc.self.pos.y, e.pos.z - nc.self.pos.z);
        if (d < nd) { nd = d; nearest = e; }
      }
      if (nearest && nd > 30) out.dest = { ...nearest.pos };
    }

    // Locomotion toward dest — client-side kinematics; the position channel
    // reports the result the way a v1 client does.
    const dx = out.dest.x - nc.self.pos.x;
    const dz = out.dest.z - nc.self.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.5) {
      const step = Math.min(CRUISE * THINK_S, d);
      nc.self.pos.x += (dx / d) * step;
      nc.self.pos.z += (dz / d) * step;
      nc.self.pos.y += (out.dest.y - nc.self.pos.y) * 0.2;
      nc.self.vel = { x: (dx / d) * CRUISE, y: 0, z: (dz / d) * CRUISE };
    } else {
      nc.self.vel = { x: 0, y: 0, z: 0 };
    }
    if (out.move?.jump) nc.send({ type: 'jump', position: { ...nc.self.pos } });
    if (out.move?.jet) nc.send({ type: 'jetpack', position: { ...nc.self.pos } });

    if (out.fire) this.fire(out.fire.targetId, out.fire.aim);
  }

  /** Spawn claim → the shell exists server-side; impact claims go out at
   *  flight time. Mirrors fire.ts sendShot + impact.ts claims. */
  private fire(targetId: string, aim: { x: number; y: number; z: number }): void {
    const nc = this.nc;
    const target = nc.roster.get(targetId);
    if (!target || target.isDead) return;
    const dist = Math.hypot(target.pos.x - nc.self.pos.x, target.pos.y - nc.self.pos.y, target.pos.z - nc.self.pos.z);
    // Long shots are unclaimable on jitter — a shell in the air >0.5s
    // leaves the target too much room to dodge past the legal radius
    // by the time the hit claim lands. Real fights close first anyway.
    if (dist > 45) return;
    // A kill landing mid-flight leaves the shell's hit claim bouncing
    // off a corpse — open fire only when the target has TTK headroom.
    if (target.health < 50) return;
    const weaponType = this.legalWeapon(dist);
    const w = WEAPONS[weaponType];
    if (!w || w.speed <= 0) return; // hitscan kinds — skip for now, beams need their own claim shape
    // The server enforces WEAPON_FIRE_INTERVAL_S per spawn claim — fire
    // slower than it and every spawn claim reads as spam.
    const interval = (WEAPON_FIRE_INTERVAL_S[weaponType as WeaponType] ?? 0.1) * 1000;
    if (Date.now() - this.lastFireAt < interval) return;
    this.lastFireAt = Date.now();

    const dir = {
      x: aim.x - nc.self.pos.x,
      y: aim.y - nc.self.pos.y,
      z: aim.z - nc.self.pos.z,
    };
    const dl = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const shotId = `${nc.id}-s${++this.shotN}`;
    nc.send({
      type: 'shot', targetId: null, weaponType,
      position: { x: nc.self.pos.x, y: nc.self.pos.y, z: nc.self.pos.z },
      velocity: { x: (dir.x / dl) * w.speed, y: (dir.y / dl) * w.speed, z: (dir.z / dl) * w.speed },
      shotId,
    });
    nc.tel.shots++;
    const flightS = dist / w.speed;
    // Lead the claim like a real client does — the shell lands where
    // the target will BE at impact, and the server validates that point
    // against the rewound position (a stale pos reads as a forged hit).
    this.shells.push({
      shotId, weaponType, targetId,
      flightS,
      impactAt: Date.now() + flightS * 1000,
      impactPos: {
        x: target.pos.x + target.vel.x * flightS,
        y: target.pos.y + target.vel.y * flightS,
        z: target.pos.z + target.vel.z * flightS,
      },
      rolled: false,
    });
  }

  /** Impact bookkeeping — when the client-side flight should have landed,
   *  emit the same claim pair impact.ts emits (direct `shot` + blast
   *  `aoeShot`), with honest misses interleaved. */
  private settle(): void {
    const nc = this.nc;
    const now = Date.now();
    this.shells = this.shells.filter((sh) => {
      if (now < sh.impactAt) return true;
      if (sh.rolled) return false;
      sh.rolled = true;
      const airtime = sh.flightS;
      const w = WEAPONS[sh.weaponType];
      const projId = nc.projectiles.get(sh.shotId);
      const roll = this.rand();
      const aoe = (w?.aoeRadius ?? 0) > 0;
      const target = nc.roster.get(sh.targetId);

      if (roll < DIRECT_P && target && !target.isDead) {
        // Direct claims need the target's position at claim-land time —
        // the server rewinds it by our ping. Our roster copy is up to a
        // tick stale plus the link latency, so a sprinting target is
        // already outside the ~1-3m legal radius no matter the lead:
        // honest players splash those, they only body-claim the slow
        // ones. Sprinting targets take the blast branch instead.
        const speed = Math.hypot(target.vel.x, target.vel.z);
        if (speed > 15) {
          if (aoe) {
            nc.send({
              type: 'aoeShot', position: { ...target.pos }, weaponType: sh.weaponType,
              projectileId: projId ?? null, shotId: sh.shotId, airtime,
            });
            nc.tel.claims++;
          } else if (projId) {
            // No splash to offer — a sprinting target is unclaimable,
            // so the shell just dies like a real whiffed shot.
            nc.send({ type: 'projectileDestroy', projectileId: projId, shotId: sh.shotId });
          }
          return false;
        }
        const leadS = nc.pingMs / 2000 + 0.05;
        const hitPos = {
          x: target.pos.x + target.vel.x * leadS,
          y: target.pos.y + target.vel.y * leadS,
          z: target.pos.z + target.vel.z * leadS,
        };
        nc.send({ type: 'shot', targetId: sh.targetId, weaponType: sh.weaponType, position: hitPos, projectileId: projId ?? null, shotId: sh.shotId, airtime });
        nc.tel.claims++;
        if (aoe) {
          nc.send({
            type: 'aoeShot', position: hitPos, weaponType: sh.weaponType,
            excludeTargetId: sh.targetId, projectileId: projId ?? null, shotId: sh.shotId,
            airtime, directHit: true,
          });
          nc.tel.claims++;
        }
      } else if (roll < DIRECT_P + BLAST_P && aoe) {
        // Blast-only: near miss that still splashes.
        nc.send({
          type: 'aoeShot', position: { ...sh.impactPos }, weaponType: sh.weaponType,
          projectileId: projId ?? null, shotId: sh.shotId, airtime,
        });
        nc.tel.claims++;
      } else if (projId) {
        // Clean miss — shell dies at terrain/fuse like a real shot.
        nc.send({ type: 'projectileDestroy', projectileId: projId, shotId: sh.shotId });
      }
      return false;
    });
  }

  private sendPos(): void {
    const nc = this.nc;
    if (nc.self.isDead) return;
    const yaw = Math.atan2(nc.self.vel.x, nc.self.vel.z);
    // Movement stays ordered (steady) — jitter lives on the claim channel,
    // matching how the real client keeps movement seq-gated.
    nc.send({ type: 'position', position: { ...nc.self.pos }, rotation: { yaw, pitch: 0 }, velocity: { ...nc.self.vel } }, true);
  }
}
