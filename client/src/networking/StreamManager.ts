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
    
    // Sequence number (2 bytes)
    stream.writeInt(0, 16); // TODO: Track packet sequence
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
    
    // 1. Move Manager
    this.moveManager.unpack(stream);
    
    // 2. Event Manager
    this.eventManager.unpack(stream);
    
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
