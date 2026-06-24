/**
 * Unit tests for GhostManager
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { GhostManager, Ghost, StateMask, ScopeManager } from './GhostManager.js';
import { BitStream } from './BitStream.js';

describe('GhostManager', () => {
  let ghostManager: GhostManager;
  let scopeManager: ScopeManager;

  beforeEach(() => {
    scopeManager = new ScopeManager();
    ghostManager = new GhostManager(scopeManager);
  });

  describe('pack', () => {
    it('should handle no ghosts to pack', () => {
      const stream = new BitStream(1024);
      
      // Should not throw error
      expect(() => ghostManager.pack('conn1', stream, 1400)).not.toThrow();
    });
  });

  describe('unpack', () => {
    it('should handle empty bitstream', () => {
      const stream = new BitStream(1024);
      stream.writeInt(0, 8); // count = 0
      
      stream.reset();
      
      // Should not throw error
      expect(() => ghostManager.unpack('conn1', stream)).not.toThrow();
    });
  });

  describe('removeConnection', () => {
    it('should remove connection and cleanup', () => {
      // Should not throw error
      expect(() => ghostManager.removeConnection('conn1')).not.toThrow();
    });
  });

  describe('getGhosts', () => {
    it('should return empty array for new connection', () => {
      const ghosts = ghostManager.getGhosts('conn1');
      expect(ghosts).toEqual([]);
    });
  });

  describe('clear', () => {
    it('should clear all ghosts', () => {
      // Should not throw error
      expect(() => ghostManager.clear()).not.toThrow();
    });
  });

  describe('updateGhost', () => {
    it('should add ghost for connection', () => {
      const ghost: Ghost = {
        id: 1,
        stateMask: StateMask.POSITION,
        position: { x: 10, y: 20, z: 30 },
        packPosition: (stream: BitStream) => {
          stream.writeFloat32(10);
          stream.writeFloat32(20);
          stream.writeFloat32(30);
        },
        packRotation: () => {},
        packVelocity: () => {},
        packAnimation: () => {},
        packHealth: () => {},
        packWeapon: () => {},
        packFlags: () => {},
        unpackPosition: () => {},
        unpackRotation: () => {},
        unpackVelocity: () => {},
        unpackAnimation: () => {},
        unpackHealth: () => {},
        unpackWeapon: () => {},
        unpackFlags: () => {},
      };
      
      // Should not throw error
      expect(() => ghostManager.updateGhost('conn1', ghost)).not.toThrow();
    });
  });

  describe('removeGhost', () => {
    it('should remove ghost for connection', () => {
      // Should not throw error
      expect(() => ghostManager.removeGhost('conn1', 1)).not.toThrow();
    });
  });

  describe('getGhost', () => {
    it('should return undefined for non-existent ghost', () => {
      const ghost = ghostManager.getGhost('conn1', 1);
      expect(ghost).toBeUndefined();
    });
  });

  describe('StateMask', () => {
    it('should have correct bit values', () => {
      expect(StateMask.POSITION).toBe(1 << 0);
      expect(StateMask.ROTATION).toBe(1 << 1);
      expect(StateMask.VELOCITY).toBe(1 << 2);
      expect(StateMask.ANIMATION).toBe(1 << 3);
      expect(StateMask.HEALTH).toBe(1 << 4);
      expect(StateMask.WEAPON).toBe(1 << 5);
      expect(StateMask.FLAGS).toBe(1 << 6);
    });
  });
});
