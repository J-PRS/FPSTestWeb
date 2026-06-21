const WebSocket = require('ws');

const PORT = 8080;
const wss = new WebSocket.Server({ port: PORT });

const players = new Map();
const POSITION_HISTORY_SIZE = 120; // Store 2 seconds of history at 60Hz
const MAX_LAG_COMPENSATION_MS = 500; // Max rewind time in ms
const SERVER_TICK_RATE = 60; // 60 Hz server updates for better precision

// Team system
const teamScores = { 0: 0, 1: 0 }; // 0 = red, 1 = blue
const WIN_SCORE = 20; // First team to reach 20 kills wins
const ROUND_TIME_LIMIT = 600; // 10 minutes in seconds
let roundStartTime = Date.now() / 1000; // Track round start time
let gameEnded = false;
let resetTimer = null;
let roundTimerInterval = null;

// Generate consistent color from player ID
function getPlayerColor(playerId) {
  let hash = 0;
  for (let i = 0; i < playerId.length; i++) {
    hash = playerId.charCodeAt(i) + ((hash << 5) - hash);
  }
  const r = (hash & 0xFF0000) >> 16;
  const g = (hash & 0x00FF00) >> 8;
  const b = hash & 0x0000FF;
  return { r, g, b };
}

// Get player position at a specific timestamp (for lag compensation)
function getPlayerPositionAtTime(playerData, timestamp) {
  if (!playerData.positionHistory || playerData.positionHistory.length === 0) {
    return playerData.position;
  }
  
  // Find the position closest to the timestamp
  let closest = playerData.positionHistory[0];
  let closestDiff = Math.abs(playerData.positionHistory[0].timestamp - timestamp);
  
  for (let i = 1; i < playerData.positionHistory.length; i++) {
    const diff = Math.abs(playerData.positionHistory[i].timestamp - timestamp);
    if (diff < closestDiff) {
      closest = playerData.positionHistory[i];
      closestDiff = diff;
    }
  }
  
  return closest.position;
}

function resetGame() {
  console.log('Resetting game...');
  teamScores[0] = 0;
  teamScores[1] = 0;
  gameEnded = false;
  roundStartTime = Date.now() / 1000; // Reset round start time
  
  // Reset all player stats
  for (const [playerId, playerData] of players) {
    playerData.health = 100;
    playerData.kills = 0;
  }
  
  // Broadcast reset to all clients
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'gameReset',
        redScore: 0,
        blueScore: 0
      }));
      
      // Send round start notification
      client.send(JSON.stringify({
        type: 'roundStart',
        message: 'NEW ROUND STARTED!'
      }));
    }
  });
  
  console.log('Game reset complete');
}

function startRoundTimer() {
  if (roundTimerInterval) clearInterval(roundTimerInterval);
  
  roundTimerInterval = setInterval(() => {
    if (gameEnded) return;
    
    const now = Date.now() / 1000;
    const elapsed = now - roundStartTime;
    
    if (elapsed >= ROUND_TIME_LIMIT) {
      // Time limit reached - determine winner
      gameEnded = true;
      clearInterval(roundTimerInterval);
      
      let winner = -1;
      let message = '';
      
      if (teamScores[0] > teamScores[1]) {
        winner = 0;
        message = 'TIME UP - RED TEAM WINS!';
      } else if (teamScores[1] > teamScores[0]) {
        winner = 1;
        message = 'TIME UP - BLUE TEAM WINS!';
      } else {
        message = 'TIME UP - DRAW!';
      }
      
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: 'gameOver',
            winner: winner,
            message: message
          }));
        }
      });
      
      console.log(message);
      
      // Start countdown and schedule game reset
      startCountdown();
      if (resetTimer) clearTimeout(resetTimer);
      resetTimer = setTimeout(resetGame, 10000);
    }
  }, 1000);
}

function startCountdown() {
  let countdown = 10;
  
  const countdownInterval = setInterval(() => {
    if (countdown > 0) {
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: 'countdown',
            seconds: countdown
          }));
        }
      });
      countdown--;
    } else {
      clearInterval(countdownInterval);
    }
  }, 1000);
}

console.log(`WebSocket server running on port ${PORT}`);

// Start round timer when server starts
startRoundTimer();

