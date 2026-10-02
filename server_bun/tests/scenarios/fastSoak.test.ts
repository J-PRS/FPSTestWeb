import { describe, it, expect, afterAll } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkRoom, step, watch } from './harness.ts';
import { hmParseBin, hmHeight } from '../../../shared/heightfield.ts';
import { simNow, simNowAdvance, simNowReset } from '../../src/simClock.ts';

// FPS_TRAIL=<file.bmp> plots every bot's XZ track (alpha=red, bravo=
// blue) top-down over the 1500m terrain wrap at 512x512 — hotspots and
// dead routing lanes show instantly. Costs a position snapshot per
// batch, so it stays opt-in.
const TRAIL_PATH = process.env.FPS_TRAIL;

/** 24-bit uncompressed BMP — zero deps, opens everywhere. */
function bmpWrite(path: string, w: number, h: number, px: Uint8Array): void {
  const row = w * 3, pad = (4 - (row % 4)) % 4, size = (row + pad) * h;
  const b = Buffer.alloc(54 + size);
  b.write('BM'); b.writeUInt32LE(54 + size, 2); b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14); b.writeInt32LE(w, 18); b.writeInt32LE(h, 22);
  b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28); b.writeUInt32LE(size, 34);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 3, d = 54 + y * (row + pad) + x * 3;
      b[d] = px[s + 2]!; b[d + 1] = px[s + 1]!; b[d + 2] = px[s]!;
    }
  writeFileSync(path, b);
}

// Throughput probe: how much honest sim-time does a real CTF room burn
// through per wall-second when stepped flat-out? "Honest" means the
// whole room runs on the warp clock — respawns, spawn shields, flag and
// match timers all lapse in sim-time, not wall-time, so minutes of
// combat in seconds is actually minutes of combat.
const field = hmParseBin(new Uint8Array(readFileSync(`${import.meta.dir}/../../../maps/katabatic.bin`)));

// FPS_SOAK_MS=<ms> runs a longer warp from the CLI for profiling.
const WALL_BUDGET_MS = Number(process.env.FPS_SOAK_MS ?? 10_000);

