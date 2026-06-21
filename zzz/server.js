import { WebSocketServer } from 'ws';

/**
 * Three.js FPS Game Server
 * Uses ws library for WebSocket communication
 * Implements basic room-based multiplayer
 */

const PORT = 8095;
const TICK_RATE = 15; // 15Hz = 67ms per tick
const TICK_INTERVAL = 1000 / TICK_RATE;

// Game state
const players = new Map(); // playerId -> { ws, position, rotation, lastProcessedSequence }
const rewindBuffer = new Map(); // playerId -> Array of {timestamp, position, rotation}

// WebSocket server
const wss = new WebSocketServer({ port: PORT });

console.log(`[Server] Starting on port ${PORT} with ${TICK_RATE}Hz tick rate`);

wss.on('connection', (ws) => {
  const playerId = generatePlayerId();
  console.log(`[Server] Player connected: ${playerId}`);

  // Initialize player state
  players.set(playerId, {
    ws,
    position: { x: 0, y: 0, z: 0 },
    rotation: { yaw: 0, pitch: 0 },
    lastProcessedSequence: 0
  });

  // Initialize rewind buffer
  rewindBuffer.set(playerId, []);

  // Send existing players to new player
  const existingPlayers = Array.from(players.entries())
    .filter(([id]) => id !== playerId)
    .map(([id, data]) => ({
      playerId: id,
      position: data.position,
      rotation: data.rotation,
      timestamp: Date.now()
    }));

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

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      handleMessage(playerId, message);
    } catch (error) {
      console.error(`[Server] Failed to parse message from ${playerId}:`, error);
    }
  });

  ws.on('close', () => {
    console.log(`[Server] Player disconnected: ${playerId}`);
    players.delete(playerId);
    rewindBuffer.delete(playerId);
    broadcastToAll({
      type: 'playerLeft',
      playerId
    });
  });

  ws.on('error', (error) => {
    console.error(`[Server] WebSocket error for ${playerId}:`, error);
  });
});

function handleMessage(playerId, message) {
  const player = players.get(playerId);
  if (!player) return;

  switch (message.type) {
    case 'join':
      console.log(`[Server] Player ${playerId} joined`);
      break;

    case 'input':
      handleInput(playerId, message.data);
      break;

    case 'position':
      handlePosition(playerId, message.data);
      break;

    case 'shot':
      handleShot(playerId, message.data);
      break;

    case 'jump':
      handleJump(playerId, message);
      break;

    case 'jetpack':
      handleJetpack(playerId, message);
      break;

    default:
      console.warn(`[Server] Unknown message type from ${playerId}:`, message.type);
  }
}

function handleInput(playerId, inputData) {
  const player = players.get(playerId);
  if (!player) return;

  // Update last processed sequence
  player.lastProcessedSequence = inputData.sequenceNumber;

  // TODO: Process input and update position
  // This will be implemented with proper physics
  // For now, we'll just echo the position back
}

function handlePosition(playerId, data) {
  const player = players.get(playerId);
  if (!player) return;

  // Update player position
  player.position = data.position;
  player.rotation = data.rotation;

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

function handleShot(playerId, data) {
  const { targetId, timestamp } = data;

  if (targetId) {
    // Process hit with lag compensation
    const targetPosition = getPlayerPositionAt(targetId, timestamp);
    
    if (targetPosition) {
      console.log(`[Server] Shot from ${playerId} HIT ${targetId} at timestamp ${timestamp}`);
      console.log(`[Server] Target position at that time:`, targetPosition);
      
      // Broadcast hit to all players
      broadcastToAll({
        type: 'hit',
        shooterId: playerId,
        targetId,
        damage: 50, // TODO: Calculate based on distance/accuracy
        timestamp
      });
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

function handleJump(playerId, message) {
  const { position, timestamp } = message;
  
  // Relay jump event to all other players
  broadcastToAll({
    type: 'jump',
    playerId,
    position,
    timestamp
  }, playerId);
}

function handleJetpack(playerId, message) {
  const { position, timestamp } = message;
  
  // Relay jetpack event to all other players
  broadcastToAll({
    type: 'jetpack',
    playerId,
    position,
    timestamp
  }, playerId);
}

function storePlayerPosition(playerId, position, rotation) {
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

function getPlayerPositionAt(playerId, timestamp) {
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

function broadcastToAll(message, excludePlayerId = null) {
  const data = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      const player = Array.from(players.entries()).find(([_, p]) => p.ws === client);
      if (player && player[0] !== excludePlayerId) {
        client.send(data);
      }
    }
  });
}

function generatePlayerId() {
  return Math.random().toString(36).substr(2, 9);
}

// Game loop for periodic updates (optional)
// Currently using event-driven updates, but can add tick-based processing later
// setInterval(() => {
//   // Process game state at fixed tick rate
// }, TICK_INTERVAL);

console.log('[Server] Ready for connections');
