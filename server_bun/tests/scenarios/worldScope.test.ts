import { describe, it, expect } from 'bun:test';
import { mkRoom } from './harness.ts';

// world:'empty' modes (duel) must not pay for the ambient world — the
// 1v1 capacity audit measured a 2-seat room running a full CTF wildlife
// stack (encodeBallSegment alone was ~5% of a core). The sim objects
// still exist so stateHash lanes emit empty rosters, not undefined.
describe('scenario: world-scoped sims', () => {
  it('duel registers no ambient sims — move/proj/health/ping only', () => {
    const room = mkRoom({}, 'duel');
    const names = room.sims.map((s) => s.name);
    for (const gone of ['balls', 'crawl', 'pickups', 'deploy', 'influence']) {
      expect(names, `duel must not register '${gone}'`).not.toContain(gone);
    }
    for (const keep of ['bots', 'unbury', 'proj', 'move', 'health', 'ping']) {
      expect(names, `duel must keep '${keep}'`).toContain(keep);
    }
    expect(room.modeSpec?.world).toBe('empty');
  });

  it('dm keeps the ambient sims — the flag is opt-out, not default', () => {
    const room = mkRoom({}, 'dm');
    const names = room.sims.map((s) => s.name);
    for (const keep of ['balls', 'crawl', 'pickups', 'deploy', 'influence']) {
      expect(names, `dm must register '${keep}'`).toContain(keep);
    }
  });
});
