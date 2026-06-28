"""
FastAPI Game Server for FPS
WebSocket-based real-time multiplayer
"""

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from typing import Dict, Set
import json
import asyncio
import logging
from datetime import datetime
import sys
import os

# Add parent directory to path to import config
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config.game_config import (
    PLAYER_MAX_HEALTH,
    PLAYER_RESPAWN_TIME,
    SPAWN_POINTS,
    SHOT_DAMAGE
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)

app = FastAPI(title="FPS Game Server")

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def choose_spawn_point(player_id: str, players: dict) -> dict:
    """Choose spawn point furthest from alive players"""
    import math

    best_spawn_point = SPAWN_POINTS[0]
    max_min_distance = -1

    for spawn_point in SPAWN_POINTS:
        min_distance_to_any_player = float('inf')

        for other_player_id, other_player in players.items():
            if other_player_id != player_id and not other_player.get("isDead", False):
                dx = spawn_point["x"] - other_player["position"]["x"]
                dz = spawn_point["z"] - other_player["position"]["z"]
                distance = math.sqrt(dx * dx + dz * dz)
                min_distance_to_any_player = min(min_distance_to_any_player, distance)

        if min_distance_to_any_player > max_min_distance:
            max_min_distance = min_distance_to_any_player
            best_spawn_point = spawn_point

    return best_spawn_point


async def respawn_player(manager: 'ConnectionManager', player_id: str):
    """Respawn a player after configured respawn time"""
    await asyncio.sleep(PLAYER_RESPAWN_TIME)

    if player_id in manager.players:
        manager.players[player_id]["health"] = PLAYER_MAX_HEALTH
        manager.players[player_id]["isDead"] = False

        # Choose spawn point furthest from alive players
        spawn_point = choose_spawn_point(player_id, manager.players)
        manager.players[player_id]["position"] = spawn_point
        manager.players[player_id]["rotation"] = {"yaw": 0, "pitch": 0}
        manager.players[player_id]["velocity"] = {"x": 0, "y": 0, "z": 0}
        
        logger.info(f"{player_id} (internalId: {manager.players[player_id]['internalId']}) respawned at {manager.players[player_id]['position']}")

        # Send respawn message to the respawned player first
        await manager.send_personal({
            "type": "playerRespawn",
            "playerId": player_id,
            "internalId": manager.players[player_id]["internalId"],
            "position": manager.players[player_id]["position"],
            "rotation": manager.players[player_id]["rotation"]
        }, player_id)

        # Then broadcast to other players
        await manager.broadcast({
            "type": "playerRespawn",
            "playerId": player_id,
            "internalId": manager.players[player_id]["internalId"],
            "position": manager.players[player_id]["position"],
            "rotation": manager.players[player_id]["rotation"]
        }, exclude_player_id=player_id)


# Connection manager
class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}
        self.players: Dict[str, dict] = {}

    async def connect(self, websocket: WebSocket, player_id: str):
        await websocket.accept()
        self.active_connections[player_id] = websocket
        self.players[player_id] = {
            "id": player_id,
            "position": SPAWN_POINTS[0],
            "rotation": {"yaw": 0, "pitch": 0},
            "velocity": {"x": 0, "y": 0, "z": 0},
            "isDead": False,
            "health": PLAYER_MAX_HEALTH
        }
        logger.info(f"Player {player_id} connected. Total: {len(self.active_connections)}")

    def disconnect(self, player_id: str):
        if player_id in self.active_connections:
            del self.active_connections[player_id]
        if player_id in self.players:
            del self.players[player_id]
        logger.info(f"Player {player_id} disconnected. Total: {len(self.active_connections)}")

    async def send_personal(self, message: dict, player_id: str):
        if player_id in self.active_connections:
            try:
                await self.active_connections[player_id].send_json(message)
            except Exception as e:
                logger.error(f"Error sending to {player_id}: {e}")
                self.disconnect(player_id)

    async def broadcast(self, message: dict, exclude_player_id: str = None):
        disconnected = []
        for player_id, connection in self.active_connections.items():
            if exclude_player_id and player_id == exclude_player_id:
                continue
            try:
                await connection.send_json(message)
            except Exception as e:
                logger.error(f"Error broadcasting to {player_id}: {e}")
                disconnected.append(player_id)
        
        # Clean up disconnected players
        for player_id in disconnected:
            self.disconnect(player_id)

    def get_other_players(self, player_id: str) -> list:
        return [
            {
                "id": pid,
                "internalId": p.get("internalId"),
                "position": p.get("position"),
                "rotation": p.get("rotation"),
                "velocity": p.get("velocity"),
                "isDead": p.get("isDead", False),
                "health": p.get("health")
            }
            for pid, p in self.players.items()
            if pid != player_id
        ]

