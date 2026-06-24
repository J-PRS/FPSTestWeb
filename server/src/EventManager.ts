/**
 * Event Manager - Guaranteed and non-guaranteed event delivery (Server)
 * Based on Tribes 2 networking model
 * 
 * Manages event delivery with sliding window for guaranteed events
 * Non-guaranteed events are sent without retransmission
 */

import { BitStream } from './BitStream.js';
import { Logger } from './Logger.js';

export interface Event {
  type: number;
  guaranteed: boolean;
  pack(stream: BitStream): void;
  unpack(stream: BitStream): void;
  process(connectionId: string): void;
}

// Concrete event types for server
export class PositionEvent implements Event {
  type = 1;
  guaranteed = false;
  playerId: string;
  position: { x: number; y: number; z: number };
  rotation: { yaw: number; pitch: number };
  timestamp: number;

  constructor(playerId: string, position: any, rotation: any, timestamp: number) {
    this.playerId = playerId;
    this.position = position;
    this.rotation = rotation;
    this.timestamp = timestamp;
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

  process(_connectionId: string): void {
    // Server-side processing - forward to MessageHandler
    Logger.debug(`Position event from ${this.playerId}`);
  }
}

export class ShotEvent implements Event {
  type = 2;
  guaranteed = true;
  playerId: string;
  targetId: string | null;
  timestamp: number;

  constructor(playerId: string, targetId: string | null, timestamp: number) {
    this.playerId = playerId;
    this.targetId = targetId;
    this.timestamp = timestamp;
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

  process(_connectionId: string): void {
    // Server-side processing - forward to MessageHandler
    Logger.debug(`Shot event from ${this.playerId} at ${this.targetId}`);
  }
}

export class JumpEvent implements Event {
  type = 3;
  guaranteed = false;
  playerId: string;
  timestamp: number;

  constructor(playerId: string, timestamp: number) {
    this.playerId = playerId;
    this.timestamp = timestamp;
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

  process(_connectionId: string): void {
    Logger.debug(`Jump event from ${this.playerId}`);
  }
}

export class JetpackEvent implements Event {
  type = 4;
  guaranteed = false;
  playerId: string;
  active: boolean;
  timestamp: number;

  constructor(playerId: string, active: boolean, timestamp: number) {
    this.playerId = playerId;
    this.active = active;
    this.timestamp = timestamp;
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

  process(_connectionId: string): void {
    Logger.debug(`Jetpack event from ${this.playerId}: ${this.active}`);
  }
}

export class SkiEvent implements Event {
  type = 5;
  guaranteed = false;
  playerId: string;
  active: boolean;
  timestamp: number;

  constructor(playerId: string, active: boolean, timestamp: number) {
    this.playerId = playerId;
    this.active = active;
    this.timestamp = timestamp;
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

  process(_connectionId: string): void {
    Logger.debug(`Ski event from ${this.playerId}: ${this.active}`);
  }
}

export class DeathEvent implements Event {
  type = 6;
  guaranteed = true;
  playerId: string;
  killerId: string | null;
  timestamp: number;

  constructor(playerId: string, killerId: string | null, timestamp: number) {
    this.playerId = playerId;
    this.killerId = killerId;
    this.timestamp = timestamp;
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

  process(_connectionId: string): void {
    Logger.debug(`Death event: ${this.playerId} killed by ${this.killerId}`);
  }
}

export class EventManager {
  private outgoingQueue: Map<string, Event[]> = new Map();
  private sequenceNumbers: Map<string, number> = new Map();
  private pendingEvents: Map<string, Map<number, Event>> = new Map();
  private maxWindowSize: number = 32;
  private onEventCallback: ((connectionId: string, event: Event) => void) | null = null;
  private onAckCallback: ((connectionId: string, seq: number) => void) | null = null;

  /**
   * Add an event to the outgoing queue for a specific connection
   */
  sendEvent(connectionId: string, event: Event): void {
    if (!this.outgoingQueue.has(connectionId)) {
      this.outgoingQueue.set(connectionId, []);
    }
    this.outgoingQueue.get(connectionId)!.push(event);
  }

  /**
   * Pack events into a packet stream for a specific connection
   * Returns the number of events packed
   */
  pack(connectionId: string, stream: BitStream, maxBytes: number): number {
    let packedCount = 0;
    const queue = this.outgoingQueue.get(connectionId);
    if (!queue) return 0;

    while (queue.length > 0 && stream.hasSpace(16)) {
      const event = queue.shift();
      if (!event) break;
      
      // Check if adding this event would exceed size limit
      const tempStream = new BitStream(64);
      this.packEventHeader(tempStream, event);
      event.pack(tempStream);
      
      const eventSize = tempStream.getByteLength();
      if (stream.getByteLength() + eventSize > maxBytes) {
        // Put event back if it doesn't fit
        queue.unshift(event);
        break;
      }

      // Get sequence number for this connection
      const seq = this.getSequenceNumber(connectionId);
      
      // Pack event type
      stream.writeInt(event.type, 8);
      
      // Pack sequence number
      stream.writeInt(seq, 16);
      
      // Pack guaranteed flag
      stream.writeBool(event.guaranteed);
      
      // Pack event data
      event.pack(stream);
      
      // Track guaranteed events
      if (event.guaranteed) {
        if (!this.pendingEvents.has(connectionId)) {
          this.pendingEvents.set(connectionId, new Map());
        }
        this.pendingEvents.get(connectionId)!.set(seq, event);
      }
      
      packedCount++;
    }

    return packedCount;
  }

