// TARGETTYPE_MATCH round-trip — scoreboard/clock edges serialize and
// deserialize verbatim, and the sig dedupe doesn't double-write.
// democmp can't reach this lane (casual rooms carry no matchEndsAt), so
// the coverage lives here.
import { describe, it, expect } from 'vitest';
import { DemoRecorder } from '../demo/DemoRecorder.js';
import { serializeDemo } from '../demo/demoWriter.js';
import { deserializeDemo } from '../demo/demoReader.js';
import { buildDemoFile } from '../demo/demoExtract.js';
import { TARGETTYPE_MATCH } from '../demo/types.js';
import type { IPlayerDataProvider, IInputProvider } from '../demo/interfaces.js';

const mkPlayer = (): IPlayerDataProvider => ({
  posX: 0, posY: 0, posZ: 0, velX: 0, velY: 0, velZ: 0,
  yaw: 0, pitch: 0, weaponType: 0, health: 100, armor: 0,
});
const mkInput = (): IInputProvider => ({
  inputFlags: 0, mouseDeltaX: 0, mouseDeltaY: 0, jetpackFlags: 0, jetpackFuel: 0,
});

function rec(): DemoRecorder {
  const r = new DemoRecorder(60, 60);
  r.start(mkPlayer(), mkInput());
  return r;
}

describe('match-meta events', (): void => {
  it('record → serialize → deserialize preserves scores + remaining', (): void => {
    const r = rec();
    r.update(0.02);
    r.recordMatchMeta(3, 2, 580_000);
    const file = buildDemoFile(r, 'x');
    const buf = serializeDemo(file);
    const d = deserializeDemo(buf);
    const ev = d.targetEvents.find(e => e.targetType === TARGETTYPE_MATCH);
    expect(ev).toBeDefined();
    expect(ev!.peakPosX).toBe(3);
    expect(ev!.peakPosY).toBe(2);
    expect(ev!.health).toBe(580_000);
  });
  it('sig dedupe: same values = no second event, one value moves = writes', (): void => {
    const r = rec();
    r.update(0.02);
    r.recordMatchMeta(1, 1, 60_000);
    r.recordMatchMeta(1, 1, 60_000); // identical — deduped
    r.recordMatchMeta(2, 1, 59_000); // alpha moved — writes
    const n = r.targetEvents.filter(e => e.targetType === TARGETTYPE_MATCH).length;
    expect(n).toBe(2);
  });
});
