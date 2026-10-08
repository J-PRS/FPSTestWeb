import { describe, it, expect } from 'bun:test';
import { mkRoom, watch } from './harness.ts';
import type { MapSpec, StructureSpec } from '../../../shared/mapSpec.ts';
import type { Room } from '../../src/Room.ts';

// A team shield pane gates on its generator: kill the gen and the pane
// must vanish from EVERY sink RoomStructures feeds in the same call —
// the ball colliders, the skinny mapUpdate diff, and the join-time
// setMap echo. The extraction's whole point is those three can't drift
// apart; this pins it.
const SPEC: Partial<MapSpec> = {
  deploys: [{ kind: 'generator', pos: { x: -20, y: 0, z: 0 }, team: 'alpha' }],
  structures: [
    { kind: 'shield', pos: { x: 0, y: 0, z: 0 }, size: { x: 20, y: 80, z: 0.8 }, team: 'alpha' },
    { kind: 'block', pos: { x: 40, y: 0, z: 40 }, size: { x: 4, y: 4, z: 4 } },
  ],
};

const paneCount = (list: StructureSpec[] | undefined): number =>
  (list ?? []).filter((s) => s.kind === 'shield' && s.team === 'alpha').length;

const echoStructures = (room: Room): StructureSpec[] =>
  (room.messages as unknown as { roomInfo: { structures?: StructureSpec[] } }).roomInfo.structures ?? [];

describe('scenario: structure sinks stay in sync', () => {
  it('a dead generator drops its shield from colliders, mapUpdate, and the join echo together', () => {
    const room = mkRoom(SPEC, 'ctf', 11);
    const w = watch(room);
    // Powered gate: the pane collides and echoes at boot.
    expect(room.ballSim.colliders.filter((c) => c.passTeam === 'alpha').length).toBe(1);
    expect(paneCount(echoStructures(room))).toBe(1);

    const gen = [...room.deployables.items.values()].find((d) => d.kind === 'generator')!;
    room.deployables.applyBlast(gen.pos, 1000, 10, 'raider');
    expect(gen.hp).toBeLessThanOrEqual(0);

    // Colliders: the pane is gone.
    expect(room.ballSim.colliders.filter((c) => c.passTeam === 'alpha').length).toBe(0);
    // Wire: exactly one skinny mapUpdate, carrying the same pane-free set.
    const ups = w.msgs.filter((m) => m.type === 'mapUpdate');
    expect(ups.length).toBe(1);
    expect(paneCount((ups[0] as { structures?: StructureSpec[] }).structures)).toBe(0);
    // Join echo: a reconnecting client gets the same list the diff shipped.
    expect(paneCount(echoStructures(room))).toBe(0);

    // A second power refresh is a silent no-op — no diff spam.
    room.refreshPowerStructures();
    expect(w.count('mapUpdate')).toBe(1);
  });

  it('a team with no generator keeps its pane through any refresh', () => {
    const spec: Partial<MapSpec> = {
      structures: [
        { kind: 'shield', pos: { x: 0, y: 0, z: 0 }, size: { x: 20, y: 80, z: 0.8 }, team: 'alpha' },
      ],
    };
    const room = mkRoom(spec, 'ctf', 12);
    // The first refresh legitimately diffs: seatKits grounds the authored
    // pos.y on live terrain, so the emitted pane differs from the boot
    // baseline. Settle that, then the no-op must go silent.
    room.refreshPowerStructures();
    const w = watch(room);
    room.refreshPowerStructures();
    expect(room.ballSim.colliders.filter((c) => c.passTeam === 'alpha').length).toBe(1);
    expect(w.count('mapUpdate')).toBe(0);
  });
});
