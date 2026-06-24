/**
 * Move Manager - Input and control object synchronization (Server)
 * Based on Tribes 2 networking model
 * 
 * Guarantees "soonest possible" delivery of client input moves
 * Validates moves authoritatively
 * Sends control object state to client
 */

import { BitStream } from './BitStream.js';

export interface Move {
  sequence: number;
  timestamp: number;
  input: {
    forward: number; // -127 to 127
    right: number; // -127 to 127
    jump: number; // 0 or 1
    ski: number; // 0 or 1
  };
  rotation: {
    yaw: number;
    pitch: number;
  };
}

export class MoveManager {
  private moves: Map<string, Move[]> = new Map(); // connectionId -> moves
  private lastProcessedSequences: Map<string, number> = new Map();
  private maxWindowSize: number = 32;
  private onMoveCallback: ((connectionId: string, move: Move) => void) | null = null;

  /**
   * Add a move for a connection
   */
  addMove(connectionId: string, move: Move): void {
    if (!this.moves.has(connectionId)) {
      this.moves.set(connectionId, []);
    }
    
    const connectionMoves = this.moves.get(connectionId)!;
    connectionMoves.push(move);
    
    // Limit window size
    if (connectionMoves.length > this.maxWindowSize) {
      connectionMoves.shift();
    }
  }

  /**
   * Pack moves into a packet stream for a connection
   * Sends last 3 moves (like Tribes 2) for reliability
   */
  pack(connectionId: string, stream: BitStream): void {
    const connectionMoves = this.moves.get(connectionId);
    if (!connectionMoves || connectionMoves.length === 0) {
      stream.writeInt(0, 8); // No moves
      return;
    }

    // Send last 3 moves
    const recentMoves = connectionMoves.slice(-3);
    
    stream.writeInt(recentMoves.length, 8); // Number of moves
    
    for (const move of recentMoves) {
      stream.writeInt(move.sequence, 16);
      // Use relative timestamp to fit in 32 bits
      const relativeTimestamp = move.timestamp - (Date.now() - 60000);
      stream.writeInt(relativeTimestamp, 32);
      
      // Pack input
      stream.writeSignedInt(move.input.forward, 8);
      stream.writeSignedInt(move.input.right, 8);
      stream.writeInt(move.input.jump, 1);
      stream.writeInt(move.input.ski, 1);
      
      // Pack rotation (normalized to 0-1 range)
      stream.writeFloatRanged(move.rotation.yaw, -Math.PI, Math.PI, 16);
      stream.writeFloatRanged(move.rotation.pitch, -Math.PI / 2, Math.PI / 2, 16);
    }
  }

  /**
   * Unpack moves from a packet stream
   */
  unpack(connectionId: string, stream: BitStream): Move[] {
    const count = stream.readInt(8);
    const moves: Move[] = [];

    for (let i = 0; i < count; i++) {
      const seq = stream.readInt(16);
      const relativeTimestamp = stream.readInt(32);
      const timestamp = relativeTimestamp + (Date.now() - 60000);

      // Read input
      const forward = stream.readSignedInt(8);
      const right = stream.readSignedInt(8);
      const jump = stream.readInt(1);
      const ski = stream.readInt(1);

      // Read rotation
      const yaw = stream.readFloatRanged(-Math.PI, Math.PI, 16);
      const pitch = stream.readFloatRanged(-Math.PI / 2, Math.PI / 2, 16);

      const move: Move = {
        sequence: seq,
        timestamp,
        input: { forward, right, jump, ski },
        rotation: { yaw, pitch }
      };

      moves.push(move);
      this.addMove(connectionId, move);

      // Call callback for move processing
      if (this.onMoveCallback) {
        this.onMoveCallback(connectionId, move);
      }
    }

    return moves;
  }

  /**
   * Process moves for a connection
   * Returns the last processed sequence number
   */
  processMoves(connectionId: string, controlObject: any): number {
    const connectionMoves = this.moves.get(connectionId);
    if (!connectionMoves || connectionMoves.length === 0) {
      return this.lastProcessedSequences.get(connectionId) || 0;
    }

    let lastProcessed = this.lastProcessedSequences.get(connectionId) || 0;

    for (const move of connectionMoves) {
      // Validate move
      if (this.validateMove(move, controlObject)) {
        // Apply move to control object
        if (controlObject && controlObject.applyMove) {
          controlObject.applyMove(move);
        }
        lastProcessed = move.sequence;
      }
    }

    this.lastProcessedSequences.set(connectionId, lastProcessed);
    
    // Clear processed moves
    this.moves.set(connectionId, []);
    
    return lastProcessed;
  }

  /**
   * Validate a move
   * Returns true if move is valid
   */
  private validateMove(move: Move, _controlObject: any): boolean {
    // Basic validation
    if (move.input.forward < -127 || move.input.forward > 127) return false;
    if (move.input.right < -127 || move.input.right > 127) return false;
    if (move.input.jump < 0 || move.input.jump > 1) return false;
    if (move.input.ski < 0 || move.input.ski > 1) return false;
    
    // Rotation validation
    if (move.rotation.yaw < -Math.PI || move.rotation.yaw > Math.PI) return false;
    if (move.rotation.pitch < -Math.PI / 2 || move.rotation.pitch > Math.PI / 2) return false;
    
    // Additional validation can be added here
    // e.g., speed limits, position validation, etc.
    
    return true;
  }

  /**
   * Pack control object state for a connection
   * This is sent in every packet for "soonest possible" delivery
   */
  packControlState(connectionId: string, stream: BitStream, controlObject: any): void {
    if (!controlObject) return;

    // Write marker byte (0xFF) to indicate control state follows
    stream.writeInt(0xFF, 8);

    // Pack position
    if (controlObject.position) {
      stream.writeFloat32(controlObject.position.x);
      stream.writeFloat32(controlObject.position.y);
      stream.writeFloat32(controlObject.position.z);
    }

    // Pack rotation
    if (controlObject.rotation) {
      stream.writeFloatRanged(controlObject.rotation.yaw, -Math.PI, Math.PI, 16);
      stream.writeFloatRanged(controlObject.rotation.pitch, -Math.PI / 2, Math.PI / 2, 16);
    }

    // Pack velocity
    if (controlObject.velocity) {
      stream.writeFloat32(controlObject.velocity.x);
      stream.writeFloat32(controlObject.velocity.y);
      stream.writeFloat32(controlObject.velocity.z);
    }

    // Pack last processed sequence
    const lastSeq = this.lastProcessedSequences.get(connectionId) || 0;
    stream.writeInt(lastSeq, 16);
  }

  /**
   * Get the last processed sequence for a connection
   */
  getLastProcessedSequence(connectionId: string): number {
    return this.lastProcessedSequences.get(connectionId) || 0;
  }

  /**
   * Get number of pending moves for a connection
   */
  getPendingCount(connectionId: string): number {
    const connectionMoves = this.moves.get(connectionId);
    return connectionMoves ? connectionMoves.length : 0;
  }

  /**
   * Check if window is full for a connection
   */
  isWindowFull(connectionId: string): boolean {
    return this.getPendingCount(connectionId) >= this.maxWindowSize;
  }

  /**
   * Remove a connection
   */
  removeConnection(connectionId: string): void {
    this.moves.delete(connectionId);
    this.lastProcessedSequences.delete(connectionId);
  }

  /**
   * Set callback for move processing
   */
  onMove(callback: ((connectionId: string, move: Move) => void) | null): void {
    this.onMoveCallback = callback;
  }

  /**
   * Reset the move manager
   */
  reset(): void {
    this.moves.clear();
    this.lastProcessedSequences.clear();
  }
}
