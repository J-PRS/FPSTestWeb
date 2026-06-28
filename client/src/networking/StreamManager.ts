/**
 * Stream Manager - Coordinates all stream managers
 * Based on Tribes 2 networking model
 * 
 * Allocates packets and coordinates Event, Ghost, and Move managers
 * Manages bandwidth and packet transmission
 */

import { BitStream } from './BitStream.js';
import { EventManager } from './EventManager.js';
import { GhostManager } from './GhostManager.js';
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
  public onGhostsUpdate: ((ghosts: any[]) => void) | null = null;
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

    // Reserve space for section sizes (will write after packing)
    const sectionSizesPos = stream.getBitPosition();
    stream.writeInt(0, 16); // MoveManager size (bytes)
    stream.writeInt(0, 16); // EventManager size (bytes)
    stream.writeInt(0, 16); // ACK size (bytes)
    stream.writeInt(0, 16); // GhostManager size (bytes)

    const bitPosBeforeMoves = stream.getBitPosition();

    // Pack managers in priority order
    // 1. Move Manager (highest priority - input)
    this.moveManager.pack(stream);

    const bitPosAfterMoves = stream.getBitPosition();

    // 2. Event Manager (guaranteed events)
    this.eventManager.pack(stream, this.config.maxPacketSize);

    const bitPosAfterEvents = stream.getBitPosition();

    // 2.5. ACKs (acknowledgments for guaranteed events)
    this.packAcks(stream);

    const bitPosAfterAcks = stream.getBitPosition();

    // 3. Ghost Manager (state updates)
    this.ghostManager.pack(stream, this.config.maxPacketSize);

    // Write section sizes (in bits)
    const currentBitPos = stream.getBitPosition();
    stream.setBitPosition(sectionSizesPos);

    const moveSizeBits = bitPosAfterMoves - bitPosBeforeMoves;
    const eventSizeBits = bitPosAfterEvents - bitPosAfterMoves;
    const ackSizeBits = bitPosAfterAcks - bitPosAfterEvents;
    const ghostSizeBits = currentBitPos - bitPosAfterAcks;

    stream.writeInt(moveSizeBits, 16);
    stream.writeInt(eventSizeBits, 16);
    stream.writeInt(ackSizeBits, 16);
    stream.writeInt(ghostSizeBits, 16);

    stream.setBitPosition(currentBitPos);

    // Log for debugging
    if (Math.random() < 0.01) { // 1% chance to log
      console.log(`[StreamManager] Section sizes (bits): moves=${moveSizeBits}, events=${eventSizeBits}, acks=${ackSizeBits}, ghosts=${ghostSizeBits}`);
    }

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
    const ackCount = Math.min(this.pendingAcks.length, 255);

    // Always pack ACK count (1 byte) even if 0
    stream.writeInt(ackCount, 8);

    // Pack ACK sequence numbers (2 bytes each)
    for (let i = 0; i < ackCount; i++) {
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

    // Check if we have enough data for ACK count (8 bits)
    if (!stream.hasSpace(8)) {
      console.warn('[StreamManager] Insufficient data for ACK count');
      return;
    }

    const ackCount = stream.readInt(8);

    // Check if we have enough data for all ACKs (each ACK is 16 bits)
    const acksBitsNeeded = ackCount * 16;
    if (!stream.hasSpace(acksBitsNeeded)) {
      console.warn(`[StreamManager] Insufficient data for ${ackCount} ACKs, need ${acksBitsNeeded} bits`);
      return;
    }

    for (let i = 0; i < ackCount; i++) {
      const seq = stream.readInt(16);
      this.eventManager.handleAck(seq);
    }
  }

  /**
   * Handle incoming packet
   */
  handlePacket(data: Uint8Array): void {
    try {
      const stream = BitStream.fromBuffer(data);

      // Check if we have enough data for header (8 + 32 + 16 = 56 bits = 7 bytes)
      if (!stream.hasSpace(56)) {
        console.warn(`[StreamManager] Insufficient data for packet header, packet size: ${data.length} bytes`);
        return;
      }

      // Unpack header
      const messageType = stream.readInt(8);
      stream.readInt(32); // timestamp - unused
      stream.readInt(16); // sequence - unused

      if (messageType === 1) {
        // Game data packet
        this.handleGameDataPacket(stream);
      }
    } catch (error) {
      console.error('[StreamManager] Failed to handle packet:', error);
    }
  }

  /**
   * Handle game data packet
   */
  private handleGameDataPacket(stream: BitStream): void {
    // Unpack in the same order as packing

    // 1. Move Manager (moves + control state)
    try {
      this.moveManager.unpack(stream);
    } catch (error) {
      console.warn('[StreamManager] Failed to unpack moves:', error);
    }

    // Check if there's control state data (server sends this after moves)
    // Only unpack if we have enough data for control state (position + rotation = 3 floats = 96 bits)
    if (stream.hasData() && stream.hasSpace(96)) {
      try {
        this.moveManager.unpackControlState(stream);
      } catch (error) {
        console.warn('[StreamManager] Failed to unpack control state:', error);
      }
    }

    // 2. Event Manager
    try {
      this.eventManager.unpack(stream);
      this.eventManager.processOrderedQueue(); // Process guaranteed events in order
    } catch (error) {
      console.warn('[StreamManager] Failed to unpack events:', error);
    }

    // 2.5. ACKs (acknowledgments for guaranteed events)
    try {
      this.unpackAcks(stream);
    } catch (error) {
      console.warn('[StreamManager] Failed to unpack ACKs:', error);
    }

    // 3. Ghost Manager
    try {
      this.ghostManager.unpack(stream);
      // Sync ghosts to players Map for getPlayers()
      const ghosts = this.ghostManager.getAllGhosts();
      this.onGhostsUpdate?.(ghosts);
    } catch (error) {
      console.warn('[StreamManager] Failed to unpack ghosts:', error);
    }
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
