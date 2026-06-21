import { WebSocketServer, WebSocket } from 'ws';
import { decodePosition, decodeInput, decodeShot, MessageType } from './BinaryProtocol.js';

/**
 * Three.js FPS Game Server
 * Uses ws library for WebSocket communication
 * Implements basic room-based multiplayer
 */

const PORT = 8095;
const TICK_RATE = 15; // 15Hz = 67ms per tick
const TICK_INTERVAL = 1000 / TICK_RATE;

interface PlayerState {
  ws: WebSocket;
  position: { x: number; y: number; z: number };
  rotation: { yaw: number; pitch: number };
  velocity: { x: number; y: number; z: number };
  lastProcessedSequence: number;
  health: number;
  isDead: boolean;
  respawnTime: number | null;
  disconnected: boolean;
  disconnectTime: number | null;
  playerLeftBroadcasted: boolean;
  lastUpdateTime: number;
}

interface Projectile {
  id: string;
  ownerId: string;
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  createdAt: number;
}

interface PositionSnapshot {
  timestamp: number;
  position: { x: number; y: number; z: number };
  rotation: { yaw: number; pitch: number };
}

// Game state
const players = new Map<string, PlayerState>();
const rewindBuffer = new Map<string, PositionSnapshot[]>();
const wsToPlayerId = new Map<WebSocket, string>(); // O(1) lookup for broadcast
const projectiles = new Map<string, Projectile>();
let projectileIdCounter = 0;

// WebSocket server
const wss = new WebSocketServer({ port: PORT });

console.log(`[Server] Starting on port ${PORT} with ${TICK_RATE}Hz tick rate`);

wss.on('connection', (ws: WebSocket) => {
  // Store WebSocket temporarily until we receive join message with player ID
  wsToPlayerId.set(ws, ''); // empty string means not yet identified
  console.log('[Server] New WebSocket connection, waiting for join message');

  ws.on('message', (data: Buffer) => {
    try {
      // Check if binary message (first byte is message type)
      const firstByte = data[0];
      if (firstByte >= 0 && firstByte <= 10) {
        // Binary message - requires playerId from wsToPlayerId
        const playerId = wsToPlayerId.get(ws);
        if (!playerId) {
          console.warn('[Server] Received binary message before join');
          return;
        }
        const uint8Array = new Uint8Array(data);
        handleBinaryMessage(playerId, uint8Array);
      } else {
        // JSON message (for control messages like join)
        const message = JSON.parse(data.toString());
        
        // Handle join message specially to establish playerId
        if (message.type === 'join') {
          const playerId = message.playerId;
          console.log(`[Server] Join message from: ${playerId}`);
          
          // Check if reconnecting
          const existingPlayer = players.get(playerId);
          if (existingPlayer && existingPlayer.disconnected) {
            // Reconnecting player - restore state
            console.log(`[Server] Player ${playerId} reconnecting, restoring state`);
            existingPlayer.ws = ws;
            existingPlayer.disconnected = false;
            existingPlayer.disconnectTime = null;
            existingPlayer.lastUpdateTime = Date.now();
            wsToPlayerId.set(ws, playerId);
            
            // Re-initialize rewind buffer
            rewindBuffer.set(playerId, []);
            
            // Send current state back to player
            const otherPlayers = Array.from(players.entries())
              .filter(([id]) => id !== playerId)
              .map(([id, data]) => ({
                playerId: id,
                position: data.position,
                rotation: data.rotation,
                timestamp: Date.now()
              }));
            
            console.log(`[Server] Sending gameState to reconnecting player ${playerId}:`, {
              otherPlayersCount: otherPlayers.length,
              otherPlayers,
              yourState: {
                position: existingPlayer.position,
                rotation: existingPlayer.rotation,
                health: existingPlayer.health,
                isDead: existingPlayer.isDead
              }
            });
            
            ws.send(JSON.stringify({
              type: 'gameState',
              players: otherPlayers,
              yourPlayerId: playerId,
              yourState: {
                position: existingPlayer.position,
                rotation: existingPlayer.rotation,
                health: existingPlayer.health,
                isDead: existingPlayer.isDead
              }
            }));
            
            // Notify other players that player rejoined
            broadcastToAll({
              type: 'playerJoined',
              playerId
            }, playerId);
          } else {
            // New player - initialize state
            players.set(playerId, {
              ws,
              position: { x: 0, y: 0, z: 0 },
              rotation: { yaw: 0, pitch: 0 },
              velocity: { x: 0, y: 0, z: 0 },
              lastProcessedSequence: 0,
              health: 100,
              isDead: false,
              respawnTime: null,
              disconnected: false,
              disconnectTime: null,
              playerLeftBroadcasted: false,
              lastUpdateTime: Date.now()
            });

            // Initialize rewind buffer
            rewindBuffer.set(playerId, []);
            
            // Map WebSocket to player ID
            wsToPlayerId.set(ws, playerId);

            // Send existing players to new player
            const existingPlayers = Array.from(players.entries())
              .filter(([id]) => id !== playerId)
              .map(([id, data]) => ({
                playerId: id,
                position: data.position,
                rotation: data.rotation,
                timestamp: Date.now()
              }));

            console.log(`[Server] Sending gameState to new player ${playerId}:`, {
              existingPlayersCount: existingPlayers.length,
              existingPlayers
            });

            ws.send(JSON.stringify({
              type: 'gameState',
              players: existingPlayers,
              yourPlayerId: playerId
            }));

            // Notify other players
            broadcastToAll({
              type: 'playerJoined',
              playerId
            }, playerId);
          }
        } else {
          // Other JSON messages - require playerId
          const playerId = wsToPlayerId.get(ws);
          if (!playerId) {
            console.warn('[Server] Received JSON message before join');
            return;
          }
          handleMessage(playerId, message);
        }
      }
    } catch (error) {
      const playerId = wsToPlayerId.get(ws) || 'unknown';
      console.error(`[Server] Failed to parse message from ${playerId}:`, error);
    }
  });

  ws.on('close', () => {
    const playerId = wsToPlayerId.get(ws);
    if (playerId) {
      console.log(`[Server] Player disconnected: ${playerId}`);
      
      // Mark as disconnected but keep state for reconnection
      const player = players.get(playerId);
      if (player) {
        player.disconnected = true;
        player.disconnectTime = Date.now();
      }
      
      // Don't delete player state - keep for reconnection
      // players.delete(playerId);
      rewindBuffer.delete(playerId);
      wsToPlayerId.delete(ws);
      
      // Don't broadcast playerLeft - they might reconnect
      // Only broadcast if they don't reconnect within a timeout
      // For now, we'll broadcast after a delay in the tick loop
    }
  });

  ws.on('error', (error: Error) => {
    const playerId = wsToPlayerId.get(ws) || 'unknown';
    console.error(`[Server] WebSocket error for ${playerId}:`, error);
  });
});

