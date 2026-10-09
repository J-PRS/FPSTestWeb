import { describe, it, expect } from 'bun:test';
import { replicaHash } from '../../../shared/stateHash.ts';
import { WORLD_MODEL } from '../../../shared/worldModel.ts';
import { mkRoom, pin, step } from './harness.ts';

// The flag lane's stateHash covers exactly what flagUpdate/gameState
// snapshot rows carry — 'unspawned' is server-internal and never crosses
// the wire. Hashing the raw flags map instead desyncs every pre-blood
// rabbit room forever: server lane says 1 row, client holds 0.
describe('flag lane hash covers wire-visible rows only', () => {
  it('pre-blood rabbit: server lane is empty like the client replica', () => {
    const room = mkRoom({ spawns: [{ x: 0, y: 0, z: 0 }] }, 'rabbit');
    expect(room.flags).not.toBeNull();
    // Rabbit's flag exists server-side before first blood — it just
    // isn't on the wire yet.
    expect(room.flags!.flags.size).toBe(1);
    expect([...room.flags!.flags.values()][0]!.state).toBe('unspawned');
    // The lane input TickLoop hashes — the same set snapshot() emits.
    const wireVisible = [...room.flags!.flags].filter(([, f]) => f.state !== 'unspawned') as unknown as [string | number, Record<string, unknown>][];
    expect(replicaHash(WORLD_MODEL.flag!, wireVisible))
      .toBe(replicaHash(WORLD_MODEL.flag!, [])); // == client's empty flagStates
    expect(room.flags!.snapshot()).toHaveLength(0);
  });

  it('first blood: the spawned flag joins the lane immediately', () => {
    const room = mkRoom({ spawns: [{ x: 0, y: 0, z: 0 }] }, 'rabbit');
    const a = room.players.addPlayer('a');
    const b = room.players.addPlayer('b');
    pin(room, a.id, { x: 0, y: 0, z: 0 });
    pin(room, b.id, { x: 5, y: 0, z: 5 });
    room.flags!.spawnAtCorpse(b.id);
    const wireVisible = [...room.flags!.flags].filter(([, f]) => f.state !== 'unspawned') as unknown as [string | number, Record<string, unknown>][];
    const lane = replicaHash(WORLD_MODEL.flag!, wireVisible);
    // Client view: flagUpdate rows → flagStates { team: {state, carrier} }.
    const clientView = new Map(room.flags!.snapshot().map((f) => [f.team, { state: f.state, carrier: f.carrier }]));
    const clientHash = replicaHash(WORLD_MODEL.flag!, clientView);
    expect(lane).toBe(clientHash);
    expect(clientView.get('alpha')?.state).toBe('dropped');
    step(room, 2);
  });
});
