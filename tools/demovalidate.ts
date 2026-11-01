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
  ProjectileEventType, HIT_TARGET_NONE,
} from '../client/src/demo/types.ts';
import type { DemoFile } from '../client/src/demo/types.ts';
import { demoTableHash } from '../client/src/demo/demoTables.ts';

const failures: string[] = [];
let checks = 0;
const warnings: string[] = [];
function warn(what: string): void { warnings.push(what); }
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

const REQUIRE = (() => {
  const i = process.argv.indexOf('--require');
  return i >= 0 ? (process.argv[i + 1] ?? '').split(',').filter(Boolean) : [];
})();

function validateFile(path: string, file: DemoFile): void {
  const tag = `[${path}]`;

  // Lane coverage — the "is anything not recorded?" ledger. targetType
  // buckets mirror FORMAT.md: 0-63 balls, 64-127 creatures, 128-223
  // deployables, 224 kill, 225 flag, 226+ pickups.
  const lanes: Record<string, number> = { ball: 0, creature: 0, deploy: 0, kill: 0, flag: 0, pickup: 0 };
  for (const e of file.targetEvents) {
    const tt = e.targetType;
    lanes[tt === TARGETTYPE_KILL ? 'kill' : tt === TARGETTYPE_FLAG ? 'flag'
      : tt >= TARGETTYPE_PICKUP_BASE ? 'pickup' : tt >= TARGETTYPE_DEPLOY_BASE ? 'deploy'
      : tt >= TARGETTYPE_CREATURE_BASE ? 'creature' : 'ball']!++;
  }
  let projFired = 0, projDone = 0;
  for (const e of file.projectileEvents) {
    if (e.eventType === ProjectileEventType.Fired) projFired++;
    if (e.eventType === ProjectileEventType.Hit || e.eventType === ProjectileEventType.Destroyed) projDone++;
  }
  console.log(`  lanes: ${Object.entries(lanes).map(([k, v]) => `${k}=${v}`).join(' ')} | proj fired=${projFired} done=${projDone}`);
  for (const lane of REQUIRE) {
    check((lanes[lane] ?? 0) > 0, `${tag} required lane '${lane}' produced ZERO events — recording or game coverage gap`);
  }

  // Stream ordering
  check(monotonic(file.frames), `${tag} frames not timestamp-ordered`);
  check(monotonic(file.remoteFrames), `${tag} remoteFrames not timestamp-ordered`);
  check(monotonic(file.projectileEvents), `${tag} projectileEvents not timestamp-ordered`);
  check(monotonic(file.targetEvents), `${tag} targetEvents not timestamp-ordered`);

  // Remote frames reference real roster entries
  for (const f of file.remoteFrames) {
    check(f.rosterIdx < file.roster.length, `${tag} remoteFrame rosterIdx ${f.rosterIdx} >= roster ${file.roster.length}`);
  }

  // v6 content-table fingerprint: the file's enum-index references were
  // minted against the tables of its build. A mismatch means species/
  // deploy/pickup/ball tables changed since — playback may remap, warn
  // loudly rather than silently (v5 and older carry no stamp).
  if (file.header.formatVersion >= 6) {
    check(file.header.tableHash !== 0, `${tag} v6 file has zero tableHash — recorder did not stamp`);
    if (file.header.tableHash !== 0 && file.header.tableHash !== demoTableHash()) {
      warn(`${tag} tableHash ${file.header.tableHash} != current ${demoTableHash()} — content tables changed since recording; species/kind indices may remap`);
    }
  }

  // Shot attribution: Fired targetId is shooter rosterIdx+1 (0 = local POV)
  for (const e of file.projectileEvents) {
    if (e.eventType === ProjectileEventType.Fired) {
      check(e.targetId <= file.roster.length, `${tag} Fired shooter ${e.targetId} > roster ${file.roster.length}`);
    }
    if (e.eventType === ProjectileEventType.Hit) {
      check(e.targetType === HIT_TARGET_NONE || e.targetType < TARGETTYPE_CREATURE_BASE,
        `${tag} Hit targetType ${e.targetType} outside ball/none lanes`);
    }
  }

  // Lane invariants on targetIds
  for (const e of file.targetEvents) {
    const tt = e.targetType;
    if (tt === TARGETTYPE_KILL) {
      check(e.targetId < file.roster.length, `${tag} kill marker targetId ${e.targetId} >= roster ${file.roster.length}`);
      // KILL lane carries two writers: recordKill → StateChanged (the kill
      // marker proper), recordPlayerHit → Hit (damage-credit echo the
      // demodiff pairs against server playerHit edges). Both are legal.
      check(e.eventType === TargetEventType.StateChanged || e.eventType === TargetEventType.Hit,
        `${tag} kill marker bad eventType ${e.eventType}`);
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
    `roster ${file.roster.length}, ${(file.header.duration).toFixed(1)}s` +
    `${file.heightmap ? `, hmap ${file.heightmap.gridN}²` : ', NO HMAP'}`);
}

const inputs = process.argv.slice(2).filter((a, i, arr) => a !== '--require' && arr[i - 1] !== '--require');
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

console.log(`\n${checks} checks, ${failures.length} failures, ${warnings.length} warnings`);
for (const f of failures) console.log(`  FAIL ${f}`);
for (const w of warnings) console.log(`  WARN ${w}`);
process.exit(failures.length === 0 ? 0 : 1);
