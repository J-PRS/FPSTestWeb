/**
 * Unit tests for EventManager
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventManager, PositionEvent, JumpEvent, JetpackEvent, SkiEvent, DeathEvent } from './EventManager.js';
import { BitStream } from './BitStream.js';

describe('EventManager', () => {
  let eventManager: EventManager;

  beforeEach(() => {
    eventManager = new EventManager();
  });

  describe('sendEvent', () => {
    it('should add event to outgoing queue for connection', () => {
      const event = new PositionEvent('player1', { x: 10, y: 20, z: 30 }, { yaw: 1.5, pitch: 0.5 }, Date.now());
      eventManager.sendEvent('conn1', event);
      
      // Event should be queued (no error thrown)
      expect(() => eventManager.sendEvent('conn1', event)).not.toThrow();
    });

    it('should create queue for new connection', () => {
      const event = new PositionEvent('player1', { x: 10, y: 20, z: 30 }, { yaw: 1.5, pitch: 0.5 }, Date.now());
      eventManager.sendEvent('conn1', event);
      
      // Should not throw error
      expect(() => eventManager.sendEvent('conn1', event)).not.toThrow();
    });
  });

  describe('pack', () => {
    it('should pack events into bitstream', () => {
      const event = new PositionEvent('player1', { x: 10, y: 20, z: 30 }, { yaw: 1.5, pitch: 0.5 }, Date.now());
      eventManager.sendEvent('conn1', event);
      
      const stream = new BitStream(1024);
      const packedCount = eventManager.pack('conn1', stream, 1400);
      
      expect(packedCount).toBeGreaterThan(0);
    });

    it('should return 0 when no events to pack', () => {
      const stream = new BitStream(1024);
      const packedCount = eventManager.pack('conn1', stream, 1400);
      
      expect(packedCount).toBe(0);
    });
  });

  describe('unpack', () => {
    it('should unpack events from bitstream', () => {
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
      
      // Should not throw error
      expect(() => eventManager.unpack('conn1', stream)).not.toThrow();
    });

    it('should handle guaranteed events', () => {
      const stream = new BitStream(1024);
      
      // Pack a guaranteed ShotEvent
      stream.writeInt(2, 8); // type
      stream.writeInt(0, 16); // sequence
      stream.writeBool(true); // guaranteed
      stream.writeString('player1');
      stream.writeBool(false); // no target
      const relativeTimestamp = Date.now() - (Date.now() - 60000);
      stream.writeInt(relativeTimestamp, 32);
      
      stream.reset();
      
      // Should not throw error
      expect(() => eventManager.unpack('conn1', stream)).not.toThrow();
    });
  });

  describe('handleAck', () => {
    it('should handle ACK for guaranteed event', () => {
      // Should not throw error
      expect(() => eventManager.handleAck('conn1', 0)).not.toThrow();
    });
  });

  describe('removeConnection', () => {
    it('should remove connection and cleanup', () => {
      const event = new PositionEvent('player1', { x: 10, y: 20, z: 30 }, { yaw: 1.5, pitch: 0.5 }, Date.now());
      eventManager.sendEvent('conn1', event);
      
      eventManager.removeConnection('conn1');
      
      // Should not throw error
      expect(() => eventManager.removeConnection('conn1')).not.toThrow();
    });
  });

  describe('onEvent callback', () => {
    it('should call callback when event is processed', () => {
      let callbackCalled = false;
      eventManager.onEvent((connId: string, _event: any) => {
        callbackCalled = true;
        expect(connId).toBe('conn1');
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
      eventManager.unpack('conn1', stream);
      
      expect(callbackCalled).toBe(true);
    });
  });

  describe('JumpEvent', () => {
    it('should pack and unpack JumpEvent', () => {
      const event = new JumpEvent('player1', Date.now());
      const stream = new BitStream(1024);
      
      event.pack(stream);
      stream.reset();
      
      const unpackedEvent = new JumpEvent('', 0);
      unpackedEvent.unpack(stream);
      
      expect(unpackedEvent.playerId).toBe('player1');
    });
  });

  describe('JetpackEvent', () => {
    it('should pack and unpack JetpackEvent', () => {
      const event = new JetpackEvent('player1', true, Date.now());
      const stream = new BitStream(1024);
      
      event.pack(stream);
      stream.reset();
      
      const unpackedEvent = new JetpackEvent('', false, 0);
      unpackedEvent.unpack(stream);
      
      expect(unpackedEvent.playerId).toBe('player1');
      expect(unpackedEvent.active).toBe(true);
    });
  });

  describe('SkiEvent', () => {
    it('should pack and unpack SkiEvent', () => {
      const event = new SkiEvent('player1', true, Date.now());
      const stream = new BitStream(1024);
      
      event.pack(stream);
      stream.reset();
      
      const unpackedEvent = new SkiEvent('', false, 0);
      unpackedEvent.unpack(stream);
      
      expect(unpackedEvent.playerId).toBe('player1');
      expect(unpackedEvent.active).toBe(true);
    });
  });

  describe('DeathEvent', () => {
    it('should pack and unpack DeathEvent with killer', () => {
      const event = new DeathEvent('player1', 'player2', Date.now());
      const stream = new BitStream(1024);
      
      event.pack(stream);
      stream.reset();
      
      const unpackedEvent = new DeathEvent('', null, 0);
      unpackedEvent.unpack(stream);
      
      expect(unpackedEvent.playerId).toBe('player1');
      expect(unpackedEvent.killerId).toBe('player2');
    });

    it('should pack and unpack DeathEvent without killer', () => {
      const event = new DeathEvent('player1', null, Date.now());
      const stream = new BitStream(1024);
      
      event.pack(stream);
      stream.reset();
      
      const unpackedEvent = new DeathEvent('', null, 0);
      unpackedEvent.unpack(stream);
      
      expect(unpackedEvent.playerId).toBe('player1');
      expect(unpackedEvent.killerId).toBe(null);
    });
  });
});
