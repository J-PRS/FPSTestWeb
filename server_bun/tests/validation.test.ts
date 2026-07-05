import { describe, it, expect } from 'bun:test';
import { validatePlayerId, validateMessage } from '../src/validation.ts';

describe('validatePlayerId', () => {
  it('accepts valid player IDs', () => {
    expect(validatePlayerId('player_1').success).toBe(true);
    expect(validatePlayerId('alice-123').success).toBe(true);
    expect(validatePlayerId('A').success).toBe(true);
  });

  it('rejects empty string', () => {
    expect(validatePlayerId('').success).toBe(false);
  });

  it('rejects non-string', () => {
    expect(validatePlayerId(123).success).toBe(false);
    expect(validatePlayerId(null).success).toBe(false);
  });

  it('rejects invalid characters', () => {
    expect(validatePlayerId('player 1').success).toBe(false);
    expect(validatePlayerId('player@1').success).toBe(false);
  });

  it('rejects too long IDs', () => {
    expect(validatePlayerId('a'.repeat(51)).success).toBe(false);
  });
});

describe('validateMessage', () => {
  it('validates position message', () => {
    const result = validateMessage({
      type: 'position',
      position: { x: 1, y: 2, z: 3 },
      rotation: { yaw: 0.5, pitch: -0.3 },
      velocity: { x: 0, y: 0, z: 0 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects position with NaN', () => {
    const result = validateMessage({
      type: 'position',
      position: { x: NaN, y: 2, z: 3 },
      rotation: { yaw: 0, pitch: 0 },
      velocity: { x: 0, y: 0, z: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects position with Infinity', () => {
    const result = validateMessage({
      type: 'position',
      position: { x: Infinity, y: 2, z: 3 },
      rotation: { yaw: 0, pitch: 0 },
      velocity: { x: 0, y: 0, z: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('validates shot message with targetId', () => {
    const result = validateMessage({
      type: 'shot',
      targetId: 'player2',
    });
    expect(result.success).toBe(true);
  });

  it('validates shot message with null targetId', () => {
    const result = validateMessage({
      type: 'shot',
      targetId: null,
      position: { x: 1, y: 2, z: 3 },
      velocity: { x: 0, y: 0, z: 10 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown message type', () => {
    const result = validateMessage({ type: 'flying' });
    expect(result.success).toBe(false);
  });

  it('rejects non-object message', () => {
    expect(validateMessage('hello').success).toBe(false);
    expect(validateMessage(null).success).toBe(false);
    expect(validateMessage(42).success).toBe(false);
  });

  it('rejects message without type', () => {
    expect(validateMessage({ position: { x: 1, y: 2, z: 3 } }).success).toBe(false);
  });

  it('validates jump message', () => {
    const result = validateMessage({
      type: 'jump',
      position: { x: 10, y: 50, z: -5 },
    });
    expect(result.success).toBe(true);
  });

  it('validates projectileDestroy message', () => {
    const result = validateMessage({
      type: 'projectileDestroy',
      projectileId: 'proj_1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects projectileDestroy with non-string id', () => {
    const result = validateMessage({
      type: 'projectileDestroy',
      projectileId: 123,
    });
    expect(result.success).toBe(false);
  });
});
