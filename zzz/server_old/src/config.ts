/**
 * Server configuration constants
 * Centralized configuration for easy tuning
 */

/**
 * Network mode determines how the server handles game state
 */
export enum NetworkMode {
  /** Server validates all moves, simulates game state, sends authoritative positions */
  SERVER_AUTHORITATIVE = 'server_authoritative',
  /** Server only forwards packets between clients (relay mode) */
  CLIENT_RELAY = 'client_relay',
  /** Hybrid: clients simulate, server validates asynchronously (future) */
  HYBRID_VALIDATION = 'hybrid_validation'
}

export const ServerConfig = {
  // Network settings
  PORT: 8080,
  TICK_RATE: 30, // Hz (33ms per tick) - per specification
  NETWORK_MODE: NetworkMode.SERVER_AUTHORITATIVE, // Server validates moves, simulates game state
  DISABLE_VALIDATION: true, // Disable position validation for testing core networking

  // Lag compensation
  REWIND_BUFFER_MS: 1000, // History buffer size in milliseconds
  POSITION_TOLERANCE_MS: 200, // Max acceptable position difference in milliseconds
  EXTRAPOLATION_MAX_MS: 500, // Max extrapolation time in milliseconds

  // Position validation
  POSITION_HISTORY_SIZE: 1000, // Keep ~1 second of history at 20Hz
  SOFT_THRESHOLD_BASE: 0.5, // Base soft threshold in meters (horizontal)
  HARD_THRESHOLD_BASE: 2.0, // Base hard threshold in meters (horizontal)
  SOFT_THRESHOLD_VERTICAL: 2.0, // Base soft threshold for vertical movement
  HARD_THRESHOLD_VERTICAL: 5.0, // Base hard threshold for vertical movement
  MAX_PING_MS: 500, // Max ping for threshold scaling
  
  // Rate limiting
  MAX_SHOTS_PER_SECOND: 20, // Per specification
  MAX_JUMPS_PER_SECOND: 10, // Per specification
  MAX_JETPACK_UPDATES_PER_SECOND: 5, // Per specification
  MAX_TOTAL_MESSAGES_PER_SECOND: 100, // Per specification
  RATE_LIMIT_WARNING_COOLDOWN_MS: 1000, // Only log rate limit warnings once per second
  
  // Physics
  GRAVITY: -20.0, // m/s²
  PROJECTILE_SPEED: 120.0, // units/sec
  PROJECTILE_LIFETIME: 3000, // milliseconds
  
  // Player cleanup
  DISCONNECT_CLEANUP_DELAY_MS: 5000, // Delay before fully removing disconnected player
  DISCONNECT_BROADCAST_DELAY_MS: 10000, // Delay before broadcasting player left
  DISCONNECT_TIMEOUT_MS: 300000, // 5 minutes timeout for disconnected players

  // Game mechanics
  RESPAWN_DELAY_MS: 2000, // Delay before player respawns
  ESTIMATED_PING_CAP_MS: 500, // Cap for estimated ping calculations
  EXTRAPOLATION_TIMEOUT_MS: 200, // ms - start extrapolating after this delay
  MILLISECONDS_PER_SECOND: 1000, // Time conversion constant
  ROTATION_SCALE: 1000, // Scale factor for encoding rotation deltas (int16)

  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL ? parseInt(process.env.LOG_LEVEL) : 2, // INFO level

  // Tribes2 networking constants (per multiplayer specification)
  TRIBES2_MAX_PACKET_SIZE: 1400, // MTU-safe packet size
  TRIBES2_PACKETS_PER_SECOND: 30, // Packets per second (tick rate)
  TRIBES2_MAX_BYTES_PER_SECOND: 42000, // Bandwidth limit per player
} as const;
