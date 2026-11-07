import { describe, expect, it } from 'bun:test';
import { mkRoom, pin, step } from './harness.ts';

// Server-truth IFF: enemy markers exist only while the intel feed
// detects them - personal LOS (shared to the team at base linger) plus
// sensor-mast pings. The recon perk stretches ONLY the observer's own
// memory; teammates keep base linger.

const has = (room: ReturnType<typeof mkRoom>, viewer: string, target: string) =>
  room.intel.contactsFor(viewer).some((c) => c.id === target);

describe('scenario: intel IFF', () => {
  it('personal LOS detects a visible enemy and shares it with the team', () => {
    const room = mkRoom({}, 'tdm');
    room.players.addPlayer('spot', 'alpha', 'none', 'medium');
    room.players.addPlayer('mate', 'alpha', 'none', 'medium');
    room.players.addPlayer('foe', 'bravo', 'none', 'medium');
    pin(room, 'spot', { x: 0, y: 30, z: 0 });
    pin(room, 'mate', { x: 0, y: 30, z: 10 });
    pin(room, 'foe', { x: 0, y: 30, z: 50 });
    step(room, 30); // 1.5s - past the first 1s sweep
    expect(has(room, 'spot', 'foe')).toBe(true);
    expect(has(room, 'mate', 'foe')).toBe(true); // shared sighting
    expect(has(room, 'foe', 'spot')).toBe(true); // enemies see back
    expect(has(room, 'spot', 'mate')).toBe(false); // teammates never marked
  });

  it('a structure between sightline and target blocks detection', () => {
    const room = mkRoom({
      structures: [{ kind: 'box', pos: { x: 0, y: 20, z: 25 }, size: { x: 20, y: 30, z: 4 } }],
    }, 'tdm');
    room.players.addPlayer('spot', 'alpha', 'none', 'medium');
    room.players.addPlayer('foe', 'bravo', 'none', 'medium');
    pin(room, 'spot', { x: 0, y: 30, z: 0 });
    pin(room, 'foe', { x: 0, y: 30, z: 50 });
    step(room, 30);
    expect(has(room, 'spot', 'foe')).toBe(false);
  });

  it('recon perk lingers personal contacts 3x - teammates keep base', () => {
    const room = mkRoom({}, 'tdm');
    room.players.addPlayer('spot', 'alpha', 'recon', 'medium');
    room.players.addPlayer('mate', 'alpha', 'none', 'medium');
    room.players.addPlayer('foe', 'bravo', 'none', 'medium');
    pin(room, 'spot', { x: 0, y: 30, z: 0 });
    pin(room, 'mate', { x: 0, y: 30, z: 10 });
    pin(room, 'foe', { x: 0, y: 30, z: 50 });
    step(room, 30); // detected
    expect(has(room, 'spot', 'foe')).toBe(true);
    // Break sight for everyone - park the foe outside SIGHT_M.
    pin(room, 'foe', { x: 0, y: 30, z: 500 });
    step(room, 80); // 4s sim - base linger (4s) expiring around now
    // Mate's shared memory is gone; the recon spotter still holds his
    // own 12s window on a ghost marker.
    expect(has(room, 'mate', 'foe')).toBe(false);
    expect(has(room, 'spot', 'foe')).toBe(true);
    step(room, 160); // +8s - past even the recon window
    expect(has(room, 'spot', 'foe')).toBe(false);
  });
});
