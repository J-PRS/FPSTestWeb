import { describe, it, expect } from 'bun:test';
import { mkRoom, step, freeze } from './harness.ts';

// Buzzard = the ambient kettle promoted to a real creature: map
// `creatures` pops mint it through the shared fly-family sim, and a hit
// lands a 6s grudge — the buzzard turns on its SHOOTER, not the nearest
// bystander (creatureBrain.noteHit). This pins both halves.
describe('scenario: buzzard', () => {
  it('pops spawn and a shot buzzard holds a grudge on the shooter', () => {
    const room = mkRoom({ bots: 2, creatures: { buzzard: 2 } });
    const bots = [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
    freeze(room, bots[0]!.id, { x: 0, y: 31, z: 0 });
    freeze(room, bots[1]!.id, { x: 200, y: 31, z: 200 });

    step(room, 60); // ~3s - pops mint one per tick until cap
    const sim = room.creatureSim as unknown as { crawlers: Map<number, { id: number; species: string; targetId: string | null }> };
    const buzz = [...sim.crawlers.values()].filter((c) => c.species === 'buzzard');
    expect(buzz.length).toBeGreaterThan(0);

    const c = buzz[0]!;
    const before = c.targetId;
    // Shooter is whichever bot is FARTHER from the bird's likely spawn —
    // the grudge must override nearest-player selection either way.
    const shooter = bots[1]!;
    room.creatureSim.handleHit(shooter.id, c.id, 10);
    step(room, 3); // noteHit forces the retarget on the next brain tick
    expect(c.targetId).toBe(shooter.id);
    expect(c.targetId).not.toBe(before === shooter.id ? bots[0]!.id : before);
  });
});
