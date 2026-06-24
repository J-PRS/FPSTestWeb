/**
 * Event Manager - Guaranteed and non-guaranteed event delivery
 * Based on Tribes 2 networking model
 * 
 * Manages event delivery with sliding window for guaranteed events
 * Non-guaranteed events are sent without retransmission
 */

import { BitStream } from './BitStream.js';
import { ChildLogger } from '../Logger.js';

const logger = new ChildLogger('EventManager');

export interface Event {
  type: number;
  guaranteed: boolean;
  pack(stream: BitStream): void;
  unpack(stream: BitStream): void;
  process(): void;
}

// Concrete event types
export class PositionEvent implements Event {
  type = 1;
  guaranteed = false;
  playerId: string;
  position: { x: number; y: number; z: number };
  rotation: { yaw: number; pitch: number };
  timestamp: number;
  onPositionUpdate?: (playerId: string, position: any, rotation: any) => void;

  constructor(
    playerId: string,
    position: any,
    rotation: any,
    timestamp: number,
    onPositionUpdate?: (playerId: string, position: any, rotation: any) => void
  ) {
    this.playerId = playerId;
    this.position = position;
    this.rotation = rotation;
    this.timestamp = timestamp;
    this.onPositionUpdate = onPositionUpdate;
  }

  pack(stream: BitStream): void {
    stream.writeString(this.playerId);
    stream.writeFloat32(this.position.x);
    stream.writeFloat32(this.position.y);
    stream.writeFloat32(this.position.z);
    stream.writeFloatRanged(this.rotation.yaw, -Math.PI, Math.PI, 16);
    stream.writeFloatRanged(this.rotation.pitch, -Math.PI / 2, Math.PI / 2, 16);
    // Use relative timestamp to fit in 32 bits
    const relativeTimestamp = this.timestamp - (Date.now() - 60000); // Assume ~1 minute window
    stream.writeInt(relativeTimestamp, 32);
  }

  unpack(stream: BitStream): void {
    this.playerId = stream.readString();
    this.position = {
      x: stream.readFloat32(),
      y: stream.readFloat32(),
      z: stream.readFloat32()
    };
    this.rotation = {
      yaw: stream.readFloatRanged(-Math.PI, Math.PI, 16),
      pitch: stream.readFloatRanged(-Math.PI / 2, Math.PI / 2, 16)
    };
    const relativeTimestamp = stream.readInt(32);
    this.timestamp = relativeTimestamp + (Date.now() - 60000);
  }

  process(): void {
    if (this.onPositionUpdate) {
      this.onPositionUpdate(this.playerId, this.position, this.rotation);
    }
  }
}

export class ShotEvent implements Event {
  type = 2;
  guaranteed = true;
  playerId: string;
  targetId: string | null;
  timestamp: number;
  onShot?: (playerId: string, targetId: string | null) => void;

  constructor(
    playerId: string,
    targetId: string | null,
    timestamp: number,
    onShot?: (playerId: string, targetId: string | null) => void
  ) {
    this.playerId = playerId;
    this.targetId = targetId;
    this.timestamp = timestamp;
    this.onShot = onShot;
  }

  pack(stream: BitStream): void {
    stream.writeString(this.playerId);
    stream.writeBool(this.targetId !== null);
    if (this.targetId !== null) {
      stream.writeString(this.targetId);
    }
    // Use relative timestamp to fit in 32 bits
    const relativeTimestamp = this.timestamp - (Date.now() - 60000); // Assume ~1 minute window
    stream.writeInt(relativeTimestamp, 32);
  }

  unpack(stream: BitStream): void {
    this.playerId = stream.readString();
    const hasTarget = stream.readBool();
    this.targetId = hasTarget ? stream.readString() : null;
    const relativeTimestamp = stream.readInt(32);
    this.timestamp = relativeTimestamp + (Date.now() - 60000);
  }

  process(): void {
    if (this.onShot) {
      this.onShot(this.playerId, this.targetId);
    }
  }
}

export class JumpEvent implements Event {
  type = 3;
  guaranteed = false;
  playerId: string;
  timestamp: number;
  onJump?: (playerId: string) => void;

  constructor(
    playerId: string,
    timestamp: number,
    onJump?: (playerId: string) => void
  ) {
    this.playerId = playerId;
    this.timestamp = timestamp;
    this.onJump = onJump;
  }

  pack(stream: BitStream): void {
    stream.writeString(this.playerId);
    const relativeTimestamp = this.timestamp - (Date.now() - 60000);
    stream.writeInt(relativeTimestamp, 32);
  }

