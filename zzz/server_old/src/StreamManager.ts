/**
 * Stream Manager - Coordinates all stream managers (Server)
 * Based on Tribes 2 networking model
 *
 * Allocates packets and coordinates Event, Ghost, and Move managers
 * Manages bandwidth and packet transmission per connection
 */

import { BitStream } from './BitStream.js';
import { EventManager } from './EventManager.js';
import { GhostManager } from './GhostManager.js';
import { MoveManager } from './MoveManager.js';
import { Logger } from './Logger.js';

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
  private packetTimers: Map<string, any> = new Map();
  private onSendPacket: (connectionId: string, data: Uint8Array) => void;
  private startTime: number = Date.now(); // For relative timestamps
  private sequenceNumbers: Map<string, number> = new Map(); // Per-connection sequence tracking
  private getControlObject: ((connectionId: string) => any) | null = null;
  private pendingAcks: Map<string, number[]> = new Map(); // ACKs to send per connection
  private joinHandshakeComplete: Map<string, boolean> = new Map(); // Track join handshake per connection

  constructor(
    eventManager: EventManager,
    ghostManager: GhostManager,
    moveManager: MoveManager,
    config: StreamConfig,
    onSendPacket: (connectionId: string, data: Uint8Array) => void
  ) {
    this.eventManager = eventManager;
    this.ghostManager = ghostManager;
    this.moveManager = moveManager;
    this.config = config;
    this.onSendPacket = onSendPacket;
    this.packetInterval = 1000 / config.packetsPerSecond;

    // Wire up ACK callback from EventManager (deferred to avoid circular issues)
    setTimeout(() => {
      this.eventManager.setAckCallback((connectionId: string, seq: number) => {
        this.collectAck(connectionId, seq);
      });
    }, 0);
  }

  /**
   * Set callback to get control object for a connection
   */
  setControlObjectProvider(callback: ((connectionId: string) => any) | null): void {
    this.getControlObject = callback;
  }

  /**
   * Collect ACK for transmission
   */
  private collectAck(connectionId: string, seq: number): void {
    if (!this.pendingAcks.has(connectionId)) {
      this.pendingAcks.set(connectionId, []);
    }
    const acks = this.pendingAcks.get(connectionId)!;
    if (!acks.includes(seq)) {
      acks.push(seq);
    }
  }

  /**
   * Mark join handshake as complete for a connection
   */
  markJoinHandshakeComplete(connectionId: string): void {
    this.joinHandshakeComplete.set(connectionId, true);
  }

  /**
   * Start the packet transmission loop for a connection
   */
  startConnection(connectionId: string): void {
    if (this.packetTimers.has(connectionId)) {
      this.stopConnection(connectionId);
    }

    const timer = setInterval(() => {
      this.sendPacket(connectionId);
    }, this.packetInterval);
    
    this.packetTimers.set(connectionId, timer);
  }

  /**
   * Stop the packet transmission loop for a connection
   */
  stopConnection(connectionId: string): void {
    const timer = this.packetTimers.get(connectionId);
    if (timer) {
      clearInterval(timer);
      this.packetTimers.delete(connectionId);
    }
  }

  /**
   * Send a packet for a specific connection
   */
  sendPacket(connectionId: string): void {
    // Don't send binary packets until join handshake is complete
    if (!this.joinHandshakeComplete.get(connectionId)) {
      return;
    }

    const stream = new BitStream(this.config.maxPacketSize);

    // Pack message header
    this.packHeader(stream, connectionId);

    // Pack managers in priority order
    // 1. Move Manager (highest priority - input)
    this.moveManager.pack(connectionId, stream);

    // 1.5. Control State (for client-side prediction)
    if (this.getControlObject) {
      const controlObject = this.getControlObject(connectionId);
      if (controlObject) {
        this.moveManager.packControlState(connectionId, stream, controlObject);
      }
    }

    // 2. Event Manager (guaranteed events)
    this.eventManager.pack(connectionId, stream, this.config.maxPacketSize);

    // 2.5. ACKs (acknowledgments for guaranteed events)
    this.packAcks(connectionId, stream);

    // 3. Ghost Manager (state updates)
    this.ghostManager.pack(connectionId, stream, this.config.maxPacketSize);

    // Get the packet data
    const data = stream.getData();

    // Send the packet
    if (data.length > 0) {
      this.onSendPacket(connectionId, data);
    }
  }

  /**
   * Pack packet header
   */
  private packHeader(stream: BitStream, connectionId: string): void {
    // Message type (1 byte)
    stream.writeInt(1, 8); // Game data packet

    // Timestamp (4 bytes) - relative to start time to fit in 32 bits
    const relativeTime = Date.now() - this.startTime;
    stream.writeInt(relativeTime, 32);

    // Sequence number (2 bytes) - per-connection tracking
    const seq = this.sequenceNumbers.get(connectionId) || 0;
    stream.writeInt(seq, 16);
    this.sequenceNumbers.set(connectionId, (seq + 1) % 65536);
  }

  /**
   * Pack ACKs for a connection
   */
  private packAcks(connectionId: string, stream: BitStream): void {
    const acks = this.pendingAcks.get(connectionId);
    const ackCount = acks ? Math.min(acks.length, 255) : 0;

    // Always pack ACK count (1 byte) even if 0
    stream.writeInt(ackCount, 8);

    // Pack ACK sequence numbers (2 bytes each)
    for (let i = 0; i < ackCount; i++) {
      stream.writeInt(acks![i], 16);
    }

    // Clear sent ACKs
    this.pendingAcks.delete(connectionId);
  }

  /**
   * Unpack ACKs for a connection
   */
  private unpackAcks(connectionId: string, stream: BitStream): void {
    if (!stream.hasData()) return;

    // Check if we have enough data for ACK count (8 bits)
    if (!stream.hasSpace(8)) {
      Logger.warn(`Insufficient data for ACK count in packet from ${connectionId}`);
      return;
    }

    const ackCount = stream.readInt(8);

    // Check if we have enough data for all ACKs (each ACK is 16 bits)
    const acksBitsNeeded = ackCount * 16;
    if (!stream.hasSpace(acksBitsNeeded)) {
      Logger.warn(`Insufficient data for ${ackCount} ACKs in packet from ${connectionId}, need ${acksBitsNeeded} bits`);
      return;
    }

    for (let i = 0; i < ackCount; i++) {
      const seq = stream.readInt(16);
      this.eventManager.handleAck(connectionId, seq);
    }
  }

  /**
   * Handle incoming packet for a connection
   */
  handlePacket(connectionId: string, data: Uint8Array): void {
    try {
      const stream = BitStream.fromBuffer(data);

      // Check if we have enough data for header (8 + 32 + 16 = 56 bits = 7 bytes)
      if (!stream.hasSpace(56)) {
        Logger.warn(`[StreamManager] Insufficient data for packet header from ${connectionId}, size: ${data.length} bytes`);
        return;
      }

      // Unpack header
      const messageType = stream.readInt(8);
      const timestamp = stream.readInt(32);
      const sequence = stream.readInt(16);

      const bitPosAfterHeader = stream.getBitPosition();

      if (messageType === 1) {
        // Game data packet
        this.handleGameDataPacket(connectionId, stream);
      }
    } catch (error) {
      // Catch any BitStream overflow or other parsing errors
      Logger.error(`Failed to handle packet from ${connectionId}: ${error}`);
      // Don't crash the server, just log and continue
    }
  }

  /**
   * Handle game data packet for a connection
   */
  private handleGameDataPacket(connectionId: string, stream: BitStream): void {
    // Read section sizes (4 sections, 16 bits each = 64 bits = 8 bytes)
    if (!stream.hasSpace(64)) {
      Logger.warn(`[StreamManager] Insufficient data for section sizes from ${connectionId}`);
      return;
    }

    const moveSizeBits = stream.readInt(16);
    const eventSizeBits = stream.readInt(16);
    const ackSizeBits = stream.readInt(16);
    const ghostSizeBits = stream.readInt(16);

    const bitPosBeforeMoves = stream.getBitPosition();

    // 1. Move Manager
    try {
      this.moveManager.unpack(connectionId, stream);
    } catch (error) {
      Logger.warn(`[StreamManager] Failed to unpack moves from ${connectionId}: ${error}`);
    }

    const bitPosAfterMoves = stream.getBitPosition();
    const actualMoveSizeBits = bitPosAfterMoves - bitPosBeforeMoves;

    if (actualMoveSizeBits !== moveSizeBits) {
      Logger.error(`[StreamManager] MoveManager size mismatch! Expected ${moveSizeBits} bits, got ${actualMoveSizeBits} bits`);
    }

    const bitPosBeforeEvents = stream.getBitPosition();

    // 2. Event Manager
    try {
      this.eventManager.unpack(connectionId, stream);
    } catch (error) {
      Logger.warn(`[StreamManager] Failed to unpack events from ${connectionId}: ${error}`);
    }

    const bitPosAfterEvents = stream.getBitPosition();
    const actualEventSizeBits = bitPosAfterEvents - bitPosBeforeEvents;

    if (actualEventSizeBits !== eventSizeBits) {
      Logger.error(`[StreamManager] EventManager size mismatch! Expected ${eventSizeBits} bits, got ${actualEventSizeBits} bits`);
    }

    // 2.5. ACKs (acknowledgments for guaranteed events)
    try {
      this.unpackAcks(connectionId, stream);
    } catch (error) {
      Logger.warn(`Failed to unpack ACKs from ${connectionId}: ${error}`);
    }

    // 3. Ghost Manager
    try {
      this.ghostManager.unpack(connectionId, stream);
    } catch (error) {
      Logger.warn(`Failed to unpack ghosts from ${connectionId}: ${error}`);
    }
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<StreamConfig>): void {
    this.config = { ...this.config, ...config };
    this.packetInterval = 1000 / this.config.packetsPerSecond;
    
    // Restart all timers
    for (const connectionId of this.packetTimers.keys()) {
      this.startConnection(connectionId);
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): StreamConfig {
    return { ...this.config };
  }

  /**
   * Get statistics for a connection
   */
  getStats(connectionId: string): {
    pendingEvents: number;
    queuedEvents: number;
    pendingMoves: number;
    ghostCount: number;
  } {
    return {
      pendingEvents: this.eventManager.getPendingCount(connectionId),
      queuedEvents: this.eventManager.getQueueCount(connectionId),
      pendingMoves: this.moveManager.getPendingCount(connectionId),
      ghostCount: this.ghostManager.getGhosts(connectionId).length,
    };
  }

  /**
   * Remove a connection
   */
  removeConnection(connectionId: string): void {
    this.stopConnection(connectionId);
    this.eventManager.removeConnection(connectionId);
    this.ghostManager.removeConnection(connectionId);
    this.moveManager.removeConnection(connectionId);
  }

  /**
   * Reset the stream manager
   */
  reset(): void {
    // Stop all timers
    for (const connectionId of this.packetTimers.keys()) {
      this.stopConnection(connectionId);
    }
    
    this.eventManager.reset();
    this.ghostManager.clear();
    this.moveManager.reset();
  }
}
