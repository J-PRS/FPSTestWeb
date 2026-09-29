import { describe, it, expect } from 'bun:test';
import { mkRoom, watch, pin } from './harness.ts';

describe('scenario: carrier death drops the flag', () => {
  it('killing a carrier drops the flag where they died', () => {
    const room = mkRoom({
      mode: 'ctf', bots: 2,
      bases: { alpha: { x: -70, y: 60, z: 0 }, bravo: { x: 70, y: 60, z: 0 } },
    }, 'ctf');
    const w = watch(room);
    const carrier = [...room.players.getAllPlayers().values()].find((p) => p.team === 'alpha')!;
    const bravoFlag = room.flags!.flags.get('bravo')!;
    carrier.position = { ...bravoFlag.pos };
    room.tickFlags(0.05);
    expect(room.flags!.flags.get('bravo')!.carrier).toBe(carrier.id);
    // Die midfield — the drop lands at the corpse, not the stand. pin()
    // resyncs the shadow too; raw position writes get stomped by moveSim.
    pin(room, carrier.id, { x: 0, y: 31, z: 0 });
    room.players.applyDamage(carrier.id, 500);
    room.flagCarrierDied(carrier.id); // the funnel path CombatHandler calls
    room.tickFlags(0.05);
    const flag = room.flags!.flags.get('bravo')!;
    expect(flag.carrier).toBeNull();
    expect(flag.state).toBe('dropped');
    expect(flag.pos.x).toBeCloseTo(0, 1);
    expect(w.count('flagUpdate')).toBeGreaterThan(0);
  });
});
