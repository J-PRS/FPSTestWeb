import { describe, it, expect } from 'bun:test';
import { mkRoom, step } from './harness.ts';
import { WORLD_MODEL, kindFields, declaredFieldNames, type WorldKindDecl } from '../../../shared/worldModel.ts';

// Producer-side conformance: a declared wire field with no `absent`
// marker must resolve on every live roster — kindFields() emits
// `absent ?? null` for a missing property, so a dropped producer
// (the dead-rttMs class: declared, decoded, then stranded between
// handler signature and consumer) ships silent nulls clients read as
// real values. This walks the same emit path TickLoop uses, on real
// roster objects, so a property that never gets written fails here
// instead of at the far end of a socket.
function laneErrors(kind: WorldKindDecl, roster: Iterable<{ id: number }>): string[] {
  const rows = kindFields(kind, roster);
  const required = kind.fields.filter((f) => f.absent === undefined);
  const errs: string[] = [];
  for (const row of rows) {
    for (let i = 0; i < required.length; i++) {
      // Slot i+1 — row[0] is the id. Required means "writer must fill
      // it"; null is only ever the absent-fallback for those.
      if (row[i + 1] == null) errs.push(`${kind.kind}#${row[0]}.${required[i]!.name}`);
    }
  }
  return errs;
}

describe('producer-side wire conformance', () => {
  const room = mkRoom({ creatures: { crawler: 3, rakk: 2 }, bots: 2 });
  step(room, 60);
  // Force one of each placeable so the deploy/pickup lanes have a live
  // producer to check — an empty roster pins nothing.
  room.deployables.seedBase([{ kind: 'sentry', pos: { x: 4, y: 0.5, z: 4 }, team: 'A' as never }]);
  room.pickups?.spawn({ x: 1, y: 0.5, z: 1 } as never, 'gem', 0);
  step(room, 5);

  const lanes: [WorldKindDecl, Iterable<{ id: number }>][] = [
    [WORLD_MODEL.ball!, room.ballSim.roster()],
    [WORLD_MODEL.creature!, room.creatureSim.roster()],
    [WORLD_MODEL.deploy!, room.deployables.snapshot()],
    [WORLD_MODEL.pickup!, room.pickups?.snapshot() ?? []],
  ];

  for (const [kind, roster] of lanes) {
    it(`every non-optional ${kind.kind} field has a live writer`, () => {
      const errs = laneErrors(kind, roster);
      expect(errs, `declared ${kind.kind} fields emit null — writer missing: ${errs.join(', ')}`).toEqual([]);
    });
  }

  it('every non-optional player wire field resolves on a live Player object', () => {
    // The player lane hand-packs tick records, not kindFields — the pin
    // is the property existing on the object those packers read, across
    // every declared slot (update ∪ spawn ∪ roster ∪ fields).
    const players = [...room.players.getAllPlayers().values()];
    expect(players.length).toBeGreaterThan(0);
    const names = declaredFieldNames(WORLD_MODEL.player!, 'fields', 'updateFields', 'spawnFields', 'rosterFields');
    const required = [
      ...(WORLD_MODEL.player!.fields ?? []),
      ...(WORLD_MODEL.player!.updateFields ?? []),
      ...(WORLD_MODEL.player!.spawnFields ?? []),
      ...(WORLD_MODEL.player!.rosterFields ?? []),
    ].filter((f) => f.absent === undefined);
    const errs: string[] = [];
    for (const p of players) {
      const r = p as unknown as Record<string, unknown>;
      for (const f of required) {
        if (!(f.name in r) || r[f.name] == null) errs.push(`${p.id ?? '?'}.${f.name}`);
      }
    }
    expect(errs, `declared player fields unresolved — writer missing: ${errs.join(', ')}`).toEqual([]);
    void names;
  });

  it('position rttMs reaches the shadow transit channel end-to-end', () => {
    // The dead-EMA regression pin: 'ping' is a declared optional field of
    // the position intent — the report delegate must forward it to
    // reconcile or the client transit channel sits at 0 and every led
    // mechanism silently disables. Calling the room's moveReport delegate
    // exercises the same arg list MessageHandler's decode result lands on.
    const room2 = mkRoom({ bots: 1 });
    step(room2, 10);
    const pid2 = [...room2.players.getAllPlayers().keys()][0]!;
    // Dispatch through the real handler surface — a stranded arg at ANY
    // hop (decode → handlePosition → moveReport → reconcile) zeros the
    // channel, which is where the original dead-EMA bug lived.
    room2.messages.moves.handlePosition(pid2, {
      type: 'position',
      position: { x: 0, y: 60, z: 0 },
      rotation: { yaw: 0, pitch: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      seq: 1, inputSeq: 1, ping: 120,
    });
    const ch = room2.moveSim.transitChannelsOf(pid2);
    expect(ch.client, 'rttMs stranded between handler and shadow — clientTransitEma never populated').toBeGreaterThan(0);
  });
});
