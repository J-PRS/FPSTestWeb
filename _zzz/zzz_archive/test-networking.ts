/**
 * Simple test for basic networking functionality
 * Tests BitStream, Event Manager, and basic message encoding/decoding
 */

import { BitStream } from './BitStream.js';
import { EventManager, Event } from './EventManager.js';

// Simple test event
class TestEvent implements Event {
  type: number = 1;
  guaranteed: boolean = true;
  data: string;

  constructor(data: string) {
    this.data = data;
  }

  pack(stream: BitStream): void {
    stream.writeString(this.data);
  }

  unpack(stream: BitStream): void {
    this.data = stream.readString();
  }

  process(): void {
    console.log(`Processed event: ${this.data}`);
  }
}

export function testBitStream(): boolean {
  console.log('Testing BitStream...');
  
  const stream = new BitStream(64);
  
  // Test bit operations
  stream.writeBit(1);
  stream.writeBit(0);
  stream.writeBit(1);
  
  stream.alignToByte();
  
  // Test integer
  stream.writeInt(42, 8);
  stream.writeInt(1000, 16);
  
  // Test float
  stream.writeFloatNormalized(0.5, 8);
  stream.writeFloatRanged(5.0, 0, 10, 16);
  
  // Test string
  stream.writeString('Hello');
  
  const data = stream.getData();
  const readStream = BitStream.fromBuffer(data);
  
  // Read back
  const bit1 = readStream.readBit();
  const bit2 = readStream.readBit();
  const bit3 = readStream.readBit();
  
  readStream.alignToByte();
  
  const int8 = readStream.readInt(8);
  const int16 = readStream.readInt(16);
  const floatNorm = readStream.readFloatNormalized(8);
  const floatRanged = readStream.readFloatRanged(0, 10, 16);
  const str = readStream.readString();
  
  const success = 
    bit1 === 1 && bit2 === 0 && bit3 === 1 &&
    int8 === 42 && int16 === 1000 &&
    Math.abs(floatNorm - 0.5) < 0.01 &&
    Math.abs(floatRanged - 5.0) < 0.1 &&
    str === 'Hello';
  
  console.log(`BitStream test: ${success ? 'PASSED' : 'FAILED'}`);
  return success;
}

export function testEventManager(): boolean {
  console.log('Testing EventManager...');
  
  const eventManager = new EventManager();
  
  // Send events
  eventManager.sendEvent(new TestEvent('Event 1'));
  eventManager.sendEvent(new TestEvent('Event 2'));
  eventManager.sendEvent(new TestEvent('Event 3'));
  
  // Pack events
  const stream = new BitStream(256);
  const packed = eventManager.pack(stream, 200);
  
  console.log(`Packed ${packed} events`);
  
  // Unpack events
  eventManager.unpack(stream);
  
  // Process ordered queue
  eventManager.processOrderedQueue();
  
  const success = packed === 3;
  console.log(`EventManager test: ${success ? 'PASSED' : 'FAILED'}`);
  return success;
}

export function runAllTests(): void {
  console.log('Running networking tests...\n');
  
  const bitStreamTest = testBitStream();
  const eventManagerTest = testEventManager();
  
  console.log('\nTest Results:');
  console.log(`BitStream: ${bitStreamTest ? '✓' : '✗'}`);
  console.log(`EventManager: ${eventManagerTest ? '✓' : '✗'}`);
  
  const allPassed = bitStreamTest && eventManagerTest;
  console.log(`\nOverall: ${allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'}`);
}

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests();
}