wss.on('connection', (ws) => {
  const playerId = `player_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  console.log(`Player connected: ${playerId}`);
  
  // Count players on each team for balanced assignment
  let redCount = 0;
  let blueCount = 0;
  for (const p of players.values()) {
    if (p.team === 0) redCount++;
    else blueCount++;
  }
  // Assign to team with fewer players
  const team = redCount <= blueCount ? 0 : 1;
  
  // Generate a readable default name
  const adjectives = ['Fast', 'Sly', 'Brave', 'Wild', 'Cool', 'Dark', 'Swift', 'Fierce'];
  const nouns = ['Ranger', 'Wolf', 'Eagle', 'Tiger', 'Ghost', 'Hawk', 'Viper', 'Bear'];
  const randomName = adjectives[Math.floor(Math.random() * adjectives.length)] + 
                     nouns[Math.floor(Math.random() * nouns.length)] + 
                     Math.floor(Math.random() * 100);
  
  players.set(playerId, {
    ws,
    position: { x: 0, y: 2, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    health: 100,
    kills: 0,
    color: getPlayerColor(playerId),
    name: randomName,
    positionHistory: [], // For lag compensation
    team: team // 0 = red, 1 = blue
  });

  ws.send(JSON.stringify({
    type: 'init',
    playerId,
    team: team,
    players: Array.from(players.entries()).map(([id, data]) => ({
      id,
      position: data.position,
      rotation: data.rotation,
      color: data.color,
      name: data.name,
      team: data.team
    }))
  }));

  wss.clients.forEach((client) => {
    if (client !== ws && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'playerJoined',
        playerId,
        position: { x: 0, y: 2, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        color: players.get(playerId).color,
        name: players.get(playerId).name,
        team: team
      }));
    }
  });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'positionUpdate') {
        const player = players.get(playerId);
        if (player && data.position && data.rotation) {
          player.position = data.position;
          player.rotation = data.rotation;
          
          // Add to position history for lag compensation
          const now = Date.now() / 1000; // Convert to seconds
          player.positionHistory.push({
            position: { ...data.position },
            timestamp: now
          });
          
          // Keep history size limited
          if (player.positionHistory.length > POSITION_HISTORY_SIZE) {
            player.positionHistory.shift();
          }
          
          // Send authoritative position back to client for reconciliation with sequence
          ws.send(JSON.stringify({
            type: 'playerPosition',
            position: data.position,
            seq: data.seq !== undefined ? data.seq : -1
          }));
        }

        wss.clients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'playerUpdate',
              playerId,
              position: data.position,
              rotation: data.rotation
            }));
          }
        });
      }
      
      if (data.type === 'positionUpdateBatch') {
        const player = players.get(playerId);
        if (player && data.updates && data.updates.length > 0) {
          // Process all updates in the batch
          const lastUpdate = data.updates[data.updates.length - 1];
          if (lastUpdate.position && lastUpdate.rotation) {
            player.position = lastUpdate.position;
            player.rotation = lastUpdate.rotation;
          
            // Add each update to position history for lag compensation
            const now = Date.now() / 1000;
            for (const update of data.updates) {
              player.positionHistory.push({
                position: { ...update.position },
                timestamp: now
              });
            }
            
            // Keep history size limited
            while (player.positionHistory.length > POSITION_HISTORY_SIZE) {
              player.positionHistory.shift();
            }
            
            // Send authoritative position back with last sequence
            ws.send(JSON.stringify({
              type: 'playerPosition',
              position: lastUpdate.position,
              seq: lastUpdate.seq !== undefined ? lastUpdate.seq : -1
            }));
            
            // Broadcast last update to other players
            wss.clients.forEach((client) => {
              if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                  type: 'playerUpdate',
                  playerId,
                  position: lastUpdate.position,
                  rotation: lastUpdate.rotation
                }));
              }
            });
          }
        }
      }
      
      if (data.type === 'setName') {
        const player = players.get(playerId);
        if (player && data.name && data.name.length > 0 && data.name.length <= 20) {
          const oldName = player.name;
          player.name = data.name;
          console.log(`Player ${playerId} renamed from ${oldName} to ${data.name}`);
          
          // Broadcast name change to all players
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: 'playerNameChanged',
                playerId,
                name: data.name
              }));
            }
          });
        }
      }
      
      if (data.type === 'rocketFire') {
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'rocketFire',
              playerId,
              position: data.position,
              direction: data.direction
            }));
          }
        });
      }
      
      if (data.type === 'ping') {
        // Echo ping back for latency measurement
        ws.send(JSON.stringify({
          type: 'pong',
          time: data.time
        }));
      }
      
      if (data.type === 'rocketExplode') {
        // Check if position data is valid
        if (!data.position) {
          console.log('Invalid rocketExplode message: missing position');
          return;
        }
        
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'rocketExplode',
              playerId,
              position: data.position
            }));
          }
        });
        
        // Check for player damage with lag compensation
        const fireTime = data.timestamp || (Date.now() / 1000);
        const now = Date.now() / 1000;
        const lagMs = (now - fireTime) * 1000;
        
        // Only compensate if lag is reasonable
        const useLagComp = lagMs > 0 && lagMs < MAX_LAG_COMPENSATION_MS;
        
        for (const [targetId, targetData] of players) {
          if (targetId !== playerId) {
            // Skip teammates
            const attacker = players.get(playerId);
            if (attacker && targetData.team === attacker.team) continue;
            
            // Check if position data is valid
            if (!data.position) continue;
            
            // Use lag compensation: rewind target to fire time
            const targetPos = useLagComp 
              ? getPlayerPositionAtTime(targetData, fireTime)
              : targetData.position;
            
            if (!targetPos) continue;
            
            const dx = data.position.x - targetPos.x;
            const dy = data.position.y - targetPos.y;
            const dz = data.position.z - targetPos.z;
            const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
            
            if (dist < 5.0) { // Damage radius
              const damage = Math.round(50 * (1 - dist / 5.0)); // Falloff damage
              targetData.health = Math.max(0, targetData.health - damage);
              
              // Send damage to victim with source position
              targetData.ws.send(JSON.stringify({
                type: 'takeDamage',
                damage: damage,
                fromPlayer: playerId,
                fromPosition: data.position
              }));
              
              // Broadcast health update to all players
              wss.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                  client.send(JSON.stringify({
                    type: 'playerHealth',
                    playerId: targetId,
                    health: targetData.health
                  }));
                }
              });
              
              // Send hit confirmation to attacker
              if (attacker) {
                attacker.ws.send(JSON.stringify({
                  type: 'hitConfirm',
                  target: targetId,
                  damage: damage
                }));
              }
              
              // Check for kill
              if (targetData.health <= 0) {
                if (attacker) attacker.kills++;
                
                // Update team score
                if (attacker) {
                  teamScores[attacker.team]++;
                }
                
                // Send team score update to all
                wss.clients.forEach((client) => {
                  if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                      type: 'teamScore',
                      team: attacker ? attacker.team : 0,
                      score: teamScores[attacker ? attacker.team : 0]
                    }));
                  }
                });
                
                // Check for win condition
                if (!gameEnded) {
                  if (teamScores[0] >= WIN_SCORE) {
                    gameEnded = true;
                    wss.clients.forEach((client) => {
                      if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                          type: 'gameOver',
                          winner: 0,
                          message: 'RED TEAM WINS!'
                        }));
                      }
                    });
                    console.log('RED TEAM WINS!');
                    
                    // Start countdown and schedule game reset
                    startCountdown();
                    if (resetTimer) clearTimeout(resetTimer);
                    resetTimer = setTimeout(resetGame, 10000);
                  } else if (teamScores[1] >= WIN_SCORE) {
                    gameEnded = true;
                    wss.clients.forEach((client) => {
                      if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                          type: 'gameOver',
                          winner: 1,
                          message: 'BLUE TEAM WINS!'
                        }));
                      }
                    });
                    console.log('BLUE TEAM WINS!');
                    
                    // Start countdown and schedule game reset
                    startCountdown();
                    if (resetTimer) clearTimeout(resetTimer);
                    resetTimer = setTimeout(resetGame, 10000);
                  }
                }
                
                // Send kill count to killer
                if (attacker) {
                  attacker.ws.send(JSON.stringify({
                    type: 'killCount',
                    kills: attacker.kills
                  }));
                }
                
                // Broadcast kill
                wss.clients.forEach((client) => {
                  if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                      type: 'playerKilled',
                      victim: targetId,
                      killer: playerId
                    }));
                  }
                });
                
                // Respawn victim
                setTimeout(() => {
                  const respawnData = players.get(targetId);
                  if (respawnData) {
                    respawnData.health = 100;
                    respawnData.position = {
                      x: (Math.random() - 0.5) * 100,
                      y: 10,
                      z: (Math.random() - 0.5) * 100
                    };
                    respawnData.ws.send(JSON.stringify({
                      type: 'respawn',
                      position: respawnData.position
                    }));
                    
                    // Broadcast respawn to all players
                    wss.clients.forEach((client) => {
                      if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                          type: 'playerRespawned',
                          playerId: targetId,
                          position: respawnData.position
                        }));
                      }
                    });
                  }
                }, 2000);
              }
            }
          }
        }
      }
    } catch (error) {
      console.error('Error parsing message:', error);
    }
  });

  ws.on('close', () => {
    const playerData = players.get(playerId);
    const playerName = playerData ? playerData.name : playerId;
    console.log(`Player disconnected: ${playerName} (${playerId})`);
    players.delete(playerId);

    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'playerLeft',
          playerId,
          name: playerName
        }));
      }
    });
  });

  ws.on('error', (error) => {
    console.error(`WebSocket error for ${playerId}:`, error);
  });
});