  unpack(stream: BitStream): void {
    this.playerId = stream.readString();
    const relativeTimestamp = stream.readInt(32);
    this.timestamp = relativeTimestamp + (Date.now() - 60000);
  }

  process(): void {
    if (this.onJump) {
      this.onJump(this.playerId);
    }
  }
}

export class JetpackEvent implements Event {
  type = 4;
  guaranteed = false;
  playerId: string;
  active: boolean;
  timestamp: number;
  onJetpack?: (playerId: string, active: boolean) => void;

  constructor(
    playerId: string,
    active: boolean,
    timestamp: number,
    onJetpack?: (playerId: string, active: boolean) => void
  ) {
    this.playerId = playerId;
    this.active = active;
    this.timestamp = timestamp;
    this.onJetpack = onJetpack;
  }

  pack(stream: BitStream): void {
    stream.writeString(this.playerId);
    stream.writeBool(this.active);
    const relativeTimestamp = this.timestamp - (Date.now() - 60000);
    stream.writeInt(relativeTimestamp, 32);
  }

  unpack(stream: BitStream): void {
    this.playerId = stream.readString();
    this.active = stream.readBool();
    const relativeTimestamp = stream.readInt(32);
    this.timestamp = relativeTimestamp + (Date.now() - 60000);
  }

  process(): void {
    if (this.onJetpack) {
      this.onJetpack(this.playerId, this.active);
    }
  }
}

export class SkiEvent implements Event {
  type = 5;
  guaranteed = false;
  playerId: string;
  active: boolean;
  timestamp: number;
  onSki?: (playerId: string, active: boolean) => void;

  constructor(
    playerId: string,
    active: boolean,
    timestamp: number,
    onSki?: (playerId: string, active: boolean) => void
  ) {
    this.playerId = playerId;
    this.active = active;
    this.timestamp = timestamp;
    this.onSki = onSki;
  }

  pack(stream: BitStream): void {
    stream.writeString(this.playerId);
    stream.writeBool(this.active);
    const relativeTimestamp = this.timestamp - (Date.now() - 60000);
    stream.writeInt(relativeTimestamp, 32);
  }

  unpack(stream: BitStream): void {
    this.playerId = stream.readString();
    this.active = stream.readBool();
    const relativeTimestamp = stream.readInt(32);
    this.timestamp = relativeTimestamp + (Date.now() - 60000);
  }

  process(): void {
    if (this.onSki) {
      this.onSki(this.playerId, this.active);
    }
  }
}

export class DeathEvent implements Event {
  type = 6;
  guaranteed = true;
  playerId: string;
  killerId: string | null;
  timestamp: number;
  onDeath?: (playerId: string, killerId: string | null) => void;

  constructor(
    playerId: string,
    killerId: string | null,
    timestamp: number,
    onDeath?: (playerId: string, killerId: string | null) => void
  ) {
    this.playerId = playerId;
    this.killerId = killerId;
    this.timestamp = timestamp;
    this.onDeath = onDeath;
  }

  pack(stream: BitStream): void {
    stream.writeString(this.playerId);
    stream.writeBool(this.killerId !== null);
    if (this.killerId !== null) {
      stream.writeString(this.killerId);
    }
    const relativeTimestamp = this.timestamp - (Date.now() - 60000);
    stream.writeInt(relativeTimestamp, 32);
  }

  unpack(stream: BitStream): void {
    this.playerId = stream.readString();
    const hasKiller = stream.readBool();
    this.killerId = hasKiller ? stream.readString() : null;
    const relativeTimestamp = stream.readInt(32);
    this.timestamp = relativeTimestamp + (Date.now() - 60000);
  }

  process(): void {
    if (this.onDeath) {
      this.onDeath(this.playerId, this.killerId);
    }
  }
}

export class EventManager {
  private outgoingQueue: Event[] = [];
  private sequenceNumber: number = 0;
  private pendingEvents: Map<number, Event> = new Map();
  private orderedQueue: Event[] = [];
  private maxWindowSize: number = 32;
  private startTime: number = Date.now();
  private onAckCallback: ((seq: number) => void) | null = null;

  /**
   * Add an event to the outgoing queue
   */
  sendEvent(event: Event): void {
    this.outgoingQueue.push(event);
  }

