import { describe, it, expect, afterEach } from 'bun:test';
import { RoomFactory } from '../src/roomFactory.ts';
import type { Room } from '../src/Room.ts';
import type { MapSpec } from '../../shared/mapSpec.ts';

// Terrain cache eviction: loadField caches on `file@scale`, so a .bin
// re-baked under the same name survives reloadRoom forever unless
// invalidateField evicts it. The pin counts Bun.file reads — a second
// attachTerrain without eviction returns the cached promise (1 read);
// with it, the file is re-read (2).

const bunFile = (Bun as unknown as { file: (p: string) => { arrayBuffer(): Promise<ArrayBuffer> } }).file;
let reads = 0;

function stubHost() {
  const rooms = new Map<string, Room>();
  return {
    rooms,
    sessions: {},
    maps: {},
    field: () => null,
    recordEnd: () => {},
    kickPlayer: () => false,
    forgetRoom: () => {},
  } as unknown as ConstructorParameters<typeof RoomFactory>[0];
}

function stubRoom(name: string): Room {
  return {
    name,
    field: null,
    ballSim: { attachField: () => {} },
    moveSim: { attachField: () => {} },
    projectiles: { attachField: () => {} },
    refreshFlagHomes: () => {},
  } as unknown as Room;
}

async function waitField(room: { field: unknown }): Promise<void> {
  for (let i = 0; i < 100 && !room.field; i++) {await Bun.sleep(5);}
}

describe('roomFactory terrain cache', () => {
  afterEach(() => {
    (Bun as unknown as { file: typeof bunFile }).file = bunFile;
  });

  it('invalidateField forces a .bin re-read; without it the cache serves the stale field', async () => {
    reads = 0;
    (Bun as unknown as { file: typeof bunFile }).file = (p: string) => {reads++; return bunFile(p);};
    const host = stubHost();
    const factory = new RoomFactory(host);
    const room = stubRoom('r');
    host.rooms.set('r', room);
    const spec = { terrain: 'caldera.bin' } as MapSpec;

    factory.attachTerrain(room, spec);
    await waitField(room);
    expect(reads).toBe(1);
    const first = room.field;
    expect(first).not.toBeNull();

    // Same-name attach without eviction: cached promise, no re-read,
    // identical field object — this is the stale-terrain bug.
    factory.attachTerrain(room, spec);
    await Bun.sleep(10);
    expect(reads).toBe(1);
    expect(room.field).toBe(first);

    // Evicted: the reload path re-reads and re-attaches.
    factory.invalidateField('caldera.bin');
    factory.attachTerrain(room, spec);
    await Bun.sleep(10);
    await waitField(room);
    expect(reads).toBe(2);
  });
});
