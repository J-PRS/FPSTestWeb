import { describe, it, expect } from 'bun:test';
import { CombatHandler } from '../src/CombatHandler.ts';
import { PlayerManager } from '../src/PlayerManager.ts';
import { WeaponType } from '../../shared/weapons.ts';
import type { Vec3 } from '../src/types.ts';
import type { RoomEventSink } from '../src/roomEvents.ts';
import { wallNow } from '../src/wallClock.ts';

// Instant-attack origins are claim-driven: melee/LG/lance/repair send the
// eye point the shot left from, and the server trusts it only inside
// honest reach of the measured-uplink window (≤3m of a recorded body
// sample). Beyond that the origin clamps to history — no transit
// heuristic estimates where the shooter "probably" was.

function harness() {
  const players = new PlayerManager();
  const events: { type: string; pos?: Vec3 }[] = [];
  const sweeps: { origin: Vec3; range: number }[] = [];
  const emit: RoomEventSink = (e) => { if (e.type === 'meleeSweep') {events.push(e);} };
  const combat = new CombatHandler(players, () => {}, () => {}, {
    emit,
    beamSweep: (_id, muzzle, _dir, range) => { sweeps.push({ origin: muzzle, range }); return null; },
  });
  return { players, combat, events, sweeps };
}

const AT = { x: 0, y: 10, z: 0 };

describe('claim-driven instant origins', () => {
  it('melee sweep anchors at the claimed eye when it sits within honest reach', () => {
    const { players, combat, events } = harness();
    const p = players.addPlayer('p1');
    p.position = { ...AT };
    combat.handleShotFired('p1', {
      type: 'shotFired', weaponType: WeaponType.Melee,
      dir: { x: 0, y: 0, z: 1 },
      pos: { x: 1.5, y: 10, z: 0 }, // 1.5m off the body — honest muzzle
    });
    expect(events[0]?.pos).toEqual({ x: 1.5, y: 10, z: 0 });
  });

  it('a teleported claim clamps to the recorded body, not the lie', () => {
    const { players, combat, events } = harness();
    const p = players.addPlayer('p1');
    p.position = { ...AT };
    combat.handleShotFired('p1', {
      type: 'shotFired', weaponType: WeaponType.Melee,
      dir: { x: 0, y: 0, z: 1 },
      pos: { x: 100, y: 10, z: 0 },
    });
    expect(events[0]?.pos).toEqual(AT);
  });

  it('an LG tick sweeps from the claimed eye, not an estimated rewind', () => {
    const { players, combat, sweeps } = harness();
    const p = players.addPlayer('p1', undefined, 'none', 'light');
    p.position = { ...AT };
    combat.handleShotFired('p1', {
      type: 'shotFired', weaponType: WeaponType.Lightning,
      dir: { x: 0, y: 0, z: 1 },
      pos: { x: 2, y: 10.4, z: 0.8 },
    });
    expect(sweeps[0]?.origin).toEqual({ x: 2, y: 10.4, z: 0.8 });
  });

  it('a forged deep-past fireAt cannot rewind the origin past the measured path', () => {
    const { players, combat, events } = harness();
    const p = players.addPlayer('p1');
    p.position = { ...AT };
    const now = wallNow();
    // Journal: a fresh body sample, and a stale one 1.6s back 30m away.
    p.history.push(
      { t: (now - 1600) as never, x: 30, y: 10, z: 0, vx: 0, vy: 0, vz: 0 },
      { t: (now - 50) as never, x: AT.x, y: AT.y, z: AT.z, vx: 0, vy: 0, vz: 0 },
    );
    // The cheat: claim the shot fired 1.6s ago, at the spot we already
    // left — "peek, retreat, keep swinging from the exposed spot".
    combat.handleShotFired('p1', {
      type: 'shotFired', weaponType: WeaponType.Melee,
      dir: { x: 0, y: 0, z: 1 },
      pos: { x: 30, y: 10, z: 0 },
      fireAt: now - 1600,
    });
    // No transit deps → the bound is the join-grace floor (~400ms): the
    // 1.6s-old sample is outside the window, so the claimed 30m-away
    // spot can't anchor. The origin lands on the interpolated 400ms
    // body point — meters of drift, not the teleported swing.
    expect(events[0]?.pos?.x).toBeLessThan(6);
  });

  it('a claimless intent (bot/legacy) falls back to the body pos', () => {
    const { players, combat, events } = harness();
    const p = players.addPlayer('p1');
    p.position = { ...AT };
    combat.handleShotFired('p1', {
      type: 'shotFired', weaponType: WeaponType.Melee,
      dir: { x: 0, y: 0, z: 1 },
    });
    expect(events[0]?.pos).toEqual(AT);
  });
});
