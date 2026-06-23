/**
 * Move Manager - Input and control object synchronization
 * Based on Tribes 2 networking model
 * 
 * Guarantees "soonest possible" delivery of client input moves to server
 * Sends moves multiple times for reliability
 * Handles client-side prediction
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
  private moves: Move[] = [];
  private sequenceNumber: number = 0;
  private lastProcessedSequence: number = 0;
  private moveHistory: Move[] = []; // For client prediction
  private maxHistorySize: number = 128;
  private moveInterval: number = 32; // 32ms (31.25 Hz)
  private onReconcileCallback: ((serverState: any, lastProcessedSequence: number) => void) | null = null;

  /**
   * Collect a move from input
   */
  collectMove(input: {
    forward: number;
    right: number;
    jump: number;
    ski: number;
  }, rotation: { yaw: number; pitch: number }): Move {
    const move: Move = {
      sequence: this.sequenceNumber++,
      timestamp: Date.now(),
      input: { ...input },
      rotation: { ...rotation }
    };

    this.moves.push(move);
    this.moveHistory.push(move);

    // Limit history size
    if (this.moveHistory.length > this.maxHistorySize) {
      this.moveHistory.shift();
    }

    return move;
  }

  /**
   * Pack moves into a packet stream
   * Sends last 3 moves (like Tribes 2) for reliability
   */
  pack(stream: BitStream): void {
    // Send last 3 moves
    const recentMoves = this.moves.slice(-3);
    
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
   * Unpack moves from a packet stream (server confirmation)
   */
  unpack(stream: BitStream): void {
    const count = stream.readInt(8);
    
    for (let i = 0; i < count; i++) {
      const seq = stream.readInt(16);
      const timestamp = stream.readInt(32);
      
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
      
      // Update last processed sequence
      this.lastProcessedSequence = Math.max(this.lastProcessedSequence, seq);
    }
  }

  /**
   * Unpack server control state from a packet stream
   * This is the authoritative state from the server for client-side prediction
   */
  unpackControlState(stream: BitStream): void {
    // Read position
    const position = {
      x: stream.readFloat32(),
      y: stream.readFloat32(),
      z: stream.readFloat32()
    };

    // Read rotation
    const rotation = {
      yaw: stream.readFloatRanged(-Math.PI, Math.PI, 16),
      pitch: stream.readFloatRanged(-Math.PI / 2, Math.PI / 2, 16)
    };

    // Read velocity
    const velocity = {
      x: stream.readFloat32(),
      y: stream.readFloat32(),
      z: stream.readFloat32()
    };

    // Read last processed sequence
    const lastProcessedSeq = stream.readInt(16);

    // Update last processed sequence
    this.lastProcessedSequence = lastProcessedSeq;

    // Call reconciliation callback if set
    if (this.onReconcileCallback) {
      this.onReconcileCallback(
        { position, rotation, velocity },
        lastProcessedSeq
      );
    }
  }

  /**
   * Apply move locally for client-side prediction
   */
  predictMove(move: Move, controlObject: any): void {
    // Apply move to control object for immediate response
    if (controlObject && controlObject.movement) {
      // Convert move input to MovementController format
      controlObject.movement.setInput({
        forward: move.input.forward / 127, // Convert -127..127 to -1..1
        right: move.input.right / 127,
        jumpPressed: move.input.jump === 1,
        jumpHeld: move.input.jump === 1,
        skiHeld: move.input.ski === 1
      });
      controlObject.movement.update(0.033); // Simulate one frame (~30Hz)
    }
  }

  /**
   * Reconcile with server state
   * Removes old moves from history and re-applies pending moves
   */
  reconcile(serverLastSequence: number, serverState: any, controlObject: any): void {
    // Remove moves that server has processed
    this.moveHistory = this.moveHistory.filter(m => m.sequence > serverLastSequence);

    // If server state differs significantly, snap to server
    if (controlObject && controlObject.pos && serverState.position) {
      const distance = this.calculateDistance(
        { position: { x: controlObject.pos.x, y: controlObject.pos.y, z: controlObject.pos.z } },
        serverState
      );
      if (distance > 1.0) { // Threshold for snapping
        // Snap to server state
        controlObject.pos.set(serverState.position.x, serverState.position.y, serverState.position.z);
        if (serverState.velocity) {
          controlObject.vel.set(serverState.velocity.x, serverState.velocity.y, serverState.velocity.z);
        }
        if (serverState.rotation) {
          controlObject.yaw = serverState.rotation.yaw;
          controlObject.pitch = serverState.rotation.pitch;
        }

        // Re-apply all pending moves
        for (const move of this.moveHistory) {
          this.predictMove(move, controlObject);
        }
      }
    }
  }

  /**
   * Calculate distance between two states
   */
  private calculateDistance(state1: any, state2: any): number {
    if (!state1.position || !state2.position) return 0;
    
    const dx = state1.position.x - state2.position.x;
    const dy = state1.position.y - state2.position.y;
    const dz = state1.position.z - state2.position.z;
    
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Get the last processed sequence number
   */
  getLastProcessedSequence(): number {
    return this.lastProcessedSequence;
  }

  /**
   * Get move history for prediction
   */
  getMoveHistory(): Move[] {
    return [...this.moveHistory];
  }

  /**
   * Clear pending moves
   */
  clearMoves(): void {
    this.moves = [];
  }

  /**
   * Reset the move manager
   */
  reset(): void {
    this.moves = [];
    this.sequenceNumber = 0;
    this.lastProcessedSequence = 0;
    this.moveHistory = [];
  }

  /**
   * Check if window is full
   */
  isWindowFull(): boolean {
    return this.moves.length >= 32;
  }

  /**
   * Get number of pending moves
   */
  getPendingCount(): number {
    return this.moves.length;
  }

  /**
   * Set callback for server state reconciliation
   */
  onReconcile(callback: ((serverState: any, lastProcessedSequence: number) => void) | null): void {
    this.onReconcileCallback = callback;
  }
}
