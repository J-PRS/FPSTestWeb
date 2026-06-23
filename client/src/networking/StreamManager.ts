/**
 * Stream Manager - Coordinates all stream managers
 * Based on Tribes 2 networking model
 * 
 * Allocates packets and coordinates Event, Ghost, and Move managers
 * Manages bandwidth and packet transmission
 */

import { BitStream } from './BitStream.js';
import { EventManager, Event } from './EventManager.js';
import { GhostManager, ScopeManager } from './GhostManager.js';
import { MoveManager } from './MoveManager.js';

export interface StreamConfig {
  maxPacketSize: number;
  packetsPerSecond: number;
  maxBytesPerSecond: number;
}

export class StreamManager {
  private eventManager: EventManager;
  private ghostManager: GhostManager;
  private moveManager: MoveManager;
  private config: StreamConfig;
  private packetInterval: number;
  private packetTimer: number | null = null;
  private onSendPacket: (data: Uint8Array) => void;
  private startTime: number = Date.now(); // For relative timestamps
  private sequenceNumber: number = 0; // Packet sequence tracking
  private pendingAcks: number[] = []; // ACKs to send

  constructor(
    eventManager: EventManager,
    ghostManager: GhostManager,
    moveManager: MoveManager,
    config: StreamConfig,
    onSendPacket: (data: Uint8Array) => void
  ) {
    this.eventManager = eventManager;
    this.ghostManager = ghostManager;
    this.moveManager = moveManager;
    this.config = config;
    this.onSendPacket = onSendPacket;
    this.packetInterval = 1000 / config.packetsPerSecond;

    // Wire up ACK callback from EventManager
    this.eventManager.setAckCallback((seq: number) => {
      this.collectAck(seq);
    });
  }

  /**
   * Start the packet transmission loop
   */
  start(): void {
    if (this.packetTimer) {
      this.stop();
    }

    this.packetTimer = setInterval(() => {
      this.sendPacket();
    }, this.packetInterval);
  }

  /**
   * Collect ACK for transmission
   */
  private collectAck(seq: number): void {
    if (!this.pendingAcks.includes(seq)) {
      this.pendingAcks.push(seq);
    }
  }

  /**
   * Stop the packet transmission loop
   */
  stop(): void {
    if (this.packetTimer) {
      clearInterval(this.packetTimer);
      this.packetTimer = null;
    }
  }

  /**
   * Send a packet
   */
  private sendPacket(): void {
    const stream = new BitStream(this.config.maxPacketSize);
    
    // Pack message header
    this.packHeader(stream);
    
    // Pack managers in priority order
    // 1. Move Manager (highest priority - input)
    this.moveManager.pack(stream);
    
    // 2. Event Manager (guaranteed events)
    this.eventManager.pack(stream, this.config.maxPacketSize);

    // 2.5. ACKs (acknowledgments for guaranteed events)
    this.packAcks(stream);

    // 3. Ghost Manager (state updates)
    this.ghostManager.pack(stream, this.config.maxPacketSize);
    
    // Get the packet data
    const data = stream.getData();
    
    // Send the packet
    if (data.length > 0) {
      this.onSendPacket(data);
    }
  }

  /**
   * Pack packet header
   */
  private packHeader(stream: BitStream): void {
    // Message type (1 byte)
    stream.writeInt(1, 8); // Game data packet

    // Timestamp (4 bytes) - relative to start time to fit in 32 bits
    const relativeTime = Date.now() - this.startTime;
    stream.writeInt(relativeTime, 32);

    // Sequence number (2 bytes) - wraps at 65535
    stream.writeInt(this.sequenceNumber, 16);
    this.sequenceNumber = (this.sequenceNumber + 1) % 65536;
  }

  /**
   * Pack ACKs
   */
  private packAcks(stream: BitStream): void {
    if (this.pendingAcks.length === 0) return;

    // Pack ACK count (1 byte)
    stream.writeInt(Math.min(this.pendingAcks.length, 255), 8);

    // Pack ACK sequence numbers (2 bytes each)
    for (let i = 0; i < Math.min(this.pendingAcks.length, 255); i++) {
      stream.writeInt(this.pendingAcks[i], 16);
    }

    // Clear sent ACKs
    this.pendingAcks = [];
  }

  /**
   * Unpack ACKs
   */
  private unpackAcks(stream: BitStream): void {
    if (!stream.hasData()) return;

    const ackCount = stream.readInt(8);
    for (let i = 0; i < ackCount; i++) {
      const seq = stream.readInt(16);
      this.eventManager.handleAck(seq);
    }
  }

  /**
   * Handle incoming packet
   */
  handlePacket(data: Uint8Array): void {
    const stream = BitStream.fromBuffer(data);
    
    // Unpack header
    const messageType = stream.readInt(8);
    const timestamp = stream.readInt(32);
    const sequence = stream.readInt(16);
    
    if (messageType === 1) {
      // Game data packet
      this.handleGameDataPacket(stream);
    }
  }

  /**
   * Handle game data packet
   */
  private handleGameDataPacket(stream: BitStream): void {
    // Unpack in the same order as packing
    
    // 1. Move Manager (moves + control state)
    this.moveManager.unpack(stream);
    
    // Check if there's control state data (server sends this after moves)
    if (stream.hasData()) {
      // Control state is sent as a separate block after moves
      // Check if next byte indicates control state (marker)
      const marker = stream.readInt(8);
      if (marker === 0xFF) {
        this.moveManager.unpackControlState(stream);
      } else {
        // Not a control state marker, rewind and continue
        stream.setBitPosition(stream.getBitPosition() - 8);
      }
    }
    
    // 2. Event Manager
    this.eventManager.unpack(stream);
    this.eventManager.processOrderedQueue(); // Process guaranteed events in order

    // 2.5. ACKs (acknowledgments for guaranteed events)
    this.unpackAcks(stream);

    // 3. Ghost Manager
    this.ghostManager.unpack(stream);
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<StreamConfig>): void {
    this.config = { ...this.config, ...config };
    this.packetInterval = 1000 / this.config.packetsPerSecond;
    
    // Restart timer if running
    if (this.packetTimer) {
      this.start();
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): StreamConfig {
    return { ...this.config };
  }

  /**
   * Get statistics
   */
  getStats(): {
    pendingEvents: number;
    queuedEvents: number;
    pendingMoves: number;
    ghostCount: number;
  } {
    return {
      pendingEvents: this.eventManager.getPendingCount(),
      queuedEvents: this.eventManager.getQueueCount(),
      pendingMoves: this.moveManager.getPendingCount(),
      ghostCount: this.ghostManager.getAllGhosts().length,
    };
  }
}
