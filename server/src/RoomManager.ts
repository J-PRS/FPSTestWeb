/**
 * Room management for grouping players
 * Supports multiple rooms/lobbies with different game modes
 */

import { PlayerState } from './types.js';

export interface Room {
  id: string;
  name: string;
  maxPlayers: number;
  players: Map<string, PlayerState>;
  createdAt: number;
  gameMode: 'deathmatch' | 'team' | 'free';
}

export class RoomManager {
  private rooms: Map<string, Room> = new Map();
  private playerToRoom: Map<string, string> = new Map();

  /**
   * Create a new room
   */
  createRoom(roomId: string, name: string, maxPlayers: number = 16, gameMode: 'deathmatch' | 'team' | 'free' = 'deathmatch'): Room {
    const room: Room = {
      id: roomId,
      name,
      maxPlayers,
      players: new Map(),
      createdAt: Date.now(),
      gameMode
    };
    this.rooms.set(roomId, room);
    return room;
  }

  /**
   * Get a room by ID
   */
  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  /**
   * Get all rooms
   */
  getAllRooms(): Room[] {
    return Array.from(this.rooms.values());
  }

  /**
   * Get room a player is in
   */
  getPlayerRoom(playerId: string): Room | undefined {
    const roomId = this.playerToRoom.get(playerId);
    return roomId ? this.rooms.get(roomId) : undefined;
  }

  /**
   * Add player to a room
   */
  addPlayerToRoom(playerId: string, playerState: PlayerState, roomId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) {
      return false;
    }

    if (room.players.size >= room.maxPlayers) {
      return false;
    }

    room.players.set(playerId, playerState);
    this.playerToRoom.set(playerId, roomId);
    return true;
  }

  /**
   * Remove player from their current room
   */
  removePlayerFromRoom(playerId: string): boolean {
    const roomId = this.playerToRoom.get(playerId);
    if (!roomId) {
      return false;
    }

    const room = this.rooms.get(roomId);
    if (room) {
      room.players.delete(playerId);
    }

    this.playerToRoom.delete(playerId);

    // Delete room if empty, but keep default room
    if (room && room.players.size === 0 && roomId !== 'default') {
      this.rooms.delete(roomId);
    }

    return true;
  }

  /**
   * Get available rooms (not full)
   */
  getAvailableRooms(): Room[] {
    return this.getAllRooms().filter(room => room.players.size < room.maxPlayers);
  }

  /**
   * Get room player count
   */
  getRoomPlayerCount(roomId: string): number {
    const room = this.rooms.get(roomId);
    return room ? room.players.size : 0;
  }

  /**
   * Broadcast to all players in a room
   */
  broadcastToRoom(roomId: string, message: any, excludePlayerId?: string): void {
    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }

    const data = JSON.stringify(message);
    for (const [playerId, player] of room.players) {
      if (playerId !== excludePlayerId && !player.disconnected) {
        player.ws.send(data);
      }
    }
  }

  /**
   * Get players in a room
   */
  getRoomPlayers(roomId: string): Map<string, PlayerState> {
    const room = this.rooms.get(roomId);
    return room ? room.players : new Map();
  }
}
