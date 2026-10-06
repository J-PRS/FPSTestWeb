import { describe, it, expect } from 'bun:test';
import { mkRoom, firstPlayer } from './harness.ts';
import { selfKillImpactDist, selfKillFoeDist } from '../../src/hitLedger.ts';

// The self-frag probes are module-global soak data — they must stay
// tail-capped or a long-lived room grows them forever.
describe('scenario: self-kill probes stay bounded', () => {
  it('probe arrays never exceed the cap under a self-frag flood', () => {
    const room = mkRoom({ bots: 1 });
    const p = firstPlayer(room);
    const combat = room.messages.combat;
    for (let i = 0; i < 300; i++) {
      combat.applyHit(p.id, p.id, 999, { killed: true, newHealth: 0, newArmor: 0 }, { label: 'test', extra: { dist: 3, pos: { x: 1, y: 2, z: 3 } } });
    }
    expect(selfKillImpactDist.length).toBe(256);
    expect(selfKillFoeDist.length).toBe(256);
  });
});
