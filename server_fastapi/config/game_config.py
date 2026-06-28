"""
Game balance configuration
"""

# Player settings
PLAYER_MAX_HEALTH = 100
PLAYER_RESPAWN_TIME = 3  # seconds

# Spawn points (fixed height above terrain)
SPAWN_POINTS = [
    {"x": 0, "y": 50, "z": 0},
    {"x": 50, "y": 50, "z": 0},
    {"x": -50, "y": 50, "z": 0},
    {"x": 0, "y": 50, "z": 50},
    {"x": 0, "y": 50, "z": -50}
]

# Combat settings
SHOT_DAMAGE = 50  # Damage per direct hit
