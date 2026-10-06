// Demo file validator — deserializes each .demo (CRC + count checks via the
// real reader), replays it through DemoPlayer's scrub/seek path, and
// enforces the lane invariants the format promises. Usage:
//   bun tools/demovalidate.ts demos_out/*.demo
// Exit 0 = all files valid; nonzero = at least one failed.

import { readFile, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { deserializeDemo } from '../client/src/demo/demoReader.ts';
import { DemoPlayer } from '../client/src/demo/DemoPlayer.ts';
import {
  TargetEventType, TARGETTYPE_CREATURE_BASE, TARGETTYPE_DEPLOY_BASE,
  TARGETTYPE_KILL, TARGETTYPE_FLAG, TARGETTYPE_PICKUP_BASE,
  ProjectileEventType,
} from '../client/src/demo/types.ts';
import type { DemoFile } from '../client/src/demo/types.ts';

const failures: string[] = [];
let checks = 0;
function fail(what: string): void { failures.push(what); }
function check(cond: boolean, what: string): void {
  checks++;
  if (!cond) fail(what);
}

function monotonic(frames: { timestamp: number }[]): boolean {
  for (let i = 1; i < frames.length; i++) {
    if (frames[i]!.timestamp < frames[i - 1]!.timestamp) return false;
  }
  return true;
}

function validateFile(path: string, file: DemoFile): void {
  const tag = `[${path}]`;

  // Stream ordering
  check(monotonic(file.frames), `${tag} frames not timestamp-ordered`);
  check(monotonic(file.remoteFrames), `${tag} remoteFrames not timestamp-ordered`);
  check(monotonic(file.projectileEvents), `${tag} projectileEvents not timestamp-ordered`);
  check(monotonic(file.targetEvents), `${tag} targetEvents not timestamp-ordered`);

  // Remote frames reference real roster entries
  for (const f of file.remoteFrames) {
    check(f.rosterIdx < file.roster.length, `${tag} remoteFrame rosterIdx ${f.rosterIdx} >= roster ${file.roster.length}`);
  }

  // Lane invariants on targetIds
  for (const e of file.targetEvents) {
    const tt = e.targetType;
    if (tt === TARGETTYPE_KILL) {
      check(e.targetId < file.roster.length, `${tag} kill marker targetId ${e.targetId} >= roster ${file.roster.length}`);
      check(e.eventType === TargetEventType.StateChanged, `${tag} kill marker not StateChanged (got ${e.eventType})`);
    } else if (tt === TARGETTYPE_FLAG) {
      check((e.targetId & 0xc000) === 0xc000, `${tag} flag targetId ${e.targetId} missing 0xc000 flag`);
    } else if (tt >= TARGETTYPE_PICKUP_BASE) {
      check((e.targetId & 0xe000) === 0xe000, `${tag} pickup targetId ${e.targetId} missing 0xe000 flag`);
    } else if (tt >= TARGETTYPE_DEPLOY_BASE) {
      check((e.targetId & 0x4000) === 0x4000, `${tag} deploy targetId ${e.targetId} missing 0x4000 flag`);
    } else if (tt >= TARGETTYPE_CREATURE_BASE) {
      check((e.targetId & 0x8000) === 0x8000, `${tag} creature targetId ${e.targetId} missing 0x8000 flag`);
    } else {
      check(e.targetId < 0x4000, `${tag} ball targetId ${e.targetId} collides with marker flag space`);
    }
  }

  // Projectile lifecycle: Fired must precede Bounce/Hit/Destroyed per id.
  const projSeen = new Set<number>();
  for (const e of file.projectileEvents) {
    if (e.eventType === ProjectileEventType.Fired) {
      projSeen.add(e.projectileId);
    } else {
      check(projSeen.has(e.projectileId), `${tag} projectile ${e.projectileId} has ${e.eventType} before any Fired`);
    }
    if (e.eventType === ProjectileEventType.Hit || e.eventType === ProjectileEventType.Destroyed) {
      projSeen.delete(e.projectileId);
    }
  }

  // Replay: scrub the whole file forward through the real DemoPlayer —
  // every event must be emitted exactly once, in order.
  const p = new DemoPlayer();
  p.load(file);
  let emittedTargets = 0;
  let emittedProjs = 0;
  let emittedRemotes = 0;
  p.setCallbacks({
    onFrameUpdate: (_s, evts) => {
      emittedProjs += evts.projectiles.length;
      emittedTargets += evts.targets.length;
      emittedRemotes += evts.remotes?.length ?? 0;
    },
  });
  const STEP = 1 / 30;
  for (let t = STEP; t < file.header.duration + STEP; t += STEP) p.scrubTo(t);
  check(emittedProjs === file.projectileEvents.length,
    `${tag} scrub emitted ${emittedProjs}/${file.projectileEvents.length} projectile events`);
  check(emittedTargets === file.targetEvents.length,
    `${tag} scrub emitted ${emittedTargets}/${file.targetEvents.length} target events`);
  check(emittedRemotes === file.remoteFrames.length,
    `${tag} scrub emitted ${emittedRemotes}/${file.remoteFrames.length} remote frames`);

  // Seek reconstruction to the middle must not throw and must place
  // interpolated remote states inside the roster.
  p.seek(file.header.duration / 2);
  const states = p.getRemoteStates();
  for (const s of states) {
    check(s.rosterIdx < file.roster.length, `${tag} seek remote rosterIdx ${s.rosterIdx} out of roster`);
    check(Number.isFinite(s.posX) && Number.isFinite(s.posY) && Number.isFinite(s.posZ),
      `${tag} seek produced NaN remote pose for roster ${s.rosterIdx}`);
  }
  const st = p.getInterpolatedState?.();
  void st;

  console.log(`  ${path}: ${file.frames.length} local + ${file.remoteFrames.length} remote frames, ` +
    `${file.projectileEvents.length} proj + ${file.targetEvents.length} target events, ` +
    `roster ${file.roster.length}, ${(file.header.duration).toFixed(1)}s`);
}

const inputs = process.argv.slice(2);
const paths: string[] = [];
for (const arg of inputs) {
  if (extname(arg) === '.demo') { paths.push(arg); }
  else {
    // treat as directory
    for (const f of await readdir(arg)) {
      if (f.endsWith('.demo')) paths.push(join(arg, f));
    }
  }
}
if (paths.length === 0) {
  console.log('usage: bun tools/demovalidate.ts <file.demo | dir> [...]');
  process.exit(2);
}

for (const path of paths) {
  try {
    const data = await readFile(path);
    const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const file = deserializeDemo(ab);
    validateFile(path, file);
  } catch (e) {
    fail(`[${path}] ${(e as Error).message}`);
  }
}

console.log(`\n${checks} checks, ${failures.length} failures`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