function handleMessage(playerId: string, message: any): void {
  const player = players.get(playerId);
  if (!player) return;

  // Basic message validation
  if (!message || typeof message !== 'object' || !message.type) {
    console.warn(`[Server] Invalid message format from ${playerId}`);
    return;
  }

  switch (message.type) {
    case 'join':
      console.log(`[Server] Player ${playerId} joined`);
      break;

    case 'input':
      if (validateInputData(message.data)) {
        handleInput(playerId, message.data);
      } else {
        console.warn(`[Server] Invalid input data from ${playerId}`);
      }
      break;

    case 'position':
      if (validatePositionData(message.data)) {
        handlePosition(playerId, message.data);
      } else {
        console.warn(`[Server] Invalid position data from ${playerId}`);
      }
      break;

    case 'shot':
      if (validateShotData(message.data)) {
        handleShot(playerId, message.data);
      } else {
        console.warn(`[Server] Invalid shot data from ${playerId}`);
      }
      break;

    default:
      console.warn(`[Server] Unknown message type from ${playerId}:`, message.type);
  }
}

function handleBinaryMessage(playerId: string, data: Uint8Array): void {
  const player = players.get(playerId);
  if (!player) return;

  const messageType = data[0];

  switch (messageType) {
    case MessageType.INPUT:
      try {
        const decoded = decodeInput(data);
        handleInput(playerId, decoded.data);
      } catch (e) {
        console.error(`[Server] Failed to decode input from ${playerId}:`, e);
      }
      break;

    case MessageType.POSITION:
      try {
        const decoded = decodePosition(data);
        handlePosition(playerId, decoded.data);
      } catch (e) {
        console.error(`[Server] Failed to decode position from ${playerId}:`, e);
      }
      break;

    case MessageType.SHOT:
      try {
        const decoded = decodeShot(data);
        handleShot(playerId, decoded.data);
      } catch (e) {
        console.error(`[Server] Failed to decode shot from ${playerId}:`, e);
      }
      break;

    default:
      console.warn(`[Server] Unknown binary message type from ${playerId}:`, messageType);
  }
}

function validateInputData(data: any): boolean {
  return data && 
         typeof data === 'object' &&
         typeof data.sequenceNumber === 'number' &&
         data.sequenceNumber >= 0;
}

function validatePositionData(data: any): boolean {
  return data &&
         typeof data === 'object' &&
         data.position &&
         typeof data.position.x === 'number' &&
         typeof data.position.y === 'number' &&
         typeof data.position.z === 'number' &&
         data.rotation &&
         typeof data.rotation.yaw === 'number' &&
         typeof data.rotation.pitch === 'number';
}

