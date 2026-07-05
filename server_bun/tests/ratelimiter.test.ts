import { describe, it, expect } from 'bun:test';
import { RateLimiter } from '../src/RateLimiter.ts';

describe('RateLimiter', () => {
  it('allows messages under the limit', () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 30; i++) {
      expect(rl.check('player1', 'position')).toBe(true);
    }
  });

  it('blocks messages over the limit', () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 30; i++) {
      rl.check('player1', 'position');
    }
    expect(rl.check('player1', 'position')).toBe(false);
  });

  it('tracks different message types independently', () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 10; i++) {
      rl.check('player1', 'shot');
    }
    expect(rl.check('player1', 'shot')).toBe(false);
    expect(rl.check('player1', 'position')).toBe(true);
  });

  it('tracks different players independently', () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 30; i++) {
      rl.check('player1', 'position');
    }
    expect(rl.check('player1', 'position')).toBe(false);
    expect(rl.check('player2', 'position')).toBe(true);
  });

  it('cleans up on removePlayer', () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 30; i++) {
      rl.check('player1', 'position');
    }
    rl.removePlayer('player1');
    expect(rl.check('player1', 'position')).toBe(true);
  });

  it('allows inputMove at 120/s', () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 120; i++) {
      expect(rl.check('player1', 'inputMove')).toBe(true);
    }
    expect(rl.check('player1', 'inputMove')).toBe(false);
  });
});
