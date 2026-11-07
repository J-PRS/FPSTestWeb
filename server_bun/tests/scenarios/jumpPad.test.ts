import { describe, expect, it } from 'bun:test';
import { mkRoom, pin, step } from './harness.ts';

describe('scenario: jump pad', () => {
  // Flat field: the pad's normal is up, so the launch is launchSpeed+lift
  // on vel.y. Silent until armS elapses - same arm convention as the mine.
  // groundY lifts buried claims to the drawn surface - read the resolved
  // seat back instead of trusting the claimed y.
  it('arms after ~1s then launches a body in the ring straight up', () => {
    const room = mkRoom({}, 'tdm');
    room.players.addPlayer('engi', 'alpha', 'none', 'medium');
    pin(room, 'engi', { x: 0, y: 30, z: 0 });
    room.players.getPlayer('engi')!.beltCharges = 10;
    expect(room.deployables.handleDeploy('engi', 'pad', { x: 5, y: 30, z: 0 })).toBe(true);
    const d = [...(room.deployables as unknown as { items: Map<number, { pos: { x: number; y: number; z: number } }> }).items.values()][0]!;
    room.players.addPlayer('runner', 'bravo', 'none', 'medium');
    room.moveSim.track('runner', { x: d.pos.x, y: d.pos.y + 0.5, z: d.pos.z }, 0, undefined, 'bravo');
    pin(room, 'runner', { x: d.pos.x, y: d.pos.y + 0.5, z: d.pos.z });
    step(room, 10); // 0.5s - inside the arm window, still quiet
    expect(room.moveSim.simState('runner')!.vel.y).toBeLessThan(20);
    step(room, 12); // past the arm - the discharge lands
    expect(room.moveSim.simState('runner')!.vel.y).toBeGreaterThan(20);
  });
});
