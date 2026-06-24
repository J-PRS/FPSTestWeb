/**
 * Unit tests for BitStream
 * Per multiplayer specification: BitStream serialization/deserialization
 */

import { describe, it, expect } from 'vitest';
import { BitStream } from './BitStream.js';

describe('BitStream', () => {
  describe('Basic bit operations', () => {
    it('should write and read single bits', () => {
      const stream = new BitStream(32);
      stream.writeBit(1);
      stream.writeBit(0);
      stream.writeBit(1);
      stream.reset();
      
      expect(stream.readBit()).toBe(1);
      expect(stream.readBit()).toBe(0);
      expect(stream.readBit()).toBe(1);
    });

    it('should write and read multiple bits', () => {
      const stream = new BitStream(32);
      stream.writeInt(0b101, 3);
      stream.reset();
      
      expect(stream.readInt(3)).toBe(0b101);
    });
  });

  describe('Integer operations', () => {
    it('should write and read 8-bit integers', () => {
      const stream = new BitStream(32);
      stream.writeInt(255, 8);
      stream.reset();
      
      expect(stream.readInt(8)).toBe(255);
    });

    it('should write and read 16-bit integers', () => {
      const stream = new BitStream(32);
      stream.writeInt(65535, 16);
      stream.reset();
      
      expect(stream.readInt(16)).toBe(65535);
    });

    it('should write and read 32-bit integers', () => {
      const stream = new BitStream(32);
      stream.writeInt(123456789, 32);
      stream.reset();
      
      expect(stream.readInt(32)).toBe(123456789);
    });

    it('should write and read signed integers', () => {
      const stream = new BitStream(32);
      stream.writeInt(-100, 16);
      stream.reset();
      
      expect(stream.readInt(16)).toBe(-100);
    });
  });

  describe('Float operations', () => {
    it('should write and read 32-bit floats', () => {
      const stream = new BitStream(32);
      stream.writeFloat32(3.14159);
      stream.reset();
      
      expect(stream.readFloat32()).toBeCloseTo(3.14159, 4);
    });

    it('should write and read ranged floats', () => {
      const stream = new BitStream(32);
      stream.writeFloatRanged(0.5, 0, 1, 16);
      stream.reset();
      
      const value = stream.readFloatRanged(0, 1, 16);
      expect(value).toBeCloseTo(0.5, 2);
    });

    it('should handle negative ranged floats', () => {
      const stream = new BitStream(32);
      stream.writeFloatRanged(-1.5, -Math.PI, Math.PI, 16);
      stream.reset();
      
      const value = stream.readFloatRanged(-Math.PI, Math.PI, 16);
      expect(value).toBeCloseTo(-1.5, 2);
    });
  });

  describe('String operations', () => {
    it('should write and read strings', () => {
      const stream = new BitStream(256);
      stream.writeString('hello');
      stream.reset();
      
      expect(stream.readString()).toBe('hello');
    });

    it('should write and read empty strings', () => {
      const stream = new BitStream(256);
      stream.writeString('');
      stream.reset();
      
      expect(stream.readString()).toBe('');
    });

    it('should write and read long strings', () => {
      const stream = new BitStream(1024);
      const longString = 'a'.repeat(100);
      stream.writeString(longString);
      stream.reset();
      
      expect(stream.readString()).toBe(longString);
    });
  });

  describe('Boolean operations', () => {
    it('should write and read boolean true', () => {
      const stream = new BitStream(32);
      stream.writeBool(true);
      stream.reset();
      
      expect(stream.readBool()).toBe(true);
    });

    it('should write and read boolean false', () => {
      const stream = new BitStream(32);
      stream.writeBool(false);
      stream.reset();
      
      expect(stream.readBool()).toBe(false);
    });
  });

  describe('Buffer operations', () => {
    it('should return buffer with correct data', () => {
      const stream = new BitStream(32);
      stream.writeInt(42, 8);
      const buffer = stream.getData();
      
      expect(buffer).toBeInstanceOf(Uint8Array);
      expect(buffer.length).toBeGreaterThan(0);
    });

    it('should create from buffer', () => {
      const original = new BitStream(32);
      original.writeInt(123, 16);
      const buffer = original.getData();
      
      const restored = BitStream.fromBuffer(buffer);
      expect(restored.readInt(16)).toBe(123);
    });
  });

  describe('Position tracking', () => {
    it('should track bit position correctly', () => {
      const stream = new BitStream(32);
      stream.writeBit(1);
      stream.writeBit(0);
      
      expect(stream.getBitPosition()).toBe(2);
    });

    it('should reset bit position', () => {
      const stream = new BitStream(32);
      stream.writeInt(255, 8);
      stream.reset();
      
      expect(stream.getBitPosition()).toBe(0);
    });
  });

  describe('Capacity management', () => {
    it('should expand buffer when needed', () => {
      const stream = new BitStream(32);
      // Write more data than initial capacity
      for (let i = 0; i < 100; i++) {
        stream.writeInt(i, 16);
      }
      
      stream.reset();
      for (let i = 0; i < 100; i++) {
        expect(stream.readInt(16)).toBe(i);
      }
    });
  });

  describe('Complex serialization', () => {
    it('should serialize and deserialize player position', () => {
      const stream = new BitStream(256);
      
      // Serialize player data
      stream.writeString('player123');
      stream.writeFloat32(10.5);
      stream.writeFloat32(20.3);
      stream.writeFloat32(30.7);
      stream.writeFloatRanged(1.5, -Math.PI, Math.PI, 16);
      stream.writeFloatRanged(0.5, -Math.PI / 2, Math.PI / 2, 16);
      
      stream.reset();
      
      // Deserialize
      const playerId = stream.readString();
      const x = stream.readFloat32();
      const y = stream.readFloat32();
      const z = stream.readFloat32();
      const yaw = stream.readFloatRanged(-Math.PI, Math.PI, 16);
      const pitch = stream.readFloatRanged(-Math.PI / 2, Math.PI / 2, 16);
      
      expect(playerId).toBe('player123');
      expect(x).toBeCloseTo(10.5, 4);
      expect(y).toBeCloseTo(20.3, 4);
      expect(z).toBeCloseTo(30.7, 4);
      expect(yaw).toBeCloseTo(1.5, 2);
      expect(pitch).toBeCloseTo(0.5, 2);
    });
  });
});
