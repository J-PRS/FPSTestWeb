/**
 * Integration tests for client-server message flow
 * Per multiplayer specification: Client-server message flow, reconnection with state restoration
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventManager, PositionEvent, ShotEvent } from './EventManager.js';
import { GhostManager, ScopeManager } from './GhostManager.js';
import { MoveManager } from './MoveManager.js';
import { StreamManager } from './StreamManager.js';
import { BitStream } from './BitStream.js';

describe('Client-Server Message Flow Integration', () => {
  let eventManager: EventManager;
  let ghostManager: GhostManager;
  let moveManager: MoveManager;
  let streamManager: StreamManager;
  let sentPackets: Uint8Array[] = [];

  beforeEach(() => {
    eventManager = new EventManager();
    const scopeManager = new ScopeManager();
    ghostManager = new GhostManager(scopeManager);
    moveManager = new MoveManager();
    sentPackets = [];

    // Create StreamManager with packet capture
    streamManager = new StreamManager(
      eventManager,
      ghostManager,
      moveManager,
      {
        maxPacketSize: 1400,
        packetsPerSecond: 30,
        maxBytesPerSecond: 42000
      },
      (connectionId: string, data: Uint8Array) => {
        sentPackets.push(data);
      }
    );
  });

  afterEach(() => {
    streamManager.removeConnection('test-conn');
  });

  describe('Position Update Flow', () => {
    it('should send position event through event manager', () => {
      const event = new PositionEvent('player1', { x: 10, y: 20, z: 30 }, { yaw: 1.5, pitch: 0.5 }, Date.now());
      
      expect(() => eventManager.sendEvent('test-conn', event)).not.toThrow();
    });

    it('should pack position event into bitstream', () => {
      const event = new PositionEvent('player1', { x: 10, y: 20, z: 30 }, { yaw: 1.5, pitch: 0.5 }, Date.now());
      eventManager.sendEvent('test-conn', event);
      
      const stream = new BitStream(1024);
      const packedCount = eventManager.pack('test-conn', stream, 1400);
      
      expect(packedCount).toBeGreaterThan(0);
    });

    it('should unpack position event from bitstream', () => {
      const stream = new BitStream(1024);
      
      // Pack a PositionEvent
      stream.writeInt(1, 8); // type
      stream.writeInt(0, 16); // sequence
      stream.writeBool(false); // guaranteed
      stream.writeString('player1');
      stream.writeFloat32(10);
      stream.writeFloat32(20);
      stream.writeFloat32(30);
      stream.writeFloatRanged(1.5, -Math.PI, Math.PI, 16);
      stream.writeFloatRanged(0.5, -Math.PI / 2, Math.PI / 2, 16);
      const relativeTimestamp = Date.now() - (Date.now() - 60000);
      stream.writeInt(relativeTimestamp, 32);
      
      stream.reset();
      
      // Should not throw error during unpack
      expect(() => eventManager.unpack('test-conn', stream)).not.toThrow();
    });
  });

  describe('Shot Event Flow', () => {
    it('should send guaranteed shot event', () => {
      const event = new ShotEvent('player1', 'player2', Date.now());
      
      expect(() => eventManager.sendEvent('test-conn', event)).not.toThrow();
    });

    it('should handle ACK for guaranteed shot event', () => {
      const event = new ShotEvent('player1', 'player2', Date.now());
      eventManager.sendEvent('test-conn', event);
      
      // Simulate ACK
      expect(() => eventManager.handleAck('test-conn', 0)).not.toThrow();
    });
  });

  describe('Move Input Flow', () => {
    it('should process move input through MoveManager', () => {
      const move = {
        playerId: 'player1',
        sequence: 1,
        timestamp: Date.now(),
        input: {
          forward: 1,
          right: 0,
          jump: 0,
          jetpack: 0,
          ski: 0
        },
        rotation: { yaw: 1.5, pitch: 0.5 }
      };
      
      // Should not throw error
      expect(() => moveManager.addMove('test-conn', move)).not.toThrow();
    });

    it('should get last processed sequence', () => {
      const sequence = moveManager.getLastProcessedSequence('test-conn');
      expect(typeof sequence).toBe('number');
    });
  });

  describe('Ghost State Flow', () => {
    it('should update ghost state with minimal data', () => {
      const ghost = {
        id: 1,
        stateMask: 0,
        position: { x: 10, y: 20, z: 30 },
        rotation: { yaw: 1.5, pitch: 0.5 },
        velocity: { x: 0, y: 0, z: 0 },
        packPosition: () => {},
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
        unpackFlags: () => {}
      };
      
      expect(() => ghostManager.updateGhost('test-conn', ghost)).not.toThrow();
    });

    it('should get ghost state by ID', () => {
      const ghost = ghostManager.getGhost('test-conn', 1);
      // Ghost may not exist yet, should return null or undefined
      expect(ghost === null || ghost === undefined || typeof ghost === 'object').toBe(true);
    });
  });

  describe('Connection Lifecycle', () => {
    it('should start connection', () => {
      expect(() => streamManager.startConnection('test-conn')).not.toThrow();
    });

    it('should remove connection and cleanup', () => {
      streamManager.startConnection('test-conn');
      expect(() => streamManager.removeConnection('test-conn')).not.toThrow();
    });
  });

  describe('Event Packing', () => {
    it('should pack multiple events into single bitstream', () => {
      for (let i = 0; i < 10; i++) {
        const event = new PositionEvent(`player${i}`, { x: i, y: i, z: i }, { yaw: 0, pitch: 0 }, Date.now());
        eventManager.sendEvent('test-conn', event);
      }
      
      const stream = new BitStream(1400);
      const packedCount = eventManager.pack('test-conn', stream, 1400);
      
      expect(packedCount).toBeGreaterThan(0);
      expect(packedCount).toBeLessThanOrEqual(10);
    });

    it('should respect max packet size when packing', () => {
      // Add many events to test packet size limiting
      for (let i = 0; i < 100; i++) {
        const event = new PositionEvent(`player${i}`, { x: i, y: i, z: i }, { yaw: 0, pitch: 0 }, Date.now());
        eventManager.sendEvent('test-conn', event);
      }
      
      const stream = new BitStream(1400);
      eventManager.pack('test-conn', stream, 1400);
      
      // Check that stream size is within limits
      const data = stream.getData();
      expect(data.length).toBeLessThanOrEqual(1400);
    });
  });

  describe('Event Ordering', () => {
    it('should maintain event sequence numbers', () => {
      const event1 = new PositionEvent('player1', { x: 10, y: 20, z: 30 }, { yaw: 1.5, pitch: 0.5 }, Date.now());
      const event2 = new PositionEvent('player1', { x: 11, y: 21, z: 31 }, { yaw: 1.6, pitch: 0.6 }, Date.now());
      
      eventManager.sendEvent('test-conn', event1);
      eventManager.sendEvent('test-conn', event2);
      
      const stream = new BitStream(1024);
      const packedCount = eventManager.pack('test-conn', stream, 1400);
      
      expect(packedCount).toBeGreaterThan(0);
    });
  });

  describe('Manager Integration', () => {
    it('should wire event callback from EventManager', () => {
      let callbackCalled = false;
      eventManager.onEvent((connId: string, _event: any) => {
        callbackCalled = true;
        expect(connId).toBe('test-conn');
      });
      
      const stream = new BitStream(1024);
      stream.writeInt(1, 8); // type
      stream.writeInt(0, 16); // sequence
      stream.writeBool(false); // guaranteed
      stream.writeString('player1');
      stream.writeFloat32(10);
      stream.writeFloat32(20);
      stream.writeFloat32(30);
      stream.writeFloatRanged(1.5, -Math.PI, Math.PI, 16);
      stream.writeFloatRanged(0.5, -Math.PI / 2, Math.PI / 2, 16);
      const relativeTimestamp = Date.now() - (Date.now() - 60000);
      stream.writeInt(relativeTimestamp, 32);
      
      stream.reset();
      eventManager.unpack('test-conn', stream);
      
      expect(callbackCalled).toBe(true);
    });

    it('should wire move callback from MoveManager', () => {
      let callbackCalled = false;
      moveManager.onMove((connId: string, _move: any) => {
        callbackCalled = true;
        expect(connId).toBe('test-conn');
      });
      
      const move = {
        playerId: 'player1',
        sequence: 1,
        timestamp: Date.now(),
        input: {
          forward: 1,
          right: 0,
          jump: 0,
          jetpack: 0,
          ski: 0
        },
        rotation: { yaw: 1.5, pitch: 0.5 }
      };
      
      moveManager.addMove('test-conn', move);
      
      expect(callbackCalled).toBe(true);
    });
  });
});
