/**
 * Unit tests for PositionValidator
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PositionValidator } from './PositionValidator.js';

describe('PositionValidator', () => {
  let validator: PositionValidator;

  beforeEach(() => {
    validator = new PositionValidator();
  });

  describe('validatePosition', () => {
    it('should accept positions when no history exists', () => {
      const result = validator.validatePosition('testPlayer', { x: 0, y: 100, z: 0 }, Date.now(), 50);
      expect(result.action).toBe('accept');
      expect(result.valid).toBe(true);
    });

    it('should validate positions with history', () => {
      const timestamp = Date.now();
      validator.addSnapshot('testPlayer', timestamp, { x: 0, y: 100, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: -9.8, z: 0 });
      const result = validator.validatePosition('testPlayer', { x: 0, y: 100, z: 0 }, timestamp + 100, 50);
      expect(result.action).toBe('accept');
    });
  });

  describe('addSnapshot', () => {
    it('should add position snapshot to history', () => {
      validator.addSnapshot('testPlayer', Date.now(), { x: 0, y: 100, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: -9.8, z: 0 });
      // Should not throw error
      expect(() => validator.addSnapshot('testPlayer', Date.now(), { x: 1, y: 100, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: -9.8, z: 0 })).not.toThrow();
    });
  });

  describe('clearHistory', () => {
    it('should clear player history', () => {
      validator.addSnapshot('testPlayer', Date.now(), { x: 0, y: 100, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: -9.8, z: 0 });
      validator.clearHistory('testPlayer');
      // Should not throw error
      expect(() => validator.clearHistory('testPlayer')).not.toThrow();
    });
  });
});