function validateShotData(data: any): boolean {
  return data &&
         typeof data === 'object' &&
         (data.targetId === null || typeof data.targetId === 'string') &&
         typeof data.timestamp === 'number';
}

function handleInput(playerId: string, inputData: any): void {
  const player = players.get(playerId);
  if (!player) return;

  // Update last processed sequence
  player.lastProcessedSequence = inputData.sequenceNumber;

  // TODO: Process input and update position
  // This will be implemented with proper physics
  // For now, we'll just echo the position back
}

function handlePosition(playerId: string, data: any): void {
  const player = players.get(playerId);
  if (!player) return;

  const now = Date.now();
  const dt = (now - player.lastUpdateTime) / 1000; // seconds

  // Calculate velocity from position change
  if (dt > 0 && dt < 1.0) { // Ignore very large gaps (reconnection)
    player.velocity.x = (data.position.x - player.position.x) / dt;
    player.velocity.y = (data.position.y - player.position.y) / dt;
    player.velocity.z = (data.position.z - player.position.z) / dt;
  }

  // Update player position
  player.position = data.position;
  player.rotation = data.rotation;
  player.lastUpdateTime = now;

  // Store in rewind buffer for lag compensation
  storePlayerPosition(playerId, player.position, player.rotation);

  // Broadcast to other players
  broadcastToAll({
    type: 'playerUpdate',
    playerId,
    position: player.position,
    rotation: player.rotation,
    sequenceNumber: player.lastProcessedSequence,
    timestamp: Date.now()
  }, playerId);
}

function handleShot(playerId: string, data: any): void {
  const { targetId, timestamp, position, velocity } = data;

  // Create server-side projectile for tracking
  if (position && velocity) {
    const projectileId = `proj_${projectileIdCounter++}`;
    projectiles.set(projectileId, {
      id: projectileId,
      ownerId: playerId,
      position: { ...position },
      velocity: { ...velocity },
      createdAt: Date.now()
    });
    
    // Broadcast projectile creation to all clients (exclude sender)
    broadcastToAll({
      type: 'projectileCreated',
      projectileId,
      ownerId: playerId,
      position,
      velocity
    }, playerId);
  }

  if (targetId) {
    // Process hit with lag compensation
    const targetPosition = getPlayerPositionAt(targetId, timestamp);
    
    if (targetPosition) {
      const targetPlayer = players.get(targetId);
      if (!targetPlayer || targetPlayer.isDead) return;
      
      const damage = 50; // TODO: Calculate based on distance/accuracy
      targetPlayer.health -= damage;
      
      console.log(`[Server] Shot from ${playerId} HIT ${targetId} for ${damage} damage. Health: ${targetPlayer.health}`);
      
      // Check if player died
      if (targetPlayer.health <= 0) {
        targetPlayer.health = 0;
        targetPlayer.isDead = true;
        targetPlayer.respawnTime = Date.now() + 2000;
        
        // Clear rewind buffer for dead player (save memory)
        rewindBuffer.delete(targetId);
        
        console.log(`[Server] Player ${targetId} killed by ${playerId}, respawning in 2s`);
        
        // Broadcast kill to all players
        broadcastToAll({
          type: 'kill',
          shooterId: playerId,
          targetId,
          timestamp
        });
      } else {
        // Broadcast hit (non-lethal)
        broadcastToAll({
          type: 'hit',
          shooterId: playerId,
          targetId,
          damage,
          timestamp
        });
      }
    }
  } else {
    // Shot without target (miss)
    broadcastToAll({
      type: 'shot',
      playerId,
      targetId: null,
      timestamp
    });
  }
}

