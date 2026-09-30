import { describe, expect, test } from 'bun:test';
import { Room } from '../src/Room';
import { resolveMapSpec } from '../../shared/mapSpec';

const noop = () => {};

// maintain() is wall-clock throttled at 1s — tests ungate it directly.
function forceMaintain(room: Room): void {
  (room.bots as unknown as { roster: { maintainAt: number } }).roster.maintainAt = 0;
  room.bots.tick(0.016);
}

describe('botFill', () => {
  test('spec parses botFill', () => {
    expect(resolveMapSpec({ botFill: 6 }).botFill).toBe(6);
    expect(resolveMapSpec({ botFill: 999 }).botFill).toBe(24); // clamped
    expect(resolveMapSpec({}).botFill).toBeUndefined();
  });

  test('terrain spec accepts only plain .bin filenames', () => {
    expect(resolveMapSpec({ terrain: 'ravine.bin' }).terrain).toBe('ravine.bin');
    expect(resolveMapSpec({ terrain: '../etc/passwd' }).terrain).toBeUndefined();
    expect(resolveMapSpec({ terrain: 'sub/dir.bin' }).terrain).toBeUndefined();
    expect(resolveMapSpec({}).terrain).toBeUndefined();
  });

  test('room tops up to the floor', () => {
    const room = new Room('bf', null, '', resolveMapSpec({ botFill: 5 }));
    forceMaintain(room);
    expect(room.bots.count).toBe(5);
    expect(room.playerCount()).toBe(5);
  });

  test('a human arrival retires a bot', () => {
    const room = new Room('bf2', null, '', resolveMapSpec({ botFill: 4 }));
    forceMaintain(room);
    expect(room.bots.count).toBe(4);
    room.players.addPlayer('human1');
    forceMaintain(room);
    expect(room.bots.count).toBe(3);
    expect(room.playerCount()).toBe(4);
  });

  test('a human departure spawns a replacement', () => {
    const room = new Room('bf3', null, '', resolveMapSpec({ botFill: 3 }));
    room.players.addPlayer('human1');
    forceMaintain(room);
    expect(room.bots.count).toBe(2);
    room.removePlayerCompletely('human1', 'test', noop);
    forceMaintain(room);
    expect(room.bots.count).toBe(3);
  });

  test('no botFill → no maintenance', () => {
    const room = new Room('bf4', null, '', resolveMapSpec({}));
    forceMaintain(room);
    expect(room.bots.count).toBe(0);
  });
});