manager = ConnectionManager()

@app.get("/")
async def root():
    return {"status": "running", "players": len(manager.active_connections)}

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    
    # Wait for initial message with player ID
    try:
        data = await websocket.receive_json()
        player_id = data.get("playerId")
        
        if not player_id:
            logger.warning("Connection rejected: no playerId")
            await websocket.close(code=1008, reason="No playerId provided")
            return
        
        # Add to manager after accepting
        manager.active_connections[player_id] = websocket
        # Generate internal ID for duplicate detection
        internal_id = f"{int(datetime.now().timestamp() * 1000)}_{len(manager.active_connections)}"
        manager.players[player_id] = {
            "id": player_id,
            "internalId": internal_id,
            "position": SPAWN_POINTS[0],
            "rotation": {"yaw": 0, "pitch": 0},
            "velocity": {"x": 0, "y": 0, "z": 0},
            "isDead": False,
            "health": PLAYER_MAX_HEALTH
        }
        logger.info(f"Player {player_id} (internalId: {internal_id}) connected. Total: {len(manager.active_connections)}")
        
        # Send current players to new player
        other_players = manager.get_other_players(player_id)
        await manager.send_personal({
            "type": "gameState",
            "players": other_players
        }, player_id)
        
        # Broadcast player joined to others
        await manager.broadcast({
            "type": "playerJoined",
            "playerId": player_id,
            "internalId": manager.players[player_id]["internalId"],
            "position": manager.players[player_id]["position"]
        }, exclude_player_id=player_id)
        
        # Main message loop
        while True:
            data = await websocket.receive_json()
            message_type = data.get("type")
            
            if message_type == "position":
                # Update player position (preserve isDead state)
                if player_id in manager.players:
                    manager.players[player_id]["position"] = data.get("position")
                    manager.players[player_id]["rotation"] = data.get("rotation")
                    manager.players[player_id]["velocity"] = data.get("velocity")
                    # Don't overwrite isDead - if player is dead, they stay dead
                
                # Broadcast to other players
                await manager.broadcast({
                    "type": "position",
                    "playerId": player_id,
                    "internalId": manager.players[player_id]["internalId"],
                    "position": data.get("position"),
                    "rotation": data.get("rotation"),
                    "velocity": data.get("velocity"),
                    "isDead": manager.players[player_id]["isDead"]
                }, exclude_player_id=player_id)
            
            elif message_type == "shot":
                target_id = data.get("targetId")
                
                # Broadcast shot event
                await manager.broadcast({
                    "type": "shot",
                    "playerId": player_id,
                    "targetId": target_id
                }, exclude_player_id=player_id)
                
                # Process damage if target specified
                if target_id and target_id in manager.players:
                    target = manager.players[target_id]
                    damage = SHOT_DAMAGE
                    
                    target["health"] -= damage
                    logger.info(f"{player_id} shot {target_id} for {damage} damage. Health: {target['health']}")
                    
                    # Broadcast hit event
                    await manager.broadcast({
                        "type": "playerHit",
                        "shooterId": player_id,
                        "targetId": target_id,
                        "damage": damage
                    })
                    
                    # Check for kill
                    if target["health"] <= 0:
                        target["health"] = 0
                        target["isDead"] = True
                        logger.info(f"{target_id} was killed by {player_id}")
                        
                        # Broadcast kill event
                        await manager.broadcast({
                            "type": "playerKill",
                            "shooterId": player_id,
                            "targetId": target_id
                        })
                        
                        # Schedule respawn
                        asyncio.create_task(respawn_player(manager, target_id))
            
            elif message_type == "input":
                # Handle input (movement, etc.)
                # For now, just acknowledge
                pass
            
    except WebSocketDisconnect:
        manager.disconnect(player_id)
        await manager.broadcast({
            "type": "playerLeft",
            "playerId": player_id
        })
    except Exception as e:
        logger.error(f"WebSocket error for {player_id}: {e}")
        manager.disconnect(player_id)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8080,
        reload=True,
        log_level="info"
    )
