import { describe, expect, it } from 'bun:test';
import { recordSuppressed } from '../../src/TickLoop.ts';
import { STATUS } from '../../../shared/status.ts';

// Update suppression is the bandwidth core: a player holding course is
// skipped because clients already extrapolate them. These tests pin the
// tolerances — what counts as "still predictable" vs "must send".

const sent = {
  x: 0, y: 0, z: 0, vx: 10, vy: 0, vz: 0,
  yaw: 1, pitch: 0, hp: 100, dead: false, ski: 0, status: 0, sheep: 0, t: 1000,
};
const player = {
  position: { x: 0, y: 0, z: 0 },
  rotation: { yaw: 1, pitch: 0 },
  health: 100, isDead: false, skiing: 0, status: 0,
};

describe('recordSuppressed', () => {
  it('suppresses a player still on the extrapolated path', () => {
    // 100ms later the prediction puts them at x=1 — exactly where they are.
    player.position.x = 1;
    expect(recordSuppressed(player, sent, 1100)).toBe(true);
  });

  it('sends when actual position drifts >0.3m off the prediction', () => {
    player.position.x = 1.5; // prediction says 1.0
    expect(recordSuppressed(player, sent, 1100)).toBe(false);
    player.position.x = 1;
  });

  it('sends on any state change even with zero movement', () => {
    player.health = 80;
    expect(recordSuppressed(player, sent, 1100)).toBe(false);
    player.health = 100;
    player.status = 4;
    expect(recordSuppressed(player, sent, 1100)).toBe(false);
    player.status = 0;
    player.isDead = true;
    expect(recordSuppressed(player, sent, 1100)).toBe(false);
    player.isDead = false;
  });

  it('sends past the 250ms heartbeat window even when perfectly still', () => {
    sent.vx = 0;
    expect(recordSuppressed(player, sent, 1300)).toBe(false);
    sent.vx = 10;
  });

  it('sends on yaw/pitch turn beyond the deadband', () => {
    player.rotation.yaw = 1.05;
    expect(recordSuppressed(player, sent, 1100)).toBe(false);
    player.rotation.yaw = 1;
    player.rotation.pitch = 0.05;
    expect(recordSuppressed(player, sent, 1100)).toBe(false);
    player.rotation.pitch = 0;
  });

  it('suppresses a yaw that crossed the wrap point', () => {
    // lastSent yaw 0.0 vs live 6.2832 (~2π) is a ~0.003 rad turn, not a
    // full circle — a raw delta would defeat suppression every wrap.
    const wrapped = { ...sent, yaw: 0 };
    player.rotation.yaw = Math.PI * 2;
    expect(recordSuppressed(player, wrapped, 1100)).toBe(true);
    player.rotation.yaw = 1;
  });

  it('suppresses while a server-owned status bit is active', () => {
    // lastSent.status on the wire carries REGEN/DD bits OR'd in at send
    // time — comparing it raw against p.status would read a permanent
    // "change" and defeat suppression for the buff's whole duration.
    const buffed = { ...sent, status: STATUS.REGEN };
    expect(recordSuppressed(player, buffed, 1100)).toBe(true);
    // A real client-side flag change must still break suppression.
    player.status = STATUS.MEND;
    expect(recordSuppressed(player, buffed, 1100)).toBe(false);
    player.status = 0;
  });
});
