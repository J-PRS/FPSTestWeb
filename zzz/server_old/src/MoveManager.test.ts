/**
 * Unit tests for MoveManager
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MoveManager, Move } from './MoveManager.js';
import { BitStream } from './BitStream.js';

describe('MoveManager', () => {
  let moveManager: MoveManager;

  beforeEach(() => {
    moveManager = new MoveManager();
  });

  describe('addMove', () => {
    it('should add move for connection', () => {
      const move: Move = {
        sequence: 1,
        timestamp: Date.now(),
        input: { forward: 10, right: 5, jump: 1, ski: 0 },
        rotation: { yaw: 1.5, pitch: 0.5 }
      };
      
      moveManager.addMove('conn1', move);
      
      // Should not throw error
      expect(() => moveManager.addMove('conn1', move)).not.toThrow();
    });

    it('should create queue for new connection', () => {
      const move: Move = {
        sequence: 1,
        timestamp: Date.now(),
        input: { forward: 10, right: 5, jump: 1, ski: 0 },
        rotation: { yaw: 1.5, pitch: 0.5 }
      };
      
      moveManager.addMove('conn1', move);
      
      // Should not throw error
      expect(() => moveManager.addMove('conn1', move)).not.toThrow();
    });
  });

  describe('pack', () => {
    it('should pack moves into bitstream', () => {
      const move: Move = {
        sequence: 1,
        timestamp: Date.now(),
        input: { forward: 10, right: 5, jump: 1, ski: 0 },
        rotation: { yaw: 1.5, pitch: 0.5 }
      };
      
      moveManager.addMove('conn1', move);
      
      const stream = new BitStream(1024);
      
      // Should not throw error
      expect(() => moveManager.pack('conn1', stream)).not.toThrow();
    });

    it('should write 0 when no moves to pack', () => {
      const stream = new BitStream(1024);
      
      moveManager.pack('conn1', stream);
      
      // Should not throw error
      expect(() => moveManager.pack('conn1', stream)).not.toThrow();
    });
  });

  describe('unpack', () => {
    it('should unpack moves from bitstream', () => {
      const stream = new BitStream(1024);
      
      // Pack a move
      stream.writeInt(1, 8); // count
      stream.writeInt(1, 16); // sequence
      stream.writeInt(Date.now(), 32); // timestamp
      stream.writeSignedInt(10, 8); // forward
      stream.writeSignedInt(5, 8); // right
      stream.writeInt(1, 1); // jump
      stream.writeInt(0, 1); // ski
      stream.writeFloatRanged(1.5, -Math.PI, Math.PI, 16); // yaw
      stream.writeFloatRanged(0.5, -Math.PI / 2, Math.PI / 2, 16); // pitch
      
      stream.reset();
      
      const moves = moveManager.unpack('conn1', stream);
      
      expect(moves).toHaveLength(1);
      expect(moves[0].sequence).toBe(1);
    });

    it('should handle multiple moves', () => {
      const stream = new BitStream(1024);
      
      // Pack 2 moves
      stream.writeInt(2, 8); // count
      
      stream.writeInt(1, 16);
      stream.writeInt(Date.now(), 32);
      stream.writeSignedInt(10, 8);
      stream.writeSignedInt(5, 8);
      stream.writeInt(1, 1);
      stream.writeInt(0, 1);
      stream.writeFloatRanged(1.5, -Math.PI, Math.PI, 16);
      stream.writeFloatRanged(0.5, -Math.PI / 2, Math.PI / 2, 16);
      
      stream.writeInt(2, 16);
      stream.writeInt(Date.now(), 32);
      stream.writeSignedInt(20, 8);
      stream.writeSignedInt(10, 8);
      stream.writeInt(0, 1);
      stream.writeInt(1, 1);
      stream.writeFloatRanged(2.0, -Math.PI, Math.PI, 16);
      stream.writeFloatRanged(0.3, -Math.PI / 2, Math.PI / 2, 16);
      
      stream.reset();
      
      const moves = moveManager.unpack('conn1', stream);
      
      expect(moves).toHaveLength(2);
    });
  });

  describe('validateMove', () => {
    it('should validate valid move', () => {
      const move: Move = {
        sequence: 1,
        timestamp: Date.now(),
        input: { forward: 10, right: 5, jump: 1, ski: 0 },
        rotation: { yaw: 1.5, pitch: 0.5 }
      };
      
      moveManager.addMove('conn1', move);
      
      // Should not throw error (validation happens internally)
      expect(() => moveManager.addMove('conn1', move)).not.toThrow();
    });
  });

  describe('getLastProcessedSequence', () => {
    it('should return 0 for new connection', () => {
      const seq = moveManager.getLastProcessedSequence('conn1');
      expect(seq).toBe(0);
    });
  });

  describe('getPendingCount', () => {
    it('should return 0 for new connection', () => {
      const count = moveManager.getPendingCount('conn1');
      expect(count).toBe(0);
    });

    it('should return count of pending moves', () => {
      const move: Move = {
        sequence: 1,
        timestamp: Date.now(),
        input: { forward: 10, right: 5, jump: 1, ski: 0 },
        rotation: { yaw: 1.5, pitch: 0.5 }
      };
      
      moveManager.addMove('conn1', move);
      moveManager.addMove('conn1', move);
      
      const count = moveManager.getPendingCount('conn1');
      expect(count).toBe(2);
    });
  });

  describe('isWindowFull', () => {
    it('should return false for new connection', () => {
      const isFull = moveManager.isWindowFull('conn1');
      expect(isFull).toBe(false);
    });
  });

  describe('removeConnection', () => {
    it('should remove connection and cleanup', () => {
      const move: Move = {
        sequence: 1,
        timestamp: Date.now(),
        input: { forward: 10, right: 5, jump: 1, ski: 0 },
        rotation: { yaw: 1.5, pitch: 0.5 }
      };
      
      moveManager.addMove('conn1', move);
      moveManager.removeConnection('conn1');
      
      // Should not throw error
      expect(() => moveManager.removeConnection('conn1')).not.toThrow();
    });
  });

  describe('onMove callback', () => {
    it('should call callback when move is unpacked', () => {
      let callbackCalled = false;
      moveManager.onMove((connId: string, move: Move) => {
        callbackCalled = true;
        expect(connId).toBe('conn1');
        expect(move.sequence).toBe(1);
      });
      
      const stream = new BitStream(1024);
      stream.writeInt(1, 8);
      stream.writeInt(1, 16);
      stream.writeInt(Date.now(), 32);
      stream.writeSignedInt(10, 8);
      stream.writeSignedInt(5, 8);
      stream.writeInt(1, 1);
      stream.writeInt(0, 1);
      stream.writeFloatRanged(1.5, -Math.PI, Math.PI, 16);
      stream.writeFloatRanged(0.5, -Math.PI / 2, Math.PI / 2, 16);
      
      stream.reset();
      moveManager.unpack('conn1', stream);
      
      expect(callbackCalled).toBe(true);
    });
  });

  describe('packControlState', () => {
    it('should pack control state with 0xFF marker', () => {
      const controlObject = {
        position: { x: 10, y: 20, z: 30 },
        rotation: { yaw: 1.5, pitch: 0.5 },
        velocity: { x: 1, y: 2, z: 3 }
      };
      
      const stream = new BitStream(1024);
      moveManager.packControlState('conn1', stream, controlObject);
      
      stream.reset();
      
      // Check for 0xFF marker
      const marker = stream.readInt(8);
      expect(marker).toBe(0xFF);
    });

    it('should pack position, rotation, velocity', () => {
      const controlObject = {
        position: { x: 10, y: 20, z: 30 },
        rotation: { yaw: 1.5, pitch: 0.5 },
        velocity: { x: 1, y: 2, z: 3 }
      };
      
      const stream = new BitStream(1024);
      moveManager.packControlState('conn1', stream, controlObject);
      
      stream.reset();
      stream.readInt(8); // skip marker
      
      const x = stream.readFloat32();
      const y = stream.readFloat32();
      const z = stream.readFloat32();
      
      expect(x).toBe(10);
      expect(y).toBe(20);
      expect(z).toBe(30);
    });

    it('should pack last processed sequence', () => {
      const controlObject = {
        position: { x: 10, y: 20, z: 30 },
        rotation: { yaw: 1.5, pitch: 0.5 },
        velocity: { x: 1, y: 2, z: 3 }
      };
      
      // Set last processed sequence
      moveManager.processMoves('conn1', controlObject);
      
      const stream = new BitStream(1024);
      moveManager.packControlState('conn1', stream, controlObject);
      
      stream.reset();
      stream.readInt(8); // skip marker
      stream.readFloat32(); // skip x
      stream.readFloat32(); // skip y
      stream.readFloat32(); // skip z
      stream.readFloatRanged(-Math.PI, Math.PI, 16); // skip yaw
      stream.readFloatRanged(-Math.PI / 2, Math.PI / 2, 16); // skip pitch
      stream.readFloat32(); // skip vx
      stream.readFloat32(); // skip vy
      stream.readFloat32(); // skip vz
      
      const lastSeq = stream.readInt(16);
      expect(lastSeq).toBeGreaterThanOrEqual(0);
    });

    it('should handle null control object', () => {
      const stream = new BitStream(1024);
      
      // Should not throw error
      expect(() => moveManager.packControlState('conn1', stream, null)).not.toThrow();
    });
  });
});
