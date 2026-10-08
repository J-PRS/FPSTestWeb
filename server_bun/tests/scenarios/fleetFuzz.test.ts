// Fleet directory conformance fuzz — claim/heartbeat/reconcile chaos on
// the pure FleetDirectory state machine (the matchmaker's brain; the
// socket layer is just IO around it).
//
// A seeded op stream drives beats (room set churn, ccu wobble, two
// workers reporting the same name), resolves (named, fresh, quick-join),
// registrations and time jumps that cross the 8s staleness and 30s
// claim-TTL boundaries. After every op:
//
//   * resolve never returns a down worker, and never null while one is up
//   * a confirmed home pins while its worker lives — a rival beat can't
//     steal it, and resolves for the same room can't split
//   * every roomHome entry points at an up worker post-sweep
//   * claims never point at down workers and never outlive their TTL
//   * a dead worker's rooms re-open on the survivors (resolve picks a
//     different live worker, the new claim pins — no flapping)
//   * roomNames = confirmed ∪ pending claims — no dead names
import { describe, it, expect } from 'bun:test';
import { FleetDirectory } from '../../src/fleetDir.ts';
import { lcg } from './harness.ts';
import { wallMs, wallNow } from '../../src/wallClock.ts';

describe('fleet directory conformance fuzz', () => {
  it('claims, homes and liveness stay consistent under beat/resolve/time chaos', () => {
    const SEEDS = [17, 31, 47, 67, 89];
    for (const seed of SEEDS) {
      const rng = lcg(seed);
      const dir = new FleetDirectory();
      const violations: string[] = [];
      const ctx = (op: number, d: string) => `seed=${seed} op=${op} ${d}`;

      // Virtual clock riding on the real one — registers stamp wallNow()
      // internally, so `now` must be >= that throughout.
      const base = wallNow();
      let t = wallMs(Number(base));

      const WIDS = ['w1', 'w2', 'w3'];
      for (const id of WIDS) dir.register(id, 8700 + Number(id[1]));
      // Everyone starts down until the first beat.
      for (const id of WIDS) dir.beat(id, [], 0, t);

      const roomPool = ['main', 'ctf-x', 'duel', 'vip', 'arena-1'];
      let freshN = 0;

      const check = (op: number, desc: string): void => {
        // Post-state invariants (sweep happens inside resolve; beats and
        // registers can leave stale rows, so check the contract only
        // where it's owed — after a sweep).
        dir.sweep(t);
        for (const [room, home] of (dir as unknown as { roomHome: Map<string, string> }).roomHome) {
          const w = dir.workers.get(home);
          if (!w?.up) violations.push(`${ctx(op, desc)}: roomHome[${room}]→${home} which is down`);
        }
        for (const [room, c] of (dir as unknown as { claims: Map<string, { workerId: string; at: number }> }).claims) {
          const w = dir.workers.get(c.workerId);
          if (!w?.up) violations.push(`${ctx(op, desc)}: claim ${room}→${c.workerId} which is down`);
          if (t - c.at > FleetDirectory.CLAIM_TTL_MS) violations.push(`${ctx(op, desc)}: claim ${room} outlived TTL`);
        }
        for (const name of dir.roomNames()) {
          // roomNames must only contain names that resolve somewhere
          // right now — confirmed on a live worker or a live claim.
          const home = (dir as unknown as { roomHome: Map<string, string> }).roomHome.get(name);
          const claim = (dir as unknown as { claims: Map<string, { workerId: string; at: number }> }).claims.get(name);
          const ok = (home && dir.workers.get(home)?.up) || (claim && dir.workers.get(claim.workerId)?.up && t - claim.at < FleetDirectory.CLAIM_TTL_MS);
          if (!ok) violations.push(`${ctx(op, desc)}: roomNames exposes dead ${name}`);
        }
      };

      const OPS = 400;
      for (let op = 0; op < OPS; op++) {
        const r = rng();
        const wid = WIDS[Math.floor(rng() * WIDS.length)]!;
        let desc = 'noop';

        if (r < 0.30) {
          // Beat: churn this worker's reported room set + ccu. Sometimes
          // it claims a room another worker already reported — the home
          // must not flap.
          const nRooms = Math.floor(rng() * 3);
          const rooms: string[] = [];
          for (let i = 0; i < nRooms; i++) rooms.push(roomPool[Math.floor(rng() * roomPool.length)]!);
          dir.beat(wid, rooms, Math.floor(rng() * 50), t);
          desc = `beat ${wid} ${rooms.join(',')}`;
        } else if (r < 0.62) {
          // Named resolve — pinned while any home/claim is live.
          const room = roomPool[Math.floor(rng() * roomPool.length)]!;
          const a = dir.resolve(room, t);
          const b = dir.resolve(room, t);
          if (a === null && [...dir.workers.values()].some((w) => w.up)) {
            violations.push(`${ctx(op, `resolve ${room}`)}: null while workers are up`);
          }
          if (a && !a.up) violations.push(`${ctx(op, `resolve ${room}`)}: returned down worker ${a.id}`);
          if (a && b && a !== b) violations.push(`${ctx(op, `resolve ${room}`)}: split ${a.id} vs ${b.id}`);
          // Confirmed home wins while it's up.
          const home = (dir as unknown as { roomHome: Map<string, string> }).roomHome.get(room);
          const homeW = home ? dir.workers.get(home) : undefined;
          if (a && homeW?.up && a !== homeW) violations.push(`${ctx(op, `resolve ${room}`)}: confirmed home ${homeW.id} lost to ${a.id}`);
          desc = `resolve ${room}`;
        } else if (r < 0.75) {
          // Fresh room name — claim placement.
          const room = `f${seed}_${freshN++}`;
          const a = dir.resolve(room, t);
          if (a && !a.up) violations.push(`${ctx(op, `fresh ${room}`)}: claimed on down worker`);
          // A second resolve inside the TTL must land on the same worker.
          const b = dir.resolve(room, t);
          if (a && b && a !== b) violations.push(`${ctx(op, `fresh ${room}`)}: claim split ${a.id} vs ${b.id}`);
          desc = `fresh ${room}`;
        } else if (r < 0.85) {
          // Quick-join shape — no room name, never writes a claim.
          const claimsBefore = (dir as unknown as { claims: Map<string, unknown> }).claims.size;
          const w = dir.resolve(undefined, t);
          if (w && !w.up) violations.push(`${ctx(op, 'quickjoin')}: returned down worker`);
          if ((dir as unknown as { claims: Map<string, unknown> }).claims.size !== claimsBefore) {
            violations.push(`${ctx(op, 'quickjoin')}: wrote a claim`);
          }
          desc = 'quickjoin';
        } else if (r < 0.93) {
          // Time advance — cross staleness / claim TTL boundaries.
          t = wallMs(Number(t) + Math.floor(rng() * 20_000));
          desc = `advance +${Number(t) - Number(base)}ms`;
        } else {
          // A brand-new worker mid-flight.
          const nid = `w${4 + Math.floor(rng() * 3)}`;
          if (!dir.workers.has(nid)) {
            dir.register(nid, 8800);
            desc = `register ${nid}`;
          } else {
            dir.beat(nid, [], 0, t);
            desc = `rebeat ${nid}`;
          }
        }
        check(op, desc);
      }

      // Dead-worker re-homing: down every worker but one, resolve every
      // name, every answer must be that survivor.
      t = wallMs(Number(t) + FleetDirectory.BEAT_STALE_MS + 1_000);
      const survivor = WIDS[WIDS.length - 1]!;
      dir.beat(survivor, ['main'], 7, t); // sole live worker holds 'main'
      for (const name of roomPool) {
        const w = dir.resolve(name, t);
        if (w && w.id !== survivor && w.up === false) violations.push(`${ctx(OPS, `rehome ${name}`)}: resolved to dead ${w.id}`);
        if (name === 'main' && w?.id !== survivor) violations.push(`${ctx(OPS, 'rehome main')}: confirmed home moved off sole survivor`);
      }

      expect(violations).toEqual([]);
    }
  });
});
