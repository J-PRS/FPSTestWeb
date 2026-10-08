import { describe, it, expect } from 'vitest';
import { NetworkManager } from '../networking/NetworkManager.js';

// Pins the desync-heal primitives the stateHash snapshot path relies on:
// seeding missing roster members, retiring stale ones, and liveness flips.
// A gap in any of these is a permanent "server but not client" warn.

const P = (x = 0, y = 0, z = 0) => ({ x, y, z });
const R = (yaw = 0, pitch = 0) => ({ yaw, pitch });
const V = (x = 0, y = 0, z =0) => ({ x, y, z });

function mk(): NetworkManager { return new NetworkManager(); }

describe('roster heal primitives', () => {
  it('upsertRemotePlayer seeds a member lost to a dropped join edge', () => {
    const nm = mk();
    expect(nm.remoteHas('p1')).toBe(false);
    nm.upsertRemotePlayer('p1', { position: P(1, 2, 3), health: 80, isDead: false });
    const e = nm.getPlayers().get('p1')!;
    expect(e.health).toBe(80);
    expect(e.position).toEqual(P(1, 2, 3));
    // Vec fields clone out of shared defaults — a second member must not
    // inherit p1's numbers through an aliased literal.
    nm.upsertRemotePlayer('p2', { health: 50 });
    // Fresh members default to y=500 sky-spawn until a position record lands.
    expect(nm.getPlayers().get('p2')!.position).toEqual(P(0, 500, 0));
  });

  it('never mints the local player, and partial patches preserve fields', () => {
    const nm = mk();
    // localPlayerId is unset until connect — a patch must still reject ''.
    nm.upsertRemotePlayer('', { health: 1 });
    expect(nm.getPlayers().size).toBe(0);
    nm.upsertRemotePlayer('p1', { health: 80, isDead: false });
    nm.upsertRemotePlayer('p1', { isDead: true }); // health must survive
    expect(nm.getPlayers().get('p1')!.health).toBe(80);
    expect(nm.getPlayers().get('p1')!.isDead).toBe(true);
  });

  it('patchRemotePlayer refuses to mint on one-off edges', () => {
    const nm = mk();
    expect(nm.patchRemotePlayer('ghost', { health: 10 })).toBe(false);
    expect(nm.remoteHas('ghost')).toBe(false);
    nm.upsertRemotePlayer('p1', { health: 80 });
    expect(nm.patchRemotePlayer('p1', { health: 30 })).toBe(true);
    expect(nm.getPlayers().get('p1')!.health).toBe(30);
  });

  it('healRemoteHealth heals existing members but never materializes phantoms', () => {
    const nm = mk();
    nm.healRemoteHealth('ghost', 10);
    expect(nm.remoteHas('ghost')).toBe(false);
    nm.upsertRemotePlayer('p1', { health: 80 });
    nm.healRemoteHealth('p1', 25);
    expect(nm.getPlayers().get('p1')!.health).toBe(25);
  });

  it('healRemoteLife flips liveness exactly once and reports direction', () => {
    const nm = mk();
    nm.upsertRemotePlayer('p1', { health: 100, isDead: false, position: P(5, 0, 5) });
    expect(nm.healRemoteLife('p1', true, 0, P(9, 1, 9))).toBe('killed');
    const e = nm.getPlayers().get('p1')!;
    expect(e.isDead).toBe(true);
    expect(e.position).toEqual(P(9, 1, 9)); // corpse pinned where server saw it die
    expect(nm.healRemoteLife('p1', true, 0)).toBeNull(); // no double-flip
    expect(nm.healRemoteLife('p1', false, 100, P(0, 0, 0))).toBe('revived');
    expect(nm.getPlayers().get('p1')!.isDead).toBe(false);
    expect(nm.getPlayers().get('p1')!.position).toEqual(P(0, 0, 0));
    expect(nm.healRemoteLife('ghost', true, 0)).toBeNull(); // no phantom
    expect(nm.remoteHas('ghost')).toBe(false);
  });

  it('remoteDelete retires a member the server no longer has', () => {
    const nm = mk();
    nm.upsertRemotePlayer('p1', { health: 80 });
    expect(nm.remoteHas('p1')).toBe(true);
    nm.remoteDelete('p1');
    expect(nm.remoteHas('p1')).toBe(false);
    nm.remoteDelete('p1'); // idempotent
    expect(nm.remoteHas('p1')).toBe(false);
  });
});