// Fixed tick loop for game state updates
setInterval(() => {
  const now = Date.now();
  const dt = TICK_INTERVAL / 1000; // seconds
  const GRAVITY = -20.0;
  const EXTRAPOLATION_TIMEOUT = 200; // ms - start extrapolating after this delay
  const PROJECTILE_LIFETIME = 5000; // 5 seconds
  
  // Check for respawns and extrapolate positions
  for (const [playerId, player] of players) {
    if (player.isDead && player.respawnTime && now >= player.respawnTime) {
      // Respawn player
      player.isDead = false;
      player.health = 100;
      player.respawnTime = null;
      
      // Reset position to spawn point
      player.position = { x: 0, y: 0, z: 0 };
      player.rotation = { yaw: 0, pitch: 0 };
      player.velocity = { x: 0, y: 0, z: 0 };
      
      // Re-initialize rewind buffer
      rewindBuffer.set(playerId, []);
      
      console.log(`[Server] Player ${playerId} respawned`);
      
      // Broadcast respawn to all players
      broadcastToAll({
        type: 'playerRespawn',
        playerId,
        position: player.position,
        rotation: player.rotation
      });
    }
    
    // Extrapolate position if no recent updates (player alt-tabbed)
    const timeSinceUpdate = now - player.lastUpdateTime;
    if (!player.disconnected && timeSinceUpdate > EXTRAPOLATION_TIMEOUT && !player.isDead) {
      // Apply gravity
      player.velocity.y += GRAVITY * dt;
      
      // Update position based on velocity
      player.position.x += player.velocity.x * dt;
      player.position.y += player.velocity.y * dt;
      player.position.z += player.velocity.z * dt;
      
      // Simple ground collision (y >= 0)
      if (player.position.y < 0) {
        player.position.y = 0;
        player.velocity.y = 0;
        player.velocity.x *= 0.8; // Friction
        player.velocity.z *= 0.8;
      }
      
      // Broadcast extrapolated position to other players
      broadcastToAll({
        type: 'playerUpdate',
        playerId,
        position: player.position,
        rotation: player.rotation,
        sequenceNumber: player.lastProcessedSequence,
        timestamp: now
      }, playerId);
    }
  }
  
  // Simulate projectiles
  for (const [projectileId, projectile] of projectiles) {
    // Remove old projectiles
    if (now - projectile.createdAt > PROJECTILE_LIFETIME) {
      projectiles.delete(projectileId);
      broadcastToAll({
        type: 'projectileDestroyed',
        projectileId
      }, projectile.ownerId);
      continue;
    }
    
    // Apply gravity
    projectile.velocity.y += GRAVITY * dt;
    
    // Update position
    projectile.position.x += projectile.velocity.x * dt;
    projectile.position.y += projectile.velocity.y * dt;
    projectile.position.z += projectile.velocity.z * dt;
    
    // Simple ground collision
    if (projectile.position.y < 0) {
      projectile.position.y = 0;
      projectile.velocity.y = 0;
      projectile.velocity.x *= 0.5;
      projectile.velocity.z *= 0.5;
    }
    
    // Broadcast projectile position to other clients (exclude owner)
    broadcastToAll({
      type: 'projectileUpdate',
      projectileId,
      position: projectile.position
    }, projectile.ownerId);
  }
  
  // Broadcast playerLeft for disconnected players after 10 seconds (gives time for reconnection)
  const DISCONNECT_BROADCAST_DELAY = 10 * 1000; // 10 seconds
  const DISCONNECT_TIMEOUT = 5 * 60 * 1000; // 5 minutes
  for (const [playerId, player] of players) {
    if (player.disconnected && player.disconnectTime) {
      if ((now - player.disconnectTime) > DISCONNECT_BROADCAST_DELAY && !player.playerLeftBroadcasted) {
        // Broadcast playerLeft after delay
        broadcastToAll({
          type: 'playerLeft',
          playerId
        });
        player.playerLeftBroadcasted = true;
      }
      if ((now - player.disconnectTime) > DISCONNECT_TIMEOUT) {
        console.log(`[Server] Cleaning up disconnected player: ${playerId}`);
        players.delete(playerId);
        rewindBuffer.delete(playerId);
      }
    }
  }
  
  // TODO: Process inputs and update positions (server-authoritative movement)
  // This will be implemented with proper physics
  
}, TICK_INTERVAL);

function storePlayerPosition(playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }): void {
  const history = rewindBuffer.get(playerId) || [];
  history.push({
    timestamp: Date.now(),
    position: { ...position },
    rotation: { ...rotation }
  });

  // Keep 500ms history for lag compensation
  const cutoff = Date.now() - 500;
  while (history.length > 0 && history[0].timestamp < cutoff) {
    history.shift();
  }

  rewindBuffer.set(playerId, history);
}

function getPlayerPositionAt(playerId: string, timestamp: number): { x: number; y: number; z: number } | null {
  const history = rewindBuffer.get(playerId);
  if (!history || history.length === 0) return null;

  // Find closest snapshot
  let closest = history[0];
  for (const snapshot of history) {
    if (Math.abs(snapshot.timestamp - timestamp) < Math.abs(closest.timestamp - timestamp)) {
      closest = snapshot;
    }
  }

  return closest.position;
}

function broadcastToAll(message: any, excludePlayerId: string | null = null): void {
  const data = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      const playerId = wsToPlayerId.get(client);
      if (playerId && playerId !== excludePlayerId) {
        client.send(data);
      }
    }
  });
}

function generatePlayerId(): string {
  return Math.random().toString(36).substr(2, 9);
}

// Game loop for periodic updates (optional)
// Currently using event-driven updates, but can add tick-based processing later
// setInterval(() => {
//   // Process game state at fixed tick rate
// }, TICK_INTERVAL);

console.log('[Server] Ready for connections');
