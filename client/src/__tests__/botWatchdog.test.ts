import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { BotWatchdog } from '../game/botWatchdog.js';
import type { GameBot } from '../game/botBrain.js';

const mkBot = (id: string, pos: THREE.Vector3, modelPos = pos) => ({
  playerId: id,
  position: pos,
  isDead: false,
  model: { getModelPosition: (out: THREE.Vector3) => { out.copy(modelPos); return true; } } as unknown as GameBot['model'],
});

const mkWd = (matchOver = () => false) => {
  const log = { warn: vi.fn(), info: vi.fn() };
  return { wd: new BotWatchdog(log, matchOver), log };
};

// The watchdog samples every 4s (WD_DT) and judges net travel over 10s
// windows (WD_STUCK_T/WD_STUCK_D). step() is fed dt slices like the loop.
const stepN = (wd: BotWatchdog, bots: any[], seconds: number) => {
  for (let i = 0; i < seconds; i++) {wd.step(1, bots);}
};

describe('BotWatchdog', () => {
  it('warns on net displacement under the stuck threshold, once per episode', () => {
    const { wd, log } = mkWd();
    const b = mkBot('b1', new THREE.Vector3());
    stepN(wd, [b], 17); // ~16s in place → first window closes
    expect(log.warn).toHaveBeenCalledTimes(1);
    stepN(wd, [b], 13); // second all-stuck window escalates to the squad verdict
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenLastCalledWith(expect.stringContaining('pinned'));
  });

  it('re-arms after the bot recovers', () => {
    const { wd, log } = mkWd();
    const p = new THREE.Vector3();
    const b = mkBot('b1', p);
    stepN(wd, [b], 17);
    expect(log.warn).toHaveBeenCalledTimes(1);
    p.x = 50; // travel far before the next window closes
    stepN(wd, [b], 13);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('unstuck'));
    p.x = 55; // park again (5m < the 10m threshold) → a fresh stuck episode warns again
    stepN(wd, [b], 13);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('jiggling in place still counts as stuck (net travel, not motion)', () => {
    const { wd, log } = mkWd();
    const p = new THREE.Vector3();
    const b = mkBot('b1', p);
    // Pace back and forth 3m — plenty of per-sample motion, no net travel.
    for (let s = 0; s < 17; s++) {
      p.x = s % 2 ? 3 : 0;
      wd.step(1, [b]);
    }
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('match-over stillness is not a failure', () => {
    const { wd, log } = mkWd(() => true);
    const b = mkBot('b1', new THREE.Vector3());
    stepN(wd, [b], 17);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('render stall: logic moves, model frozen → one warn, then recover', () => {
    const { wd, log } = mkWd();
    const logic = new THREE.Vector3();
    const modelPos = new THREE.Vector3(); // never moves
    const b = mkBot('b1', logic, modelPos);
    wd.step(4, [b]); // first sample: primes both legs
    logic.x = 5;
    wd.step(4, [b]); // logic moved 5, model 0 → render stall
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('render stalled'));
    modelPos.x = 5; // model catches up
    logic.x = 5.1;
    wd.step(4, [b]);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('render recovered'));
  });

  it('whole-squad freeze needs two consecutive all-stuck windows', () => {
    const { wd, log } = mkWd();
    const bots = [mkBot('a', new THREE.Vector3()), mkBot('b', new THREE.Vector3(10, 0, 0))];
    stepN(wd, bots, 17); // first all-stuck window — individual warns only
    expect(log.warn).toHaveBeenCalledTimes(2);
    stepN(wd, bots, 13); // second consecutive all-stuck → squad alarm
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('pinned'));
  });
});