  /**
   * Unpack events from a packet stream
   */
  unpack(connectionId: string, stream: BitStream): void {
    while (stream.hasData()) {
      // Check if we have enough data for event header (type: 8 bits, seq: 16 bits, guaranteed: 1 bit = 25 bits)
      if (!stream.hasSpace(25)) {
        Logger.warn(`Insufficient data for event header in packet from ${connectionId}`);
        break;
      }

      const type = stream.readInt(8);
      const seq = stream.readInt(16);
      const guaranteed = stream.readBool();

      const event = this.createEvent(type);
      if (!event) {
        Logger.warn(`Unknown event type ${type} from ${connectionId}, skipping remaining data`);
        break;
      }

      // Save current position to rollback if unpack fails
      const savedPosition = stream.getBitPosition();

      try {
        event.unpack(stream);
        event.guaranteed = guaranteed;

        if (guaranteed) {
          // Process guaranteed events immediately on server
          event.process(connectionId);
          // Call callback for event processing
          if (this.onEventCallback) {
            this.onEventCallback(connectionId, event);
          }
          this.sendAck(connectionId, seq);
        } else {
          // Process non-guaranteed events immediately
          event.process(connectionId);
          // Call callback for event processing
          if (this.onEventCallback) {
            this.onEventCallback(connectionId, event);
          }
        }
      } catch (error) {
        // Rollback on unpack error and skip this packet
        Logger.warn(`Failed to unpack event type ${type} from ${connectionId}: ${error}`);
        stream.setBitPosition(savedPosition);
        break;
      }
    }
  }

  /**
   * Handle ACK for a guaranteed event
   */
  handleAck(connectionId: string, seq: number): void {
    const pending = this.pendingEvents.get(connectionId);
    if (pending) {
      pending.delete(seq);
    }
  }

  /**
   * Handle packet loss notification
   * Retransmit guaranteed events that were in the lost packet
   */
  handlePacketLoss(connectionId: string): void {
    const pending = this.pendingEvents.get(connectionId);
    if (pending) {
      const queue = this.outgoingQueue.get(connectionId);
      if (queue) {
        for (const [seq, event] of pending) {
          queue.unshift(event);
          pending.delete(seq);
        }
      }
    }
  }

  /**
   * Send ACK for a guaranteed event
   */
  private sendAck(connectionId: string, seq: number): void {
    // ACK is sent through the connection layer via StreamManager
    // StreamManager will collect ACKs and send them in packets
    if (this.onAckCallback) {
      this.onAckCallback(connectionId, seq);
    }
  }

  /**
   * Set callback for ACK transmission
   */
  setAckCallback(callback: ((connectionId: string, seq: number) => void) | null): void {
    this.onAckCallback = callback;
  }

  /**
   * Get next sequence number for a connection
   */
  private getSequenceNumber(connectionId: string): number {
    if (!this.sequenceNumbers.has(connectionId)) {
      this.sequenceNumbers.set(connectionId, 0);
    }
    const seq = this.sequenceNumbers.get(connectionId)!;
    this.sequenceNumbers.set(connectionId, seq + 1);
    return seq;
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
        Logger.warn(`Unknown event type: ${type}`);
        return null;
    }
  }

  /**
   * Get number of pending guaranteed events for a connection
   */
  getPendingCount(connectionId: string): number {
    const pending = this.pendingEvents.get(connectionId);
    return pending ? pending.size : 0;
  }

  /**
   * Get number of events in outgoing queue for a connection
   */
  getQueueCount(connectionId: string): number {
    const queue = this.outgoingQueue.get(connectionId);
    return queue ? queue.length : 0;
  }

  /**
   * Check if window is full for a connection
   */
  isWindowFull(connectionId: string): boolean {
    return this.getPendingCount(connectionId) >= this.maxWindowSize;
  }

  /**
   * Remove a connection (cleanup)
   */
  removeConnection(connectionId: string): void {
    this.outgoingQueue.delete(connectionId);
    this.sequenceNumbers.delete(connectionId);
    this.pendingEvents.delete(connectionId);
  }

  /**
   * Set callback for event processing
   */
  onEvent(callback: ((connectionId: string, event: Event) => void) | null): void {
    this.onEventCallback = callback;
  }

  /**
   * Reset the event manager
   */
  reset(): void {
    this.outgoingQueue.clear();
    this.sequenceNumbers.clear();
    this.pendingEvents.clear();
  }
}
