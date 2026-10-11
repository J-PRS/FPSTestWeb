import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { makeRubberbandWatch } from '../game/netBalls.js';
import type { Ball } from '../entities/balls.js';

// netDiag fields the watch reads — a fake Ball carries just the diagnostics
// surface; check() never touches mesh/sim beyond netS.sim (null = replay
// sim not bound, so predictAt declines and truthAt takes the ballistic path).
function fakeBall(over: { simT: number; legAge?: number; parked?: boolean }): Ball {
  return {
    pos: new THREE.Vector3(0, 5, 0),
    radius: 0.5,
    netS: { sim: null },
    netDiag: {
      simT: over.simT,
      simNow: 10.4,
      legT0: over.simT,
      legAge: over.legAge ?? 0.5,
      enraged: false,
      tgtValid: false,
      parked: over.parked ?? false,
      anchor: { x: 0, y: 5, z: 0, vx: 0, vy: 0, vz: 0 },
    },
  } as unknown as Ball;
}

const SEG = {
  id: 7,
  kind: 'segment',
  position: { x: 40, y: 3, z: 40 }, // far from fakeBall.pos → err >> warnAt
  velocity: { x: 20, y: 0, z: 20 },
  enraged: false,
  targetId: null,
};

function rig() {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps = {
    lazyTerrain: (): { getHeight: () => number; } => ({ getHeight: (): number => 0 }),
    lazyPlayer: (): { pos: THREE.Vector3; } => ({ pos: new THREE.Vector3() }),
    lazyDemoManager: (): null => null,
    lazyNetworkManager: (): null => null,
  };
  const watch = makeRubberbandWatch(
    deps as never,
    (): number => 0.4,   // ballEventAge
    (): number => 10.4,  // estSimNow
    logger as never,
  );
  return { watch, logger };
}

describe('rubberband watch — unreplayed-stamp gate', (): void => {
  it('suppresses warn when the sim never replayed through the stamp', (): void => {
    const { watch, logger } = rig();
    // simT 9.0 < t 10.0 - 0.05: the cursor sits on a just-re-anchored leg —
    // err measures event spacing, not divergence. The a3a77034 fix.
    watch.check(fakeBall({ simT: 9 }), Object.assign({}, SEG, {t: 10}));
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('unreplayed stamp'));
  });

  it('still warns when the sim DID replay through the stamp and diverged', (): void => {
    const { watch, logger } = rig();
    // simT 10.4 > t 10.0 - 0.05: sim ran through the stamp and still sits
    // far off truth — a real desync worth the full warn + forensics.
    watch.check(fakeBall({ simT: 10.4 }), Object.assign({}, SEG, {t: 10}));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toContain('rubberband');
  });

  it('suppresses warn on a parked leg regardless of replay state', (): void => {
    const { watch, logger } = rig();
    watch.check(fakeBall({ simT: 10.4, parked: true }), Object.assign({}, SEG, {t: 10}));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('suppresses warn on a stale leg (legAge > 3)', (): void => {
    const { watch, logger } = rig();
    watch.check(fakeBall({ simT: 10.4, legAge: 5 }), Object.assign({}, SEG, {t: 10}));
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