describe('scenario: fast-forward soak throughput', () => {
  afterAll(() => simNowReset());

  it('steps a full 16-bot katabatic CTF room flat-out for 10 wall-s', () => {
    // Real T2 stand positions — a ctf room without bases spawns no
    // flags at all, and a flagless soak just measures wandering.
    const baseAt = (x: number, z: number) => ({ x, y: hmHeight(field, x, z), z });
    const spawnAt = (x: number, z: number, r: number, w: number) => ({ x, y: hmHeight(field, x, z), z, r, w });
    const room = mkRoom({
      mode: 'ctf', bots: 16, botFill: 16,
      bases: { alpha: baseAt(236.85, -127.11), bravo: baseAt(-423.57, 281.67) },
      // Real T2 spawn spheres from the katabatic map — without them the
      // room falls back to the center ring and both teams respawn
      // midfield, ~400m from the flags they're supposed to fight over.
      teamSpawns: {
        alpha: [spawnAt(239.42, -123.43, 73.24, 90), spawnAt(-188.62, -38.98, 54.93, 30)],
        bravo: [spawnAt(-422.19, 280.64, 73.24, 90), spawnAt(45.99, 210.2, 47.61, 30)],
      },
    }, 'ctf', 4242, false, field);
    // Sim-clock stamped watch — _s lets post-run stats time flag
    // transitions (grab→cap deltas) instead of counting blind.
    let simTicks = 0;
    const dt = 0.05;                      // 20Hz — matches the live tick
    const w = watch(room, () => simTicks * dt);
    expect(room.flags).not.toBeNull();

    const wallBudgetMs = WALL_BUDGET_MS;
    const runStart = simNow();
    const t0 = performance.now();
    const BATCH = 20; // sim-s granularity of stamped msgs — 100-tick
    // batches made 5s caps read as 0.0s in the match report.
    // Per-side stand pressure: closest any team's bot ever got to the
    // ENEMY stand — catches "one direction is unroutable" before the
    // grab count does (grab==0 can be a routing wall or no press).
    const alphaStand = { x: 236.85, z: -127.11 }, bravoStand = { x: -423.57, z: 281.67 };
    const press = { alpha: Infinity, bravo: Infinity };
    // Vertical gap at the closest XZ approach — pickup needs |dy|<=6,
    // so a press that stalls on a plateau rim shows up as press small
    // but pressY large (the bot is UNDER the stand lip, not on it).
    const pressY = { alpha: 0, bravo: 0 };
    const trail: { x: number; z: number; team: string; carrying: boolean }[] = [];
    const deaths: { x: number; z: number; team: string }[] = [];
    const wasDead = new Map<string, boolean>();
    while (performance.now() - t0 < wallBudgetMs) {
      // Advance the room's clock first, then step every sim — the
      // order mirrors a live tick (timers lapse, then sims move).
      simNowAdvance(dt * 1000 * BATCH);
      step(room, BATCH, dt);
      room.messages.respawnTick(simNow());
      simTicks += BATCH;
      for (const p of room.players.getAllPlayers().values()) {
        if (p.isDead) {
          // Corpses can't press or carry — but the kill spot still feeds
          // the death heatmap.
          if (TRAIL_PATH && p.team && !wasDead.get(p.id)) deaths.push({ x: p.position.x, z: p.position.z, team: p.team });
          wasDead.set(p.id, true);
          continue;
        }
        const standY = p.team === 'alpha' ? hmHeight(field, bravoStand.x, bravoStand.z) : hmHeight(field, alphaStand.x, alphaStand.z);
        if (p.team === 'alpha') {
          const d = Math.hypot(p.position.x - bravoStand.x, p.position.z - bravoStand.z);
          if (d < press.alpha) { press.alpha = d; pressY.alpha = p.position.y - standY; }
        } else if (p.team === 'bravo') {
          const d = Math.hypot(p.position.x - alphaStand.x, p.position.z - alphaStand.z);
          if (d < press.bravo) { press.bravo = d; pressY.bravo = p.position.y - standY; }
        }
        wasDead.set(p.id, false);
        if (TRAIL_PATH && p.team) {
          const carrying = [...room.flags!.flags.values()].some((f) => f.carrier === p.id);
          trail.push({ x: p.position.x, z: p.position.z, team: p.team, carrying });
        }
      }
    }
    const wallMs = performance.now() - t0;
    const simSecs = simTicks * dt;
    const ratio = simSecs / (wallMs / 1000);

    // ── Match report ──────────────────────────────────────────────
    // Caps come from flags.capLog — ground truth written at the capture
    // instant (broadcast-diffing can't tell a cap from an end-of-match
    // flag reset). Grabs still diff flagUpdate transitions: carried is
    // unambiguous state.
    type FlagSnap = { team: string; state: string; carrier: string | null; pos: { x: number; y: number; z: number } };
    const runBy = new Map<string, number>();
    const grabsBy: Record<string, number> = {};
    const pins: { x: number; z: number; kind: 'grab' | 'drop' | 'home' }[] = [];
    let grabs = 0;
    for (const m of w.msgs) {
      if (m.type !== 'flagUpdate') continue;
      for (const f of (m as unknown as { flags: FlagSnap[] }).flags ?? []) {
        if (f.state === 'carried' && !runBy.has(f.team)) {
          runBy.set(f.team, 1); grabs++;
          grabsBy[f.team] = (grabsBy[f.team] ?? 0) + 1;
          pins.push({ x: f.pos.x, z: f.pos.z, kind: 'grab' });
        } else if (f.state !== 'carried' && runBy.delete(f.team)) {
          pins.push({ x: f.pos.x, z: f.pos.z, kind: f.state === 'home' ? 'home' : 'drop' });
        }
      }
    }
    const caps = room.flags!.capLog.filter((c) => c.capAt >= runStart);

    if (TRAIL_PATH && trail.length) {
      const W = 512, HALF = 750; // terrain wrap is ±750m
      const px = new Uint8Array(W * W * 3);
      const ij = (x: number, z: number) => [
        Math.round((x + HALF) / (2 * HALF) * (W - 1)),
        Math.round((z + HALF) / (2 * HALF) * (W - 1)),
      ];
      const set = (ix: number, iy: number, r: number, g: number, b: number) => {
        if (ix < 0 || iy < 0 || ix >= W || iy >= W) return;
        const i = (iy * W + ix) * 3;
        px[i] = r; px[i + 1] = g; px[i + 2] = b;
      };
      const plot = (x: number, z: number, r: number, g: number, b: number) => set(ij(x, z)[0]!, ij(x, z)[1]!, r, g, b);
      // Terrain underlay: elevation → brightness, so dead zones read as
      // ridges/valleys and not unexplored void.
      let hMin = Infinity, hMax = -Infinity;
      const hAt: number[] = new Array(W * W);
      for (let iy = 0; iy < W; iy++)
        for (let ix = 0; ix < W; ix++) {
          const h = hmHeight(field, (ix / (W - 1)) * 2 * HALF - HALF, (iy / (W - 1)) * 2 * HALF - HALF);
          hAt[iy * W + ix] = h;
          if (h < hMin) hMin = h;
          if (h > hMax) hMax = h;
        }
      for (let i = 0; i < W * W; i++) {
        const v = 18 + 52 * ((hAt[i]! - hMin) / Math.max(1, hMax - hMin));
        px[i * 3] = v; px[i * 3 + 1] = v; px[i * 3 + 2] = v + 6;
      }
      // Deaths under trails: where bodies fall decides whether a dead
      // lane is a wall (deaths on the seam) or a killbox (deaths clustered).
      for (const d of deaths) {
        const [ix, iy] = ij(d.x, d.z);
        for (let dx = -1; dx <= 1; dx++)
          for (let dy = -1; dy <= 1; dy++)
            d.team === 'alpha' ? set(ix! + dx, iy! + dy, 140, 40, 30) : set(ix! + dx, iy! + dy, 40, 60, 140);
      }
      for (const t of trail) {
        // Carriers glow so flag routes cut through the team-color noise —
        // orange for alpha, purple for bravo.
        const [r, g, b] = t.carrying
          ? (t.team === 'alpha' ? [255, 160, 40] : [190, 80, 255])
          : (t.team === 'alpha' ? [255, 70, 70] : [90, 140, 255]);
        plot(t.x, t.z, r, g, b);
      }
      // Flag-event pins on top: lime grab, cyan drop/return-to-home.
      for (const pin of pins) {
        const [ix, iy] = ij(pin.x, pin.z);
        const c = pin.kind === 'grab' ? [120, 255, 60] : pin.kind === 'home' ? [255, 255, 120] : [60, 220, 255];
        for (let dx = -1; dx <= 1; dx++)
          for (let dy = -1; dy <= 1; dy++) set(ix! + dx, iy! + dy, c[0]!, c[1]!, c[2]!);
      }
      for (const s of [alphaStand, bravoStand]) {
        for (let dx = -3; dx <= 3; dx++)
          for (let dz = -3; dz <= 3; dz++) plot(s.x + dx * 3, s.z + dz * 3, 255, 255, 255);
      }
      bmpWrite(TRAIL_PATH, W, W, px);
      console.log(`  trail: ${trail.length} samples, ${deaths.length} deaths, ${pins.length} flag events → ${TRAIL_PATH}`);
    }

    const alive = [...room.players.getAllPlayers().values()].filter((p) => !p.isDead).length;
    const respawned = room.players.getAllPlayers().size;
    const fastest = caps.reduce((a, b) => (b.holdMs < a.holdMs ? b : a), { by: '-', holdMs: Infinity, team: '' });
    const avgHold = caps.length ? caps.reduce((n, c) => n + c.holdMs, 0) / caps.length / 1000 : 0;
    const players = room.scoring.matchPlayers();
    const fragger = [...players].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)[0];
    const kd = [...players].sort((a, b) => (b.kills / Math.max(1, b.deaths)) - (a.kills / Math.max(1, a.deaths)))[0];
    const kills = players.reduce((n, p) => n + p.kills, 0);
    const killsByTeam = players.reduce<Record<string, number>>((m, p) => { if (p.team) m[p.team] = (m[p.team] ?? 0) + p.kills; return m; }, {});
    const score = Object.entries(room.scores).map(([t, s]) => `${t} ${s}`).join(' / ');
    const fmtId = (id: string) => id.replace(/^BOT-/, '');
    console.log(
      `fastSoak: ${simTicks} ticks, ${simSecs.toFixed(0)} sim-s ` +
      `(${(simSecs / 60).toFixed(1)} sim-min) in ${(wallMs / 1000).toFixed(1)} wall-s ` +
      `— ${ratio.toFixed(0)}x real-time; ${alive}/${respawned} alive`,
    );
    // Per-role stat lines — tuning needs "do cappers cap" and "does the
    // bombardier kill the stand guards", not team totals. roleInfo is
    // the live assignment map the rebalance owns.
    const byRole = new Map<string, { n: number; k: number; d: number }>();
    for (const pl of players) {
      const role = room.bots?.roleOf(pl.id) ?? '-';
      const r = byRole.get(role) ?? { n: 0, k: 0, d: 0 };
      r.n++; r.k += pl.kills; r.d += pl.deaths;
      byRole.set(role, r);
    }
    const roleLine = [...byRole.entries()].sort().map(([r, s]) => `${r}:${s.n}x ${s.k}K/${s.d}D`).join('  ');
    // KPI: machine-readable single line for A/B diffing runs.
    console.log(
      `  kpi,score_alpha=${room.scores.alpha ?? 0},score_bravo=${room.scores.bravo ?? 0}` +
      `,kills_a=${killsByTeam.alpha ?? 0},kills_b=${killsByTeam.bravo ?? 0}` +
      `,press_a=${Number.isFinite(press.alpha) ? press.alpha.toFixed(1) : '-'},press_b=${Number.isFinite(press.bravo) ? press.bravo.toFixed(1) : '-'}` +
      `,grabs_a_flag=${grabsBy.alpha ?? 0},grabs_b_flag=${grabsBy.bravo ?? 0},caps=${caps.length}` +
      (caps.length ? `,fastest_s=${(fastest.holdMs / 1000).toFixed(1)}` : ''),
    );
    console.log(`  roles: ${roleLine}`);
    console.log(
      `  match: score ${score}; kills ${kills} (alpha ${killsByTeam.alpha ?? 0} / bravo ${killsByTeam.bravo ?? 0}); ` +
      `press ${Number.isFinite(press.alpha) ? press.alpha.toFixed(0) : '—'}m(dy${pressY.alpha >= 0 ? '+' : ''}${pressY.alpha.toFixed(0)})/${Number.isFinite(press.bravo) ? press.bravo.toFixed(0) : '—'}m(dy${pressY.bravo >= 0 ? '+' : ''}${pressY.bravo.toFixed(0)}); ` +
      `grabs ${grabs}${grabs ? ` (alpha flag ${grabsBy.alpha ?? 0} / bravo flag ${grabsBy.bravo ?? 0})` : ''} caps ${caps.length}` +
      (caps.length ? `, fastest cap ${(fastest.holdMs / 1000).toFixed(1)}s by ${fmtId(fastest.by)} (${fastest.team}), avg hold ${avgHold.toFixed(1)}s` : '') +
      (fragger ? `; top fragger ${fmtId(fragger.id)} ${fragger.kills}K/${fragger.deaths}D` : '') +
      (kd && kd.id !== fragger?.id ? `; best K/D ${fmtId(kd.id)} ${(kd.kills / Math.max(1, kd.deaths)).toFixed(1)}` : ''),
    );
    // The probe only works if the room genuinely simmed: a bot CTF room
    // at 20Hz should comfortably beat real-time, not crawl at 1x.
    expect(ratio).toBeGreaterThan(10);
    // Honesty check: after ~3h of sim a wall-clock-cheap room would be a
    // graveyard — respawns must have kept cycling (some alive now).
    expect(alive).toBeGreaterThan(0);
  }, WALL_BUDGET_MS + 30_000);
});