  /**
   * Pack events into a packet stream
   * Returns the number of events packed
   */
  pack(stream: BitStream, maxBytes: number): number {
    let packedCount = 0;

    while (this.outgoingQueue.length > 0 && stream.hasSpace(16)) {
      const event = this.outgoingQueue.shift();
      if (!event) break;
      
      // Check if adding this event would exceed size limit
      const tempStream = new BitStream(64);
      this.packEventHeader(tempStream, event);
      event.pack(tempStream);
      
      const eventSize = tempStream.getByteLength();
      if (stream.getByteLength() + eventSize > maxBytes) {
        // Put event back if it doesn't fit
        this.outgoingQueue.unshift(event);
        break;
      }

      // Pack event type
      stream.writeInt(event.type, 8);
      
      // Pack sequence number
      stream.writeInt(this.sequenceNumber, 16);
      
      // Pack guaranteed flag
      stream.writeBool(event.guaranteed);
      
      // Pack event data
      event.pack(stream);
      
      // Track guaranteed events
      if (event.guaranteed) {
        this.pendingEvents.set(this.sequenceNumber, event);
      }
      
      this.sequenceNumber++;
      packedCount++;
    }

    return packedCount;
  }

  /**
   * Unpack events from a packet stream
   */
  unpack(stream: BitStream): void {
    while (stream.hasData()) {
      const type = stream.readInt(8);
      const seq = stream.readInt(16);
      const guaranteed = stream.readBool();
      
      const event = this.createEvent(type);
      if (!event) continue;
      
      event.unpack(stream);
      event.guaranteed = guaranteed;
      
      if (guaranteed) {
        // Add to ordered queue for guaranteed processing
        this.addToOrderedQueue(seq, event);
        this.sendAck(seq);
      } else {
        // Process non-guaranteed events immediately
        event.process();
      }
    }
  }

  /**
   * Process ordered queue (guaranteed events in order)
   */
  processOrderedQueue(): void {
    while (this.orderedQueue.length > 0) {
      const event = this.orderedQueue[0];
      event.process();
      this.orderedQueue.shift();
    }
  }

  /**
   * Handle ACK for a guaranteed event
   */
  handleAck(seq: number): void {
    this.pendingEvents.delete(seq);
  }

  /**
   * Handle packet loss notification
   * Retransmit guaranteed events that were in the lost packet
   */
  handlePacketLoss(): void {
    // In a real implementation, we would track which events were in which packet
    // For now, we'll retransmit all pending guaranteed events
    for (const [seq, event] of this.pendingEvents) {
      this.outgoingQueue.unshift(event);
      this.pendingEvents.delete(seq);
    }
  }

  /**
   * Send ACK for a guaranteed event
   */
  private sendAck(seq: number): void {
    // ACK is sent through the connection layer via StreamManager
    if (this.onAckCallback) {
      this.onAckCallback(seq);
    }
  }

  /**
   * Set callback for ACK transmission
   */
  setAckCallback(callback: ((seq: number) => void) | null): void {
    this.onAckCallback = callback;
  }

  /**
   * Add event to ordered queue maintaining sequence order
   */
  private addToOrderedQueue(seq: number, event: Event): void {
    // Find correct position to maintain order
    for (let i = 0; i < this.orderedQueue.length; i++) {
      // We need to track sequence numbers in the queue
      // For simplicity, just append for now
      // In production, we'd need a more sophisticated ordered queue
    }
    this.orderedQueue.push(event);
  }

  /**
   * Pack event header (for size checking)
   */
  private packEventHeader(stream: BitStream, event: Event): void {
    stream.writeInt(event.type, 8);
    stream.writeInt(0, 16); // placeholder for sequence
    stream.writeBool(event.guaranteed);
  }

  /**
   * Create an event from its type
   * Factory method for instantiating concrete event types
   */
  private createEvent(type: number): Event | null {
    switch (type) {
      case 1:
        return new PositionEvent('', { x: 0, y: 0, z: 0 }, { yaw: 0, pitch: 0 }, 0);
      case 2:
        return new ShotEvent('', null, 0);
      case 3:
        return new JumpEvent('', 0);
      case 4:
        return new JetpackEvent('', false, 0);
      case 5:
        return new SkiEvent('', false, 0);
      case 6:
        return new DeathEvent('', null, 0);
      default:
        logger.warn(`Unknown event type: ${type}`);
        return null;
    }
  }

  /**
   * Get number of pending guaranteed events
   */
  getPendingCount(): number {
    return this.pendingEvents.size;
  }

  /**
   * Get number of events in outgoing queue
   */
  getQueueCount(): number {
    return this.outgoingQueue.length;
  }

  /**
   * Check if window is full
   */
  isWindowFull(): boolean {
    return this.pendingEvents.size >= this.maxWindowSize;
  }

  /**
   * Reset the event manager
   */
  reset(): void {
    this.outgoingQueue = [];
    this.sequenceNumber = 0;
    this.pendingEvents.clear();
    this.orderedQueue = [];
  }
}
