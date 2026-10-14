// Solo-run dice parity — the server-side gate for challenge-seeded
// submissions. Replays the runSeed-keyed spawn stream and requires every
// recorded Spawned event to land on its expected draw — the same check
// _tools/verify.ts runs offline, ported here so a solo submission can't
// just carry a minted seed while fabricating the events the seed implies.
//
// Draw contract (mirrors client entities.ts/balls.ts):
//   field init      : one timer draw
//   boot fill ×4    : [variant?] + ctor draws        (no timer)
//   ambient trickle : [timer] + [variant?] + ctor draws
//   split child     : ctor draws + split-vel draw     (pos inherits parent)
// Variant draws only exist when the pool saw a non-0 variant — the mode
// string lies, the data doesn't.

import { lcg32 } from '../../shared/simRand.ts';
import { drawBallSpawn, drawSplitVel, drawVariant, SPAWN_SEED_XOR } from '../../shared/spawnDice.ts';
import { TargetEventType, type DemoFile } from '../../client/src/demo/types.ts';

const BALL_COLOR_COUNT = 7;
const EPS = 2.5;

export interface SoloVerdict {
  ok: boolean;
  spawnBad: number;
  spawnN: number;
  worst: number;
  worstId: number;
  reason?: string;
}

export function verifySolo(demo: DemoFile): SoloVerdict {
  const h = demo.header;
  if (!h.runSeed) { return { ok: false, spawnBad: 0, spawnN: 0, worst: 0, worstId: -1, reason: 'unseeded demo (v<7 or unseeded run)' }; }
  if (!demo.heightmap) { return { ok: false, spawnBad: 0, spawnN: 0, worst: 0, worstId: -1, reason: 'no hmap trailer' }; }
  if (demo.frames.length === 0) { return { ok: false, spawnBad: 0, spawnN: 0, worst: 0, worstId: -1, reason: 'no frames' }; }


  // Track the recorded player through its frames so spawn rings anchor
  // to the same position the dice implied — replay-free approximation:
  // the recorded frames ARE the truth here (trajectory forgery is the
  // audit tier's job), the dice check only needs position-at-time.
  const playerPosAt = (t: number): { x: number; y: number; z: number } => {
    let last = demo.frames[0];
    for (const f of demo.frames) {
      if (f.timestamp > t) { break; }
      last = f;
    }
    return { x: last!.posX, y: last!.posY, z: last!.posZ };
  };

  const ambientSpawns = demo.targetEvents.filter(e => e.targetType < 64 && e.eventType === TargetEventType.Spawned);
  const hasVariants = ambientSpawns.some(e => e.targetType !== 0);
  const stream = lcg32((h.runSeed ^ SPAWN_SEED_XOR) >>> 0);
  stream(); // field-init timer draw

  const livePos = new Map<number, { x: number; y: number; z: number }>();
  let spawnN = 0, spawnBad = 0, worst = 0, worstId = -1, ambientIdx = 0;

  for (const e of demo.targetEvents) {
    if (e.targetType >= 64) { continue; }
    if (e.eventType === TargetEventType.Destroyed) { livePos.delete(e.targetId); continue; }
    if (e.eventType === TargetEventType.Spawned) {
      let isSplit = false;
      for (const p of livePos.values()) {
        if (Math.hypot(p.x - e.posX, p.y - e.posY, p.z - e.posZ) < 2) { isSplit = true; break; }
      }
      const variant = e.targetType as 0 | 1 | 2 | 3;
      if (!isSplit) {
        if (ambientIdx >= 4) { stream(); } // trickle timer
        if (hasVariants) { drawVariant(stream); }
        ambientIdx += 1;
      }
      const draw = drawBallSpawn(stream, variant, BALL_COLOR_COUNT);
      let ex: number, ez: number;
      let evx: number, evy: number, evz: number;
      if (isSplit) {
        const sv = drawSplitVel(stream);
        ex = e.posX; ez = e.posZ;
        evx = sv.x; evy = sv.y; evz = sv.z;
      } else {
        const p = playerPosAt(e.timestamp);
        ex = p.x + draw.offX; ez = p.z + draw.offZ;
        evx = draw.vel.x; evy = draw.vel.y; evz = draw.vel.z;
      }
      const err = Math.max(
        Math.hypot(ex - e.posX, ez - e.posZ),
        Math.hypot(evx - e.velX, evy - e.velY, evz - e.velZ));
      spawnN += 1;
      if (err > EPS) { spawnBad += 1; }
      if (err > worst) { worst = err; worstId = e.targetId; }
    }
    livePos.set(e.targetId, { x: e.posX, y: e.posY, z: e.posZ });
  }

  return {
    ok: spawnBad === 0,
    spawnBad, spawnN, worst, worstId,
    reason: spawnBad > 0 ? `spawn dice diverged at ball ${worstId} (${worst.toFixed(2)}m)` : undefined,
  };
}
