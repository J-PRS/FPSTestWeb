import { describe, it, expect } from 'bun:test';
import { beamSweepRay } from '../src/beamSweep.ts';
import { PlayerManager } from '../src/PlayerManager.ts';

/** Teammates must not body-block the ray: the friendly-damage gate
 *  already refuses harm, so a friendly capsule eating the beam just
 *  swallows the shot. includeTeammates is the heal-beam opt-out -
 *  the patient IS the target there. */

function world() {
  const players = new PlayerManager();
  const shooter = players.addPlayer('shooter', 'alpha');
  shooter.position = { x: 0, y: 10, z: 0 };
  const mate = players.addPlayer('mate', 'alpha');
  mate.position = { x: 0, y: 10, z: -3 };
  const enemy = players.addPlayer('enemy', 'bravo');
  enemy.position = { x: 0, y: 10, z: -6 };
  return {
    players, field: null, solids: [],
  };
}

const downZ = { x: 0, y: 0, z: -1 };

describe('beamSweep friendly bodies', () => {
  it('a teammate does not intercept the ray - the enemy behind is the contact', () => {
    const c = beamSweepRay(world(), 'shooter', { x: 0, y: 10, z: 0 }, downZ, 30);
    expect(c?.playerId).toBe('enemy');
  });

  it('includeTeammates restores friendly contact (heal beam)', () => {
    const c = beamSweepRay(world(), 'shooter', { x: 0, y: 10, z: 0 }, downZ, 30, true);
    expect(c?.playerId).toBe('mate');
  });
});
