/**
 * demodiffSelftest.ts — the oracle grades itself. Builds two minimal
 * synthetic demos (client clock + server clock offset by 10s, shared
 * moving seat so the fit can lock) and asserts demodiff's verdict:
 *
 *   match      → exit 0 (identical hit/kill events pair cleanly)
 *   missing    → exit 1 (server event the client never saw)
 *   fabricated → exit 1 (client hit the server never sent)
 *   tolerance  → exit 0 (0.3s skew pairs)
 *
 *   bun _tools/e2e/demodiffSelftest.ts
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { serializeDemo } from '../../client/src/demo/demoWriter.ts';
import { createHeader, TargetEventType, TARGETTYPE_KILL, type DemoFile, type TargetEvent, type RemoteFrame } from '../../client/src/demo/types.ts';

const BUN = process.env.BUN ?? 'C:/Users/JPrice/.bun/bin/bun.exe';
const OFF = 10; // server clock runs 10s ahead of client

const hitEv = (t: number, victim = 0, dmg = 14, shooter = 2): TargetEvent => ({
  eventType: TargetEventType.Hit, timestamp: t,
  posX: 10, posY: 40, posZ: 10, velX: 0, velY: 0, velZ: 0,
  targetId: victim, targetType: TARGETTYPE_KILL, health: dmg,
  hasPeakPosition: true, peakPosX: shooter, peakPosY: 0, peakPosZ: 0,
});
const killEv = (t: number, srvTape: boolean): TargetEvent => ({
  // Client writes kills StateChanged, server Destroyed — same edge.
  eventType: srvTape ? TargetEventType.Destroyed : TargetEventType.StateChanged, timestamp: t,
  posX: 12, posY: 40, posZ: 12, velX: 0, velY: 0, velZ: 0,
  targetId: 0, targetType: TARGETTYPE_KILL, health: 7,
  hasPeakPosition: true, peakPosX: 2, peakPosY: 0, peakPosZ: 0,
});

const mk = (shift: number, events: TargetEvent[]): DemoFile => {
  const header = createHeader();
  header.description = 'synthetic'; header.duration = 60; header.room = 'selftest';
  const remoteFrames: RemoteFrame[] = [];
  for (let i = 0; i < 400; i += 1) {
    remoteFrames.push({
      timestamp: i * 0.05 + shift, rosterIdx: 0,
      posX: Math.sin(i * 0.11) * 80, posY: 40, posZ: Math.cos(i * 0.07) * 80,
      velX: 1, velY: 0, velZ: 1, yaw: i * 0.01, pitch: 0, flags: 0,
    });
  }
  header.remoteFrameCount = remoteFrames.length;
  header.targetEventCount = events.length;
  return { header, frames: [], projectileEvents: [], targetEvents: events, roster: [{ name: 'V' }, { name: 'S' }], remoteFrames, snapshots: [] };
};

const run = (name: string, cli: DemoFile, srv: DemoFile, want: number): boolean => {
  writeFileSync('/tmp/dc_self_a.demo', Buffer.from(serializeDemo(cli)));
  writeFileSync('/tmp/dc_self_b.demo', Buffer.from(serializeDemo(srv)));
  const r = spawnSync(BUN, ['_tools/demodiff.ts', '/tmp/dc_self_a.demo', '/tmp/dc_self_b.demo'], { encoding: 'utf8' });
  const got = r.status ?? 1;
  const ok = (want === 0) === (got === 0);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: exit ${got} (want ${want})`);
  if (!ok) {console.log(r.stdout?.slice(-1200)); console.log(r.stderr?.slice(-400));}
  return ok;
};

let pass = true;
// match — identical hit+kill on both tapes
pass &&= run('match', mk(0, [hitEv(5), killEv(8, false)]), mk(OFF, [hitEv(15), killEv(18, true)]), 0);
// missing — server has an extra hit the client never saw
pass &&= run('missing', mk(0, [hitEv(5)]), mk(OFF, [hitEv(15), hitEv(30, 0, 22)]), 1);
// fabricated — client claims a hit the server never sent
pass &&= run('fabricated', mk(0, [hitEv(5), hitEv(20, 1, 9, 2)]), mk(OFF, [hitEv(15)]), 1);
// tolerance — 0.4s skew inside EV_TOL pairs
pass &&= run('tolerance', mk(0, [hitEv(5)]), mk(OFF, [hitEv(15.4)]), 0);
process.exit(pass ? 0 : 1);
