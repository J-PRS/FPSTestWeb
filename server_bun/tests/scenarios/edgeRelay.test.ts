import { describe, expect, it } from 'bun:test';
import { mkRoom, pin } from './harness.ts';
import { decodeRemoteInput, WIRE_E_INPUT } from '../../../shared/wire.ts';

// C4 remote replay: a consumed inputMove edge relays to observers on
// the volatile lane so their per-remote MoveSim replays the shadow's
// input timeline. The sender never gets its own edge back, a seq-gated
// (stale) edge doesn't relay, and the frame decodes cleanly.

describe('remote input edge relay', () => {
  it('a consumed edge fans out to observers, not the sender', () => {
    const room = mkRoom({}, 'dm');
    room.players.addPlayer('p1', 'alpha', 'none', 'medium');
    room.players.addPlayer('p2', 'bravo', 'none', 'medium');
    pin(room, 'p1', { x: 0, y: 1, z: 0 });
    room.wireIds.set('p1', 1);
    room.wireIds.set('p2', 2);
    const sent: { to: string; data: Uint8Array }[] = [];
    room.connections.sendBinToPlayerReliable = (pid: string, data: Uint8Array): void => {
      sent.push({ to: pid, data });
    };
    room.moveSim.track('p1', { x: 0, y: 1, z: 0 }, 0);
    // Drive through the same host callback the wire uses.
    type HostInfo = { moveInput?: (pid: string, i: { forward: number; right: number; jump: number; ski: number; jet?: number }, status?: number, seq?: number, ageMs?: number) => boolean };
    const hi = (room as unknown as { handlerInfo(): HostInfo }).handlerInfo();
    const ok = hi.moveInput?.('p1', { forward: 1, right: 0, jump: 0, ski: 0 }, 0, 7, 20);
    expect(ok).toBe(true);
    const relay = sent.filter((s) => s.data[1] === WIRE_E_INPUT);
    expect(relay.length).toBe(1);
    expect(relay[0]!.to).toBe('p2'); // observer gets it, sender excluded
    const d = decodeRemoteInput(relay[0]!.data);
    expect(d?.wid).toBe(room.wireIds.get('p1'));
    expect(d?.seq).toBe(7);
    expect(d?.input.forward).toBe(1);
    expect(d?.ageMs).toBe(20);
  });

  it('engagement tracks who shot whom and expires stale pairs', () => {
    const room = mkRoom({}, 'dm');
    room.players.addPlayer('p1', 'alpha', 'none', 'medium');
    room.players.addPlayer('p2', 'bravo', 'none', 'medium');
    room.noteEngagement('p1', 'p2');
    room.noteEngagement('p1', 'p1'); // self-hit ignored
    const m = room.engagementOf('p2');
    expect(m?.has('p1')).toBe(true);
    expect(room.engagementOf('p1')).toBeUndefined();
    m!.set('p1', 1); // forge an expired stamp
    expect(room.engagementOf('p2')).toBeUndefined(); // pruned on read
  });

  it('a stale seq edge is gated out and never relays', () => {
    const room = mkRoom({}, 'dm');
    room.players.addPlayer('p1', 'alpha', 'none', 'medium');
    pin(room, 'p1', { x: 0, y: 1, z: 0 });
    room.wireIds.set('p1', 1);
    const sent: Uint8Array[] = [];
    room.connections.sendBinToPlayerReliable = (_pid: string, data: Uint8Array): void => { sent.push(data); };
    room.moveSim.track('p1', { x: 0, y: 1, z: 0 }, 0);
    const mi = (room as unknown as { handlerInfo(): { moveInput?: (pid: string, i: { forward: number; right: number; jump: number; ski: number; jet?: number }, status?: number, seq?: number, ageMs?: number) => boolean } }).handlerInfo().moveInput!;
    mi('p1', { forward: 1, right: 0, jump: 0, ski: 0 }, 0, 5);
    sent.length = 0;
    const ok = mi('p1', { forward: 0, right: 0, jump: 0, ski: 0 }, 0, 4); // older seq
    expect(ok).toBe(false);
    expect(sent.filter((s) => s[1] === WIRE_E_INPUT).length).toBe(0);
  });
});
