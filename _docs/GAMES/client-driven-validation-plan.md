# Implementation Plan: Client-Driven LAN-Like Feel with Server Validation

**Date:** 2026-06-22
**Objective:** Implement client-driven responsive gameplay with server-side validation to prevent cheating while maintaining low costs

## Architecture Overview

### Current State
- **Client:** Full physics simulation, sends position updates
- **Server:** Stores positions, no validation
- **Security:** Critical vulnerabilities (teleportation, speed hacking, flight)
- **Responsiveness:** Excellent (client-side prediction)

### Target State
- **Client:** Full physics simulation, sends inputs + predicted positions
- **Server:** Validates inputs, validates positions, lightweight physics for idle players
- **Security:** High (80-90% cheat detection)
- **Responsiveness:** Excellent (maintains client-side prediction)
- **Cost:** +20-25% server CPU (acceptable for DigitalOcean)

## Phase 1: Basic Server Validation (Immediate Priority)

### 1.1 Speed Limit Validation

**File:** `server/src/Validation.ts` (new file)

```typescript
export class PositionValidator {
  private static readonly MAX_SPEED = 15.0; // m/s
  private static readonly MAX_ACCELERATION = 50.0; // m/s²

  static validateSpeed(
    oldPos: { x: number; y: number; z: number },
    newPos: { x: number; y: number; z: number },
    deltaTime: number
  ): { valid: boolean; reason?: string } {
    const dx = newPos.x - oldPos.x;
    const dy = newPos.y - oldPos.y;
    const dz = newPos.z - oldPos.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const speed = distance / deltaTime;

    if (speed > this.MAX_SPEED) {
      return { valid: false, reason: `Speed exceeded: ${speed.toFixed(2)} m/s (max: ${this.MAX_SPEED} m/s)` };
    }

    return { valid: true };
  }
}
```

**Integration:** Add to `MessageHandler.ts` in `handlePosition()`

**Cost:** Minimal (simple math)
**Impact:** Catches speed hacking, teleportation

### 1.2 Teleportation Detection

**File:** `server/src/Validation.ts`

```typescript
export class PositionValidator {
  private static readonly MAX_TELEPORT_DISTANCE = 20.0; // meters

  static validateTeleportation(
    oldPos: { x: number; y: number; z: number },
    newPos: { x: number; y: number; z: number }
  ): { valid: boolean; reason?: string } {
    const dx = newPos.x - oldPos.x;
    const dy = newPos.y - oldPos.y;
    const dz = newPos.z - oldPos.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (distance > this.MAX_TELEPORT_DISTANCE) {
      return { valid: false, reason: `Teleportation detected: ${distance.toFixed(2)}m (max: ${this.MAX_TELEPORT_DISTANCE}m)` };
    }

    return { valid: true };
  }
}
```

**Integration:** Add to `MessageHandler.ts` in `handlePosition()`

**Cost:** Minimal
**Impact:** Catches teleportation

### 1.3 Input Range Validation

**File:** `server/src/Validation.ts`

```typescript
export class InputValidator {
  static validateInput(input: { forward: number; right: number; jump: boolean; ski: boolean }): { valid: boolean; reason?: string } {
    if (input.forward < -1 || input.forward > 1) {
      return { valid: false, reason: `Invalid forward input: ${input.forward}` };
    }
    if (input.right < -1 || input.right > 1) {
      return { valid: false, reason: `Invalid right input: ${input.right}` };
    }
    return { valid: true };
  }
}
```

**Integration:** Add to `MessageHandler.ts` in `handleInput()`

**Cost:** Minimal
**Impact:** Prevents input manipulation

### 1.4 Rate Limiting

**File:** `server/src/Validation.ts`

```typescript
export class RateLimiter {
  private static readonly MAX_UPDATE_RATE = 30; // Hz
  private static readonly MIN_UPDATE_INTERVAL = 1000 / this.MAX_UPDATE_RATE; // ms

  static validateUpdateRate(timestamp: number, lastTimestamp: number): { valid: boolean; reason?: string } {
    const interval = timestamp - lastTimestamp;
    
    if (interval < this.MIN_UPDATE_INTERVAL) {
      const rate = 1000 / interval;
      return { valid: false, reason: `Update rate exceeded: ${rate.toFixed(0)} Hz (max: ${this.MAX_UPDATE_RATE} Hz)` };
    }

    return { valid: true };
  }
}
```

**Integration:** Add to `MessageHandler.ts` in all message handlers

**Cost:** Minimal
**Impact:** Prevents lag switching, spam attacks

### 1.5 Integration with MessageHandler

**File:** `server/src/MessageHandler.ts`

```typescript
import { PositionValidator, InputValidator, RateLimiter } from './Validation.js';

private handlePosition(playerId: string, data: any): void {
  const player = this.playerManager.getPlayer(playerId);
  if (!player) return;

  // Rate limiting
  const rateCheck = RateLimiter.validateUpdateRate(data.timestamp, player.lastUpdateTime);
  if (!rateCheck.valid) {
    console.warn(`[Validation] ${rateCheck.reason} for ${playerId}`);
    return;
  }

  // Speed validation
  const speedCheck = PositionValidator.validateSpeed(
    player.position,
    data.position,
    (data.timestamp - player.lastUpdateTime) / 1000
  );
  if (!speedCheck.valid) {
    console.warn(`[Validation] ${speedCheck.reason} for ${playerId}`);
    // Could kick player here
    return;
  }

  // Teleportation validation
  const teleportCheck = PositionValidator.validateTeleportation(
    player.position,
    data.position
  );
  if (!teleportCheck.valid) {
    console.warn(`[Validation] ${teleportCheck.reason} for ${playerId}`);
    // Could kick player here
    return;
  }

  // Accept position update
  // ... existing code
}

private handleInput(playerId: string, data: any): void {
  const player = this.playerManager.getPlayer(playerId);
  if (!player) return;

  // Input validation
  if (data.input) {
    const inputCheck = InputValidator.validateInput(data.input);
    if (!inputCheck.valid) {
      console.warn(`[Validation] ${inputCheck.reason} for ${playerId}`);
      return;
    }
  }

  // ... existing code
}
```

## Phase 2: Lightweight Server Physics (Short-term)

### 2.1 Basic Gravity Simulation

**File:** `server/src/ServerPhysics.ts` (new file)

```typescript
export class ServerPhysics {
  private static readonly GRAVITY = 9.81; // m/s²
  private static readonly IDLE_TIMEOUT = 2000; // ms

  static applyGravityToIdlePlayers(
    players: Map<string, any>,
    terrain: any,
    dt: number
  ): void {
    const now = Date.now();

    for (const [playerId, player] of players) {
      if (now - player.lastUpdateTime > this.IDLE_TIMEOUT) {
        // Apply gravity
        player.position.y -= this.GRAVITY * dt;

        // Basic ground check
        const groundY = terrain.getHeight(player.position.x, player.position.z);
        if (player.position.y < groundY) {
          player.position.y = groundY;
          player.velocity.y = 0;
        }
      }
    }
  }
}
```

**Integration:** Add to `GameLoop.ts` in `tick()`

**Cost:** Low (simple math, no collision detection)
**Impact:** Prevents hanging in mid-air when idle, fixes alt-tab issue

### 2.2 Terrain Height Validation

**File:** `server/src/Validation.ts`

```typescript
export class PositionValidator {
  private static readonly MAX_HEIGHT_ABOVE_GROUND = 50; // meters

  static validateTerrainHeight(
    position: { x: number; y: number; z: number },
    terrain: any
  ): { valid: boolean; reason?: string } {
    const groundY = terrain.getHeight(position.x, position.z);
    const maxY = groundY + this.MAX_HEIGHT_ABOVE_GROUND;

    if (position.y > maxY) {
      return { valid: false, reason: `Invalid height: ${position.y.toFixed(2)}m (max: ${maxY.toFixed(2)}m)` };
    }

    return { valid: true };
  }
}
```

**Integration:** Add to `MessageHandler.ts` in `handlePosition()`

**Cost:** Low (terrain height lookup)
**Impact:** Catches flight hacking

### 2.3 Terrain Data on Server

**File:** `server/src/Terrain.ts` (new file)

```typescript
export class ServerTerrain {
  private heightmap: Float32Array;
  private width: number;
  private height: number;
  private scale: number;

  constructor(heightmapData: Float32Array, width: number, height: number, scale: number) {
    this.heightmap = heightmapData;
    this.width = width;
    this.height = height;
    this.scale = scale;
  }

  getHeight(x: number, z: number): number {
    // Convert world coordinates to heightmap coordinates
    const mapX = Math.floor((x + this.width * this.scale / 2) / this.scale);
    const mapZ = Math.floor((z + this.height * this.scale / 2) / this.scale);

    // Clamp to bounds
    const clampedX = Math.max(0, Math.min(this.width - 1, mapX));
    const clampedZ = Math.max(0, Math.min(this.height - 1, mapZ));

    // Get height from heightmap
    const index = clampedZ * this.width + clampedX;
    return this.heightmap[index];
  }
}
```

**Integration:** Initialize in `Server.ts`, pass to validation functions

**Cost:** Low (memory for heightmap)
**Impact:** Enables terrain validation

## Phase 3: Behavioral Analysis (Medium-term)

### 3.1 Statistical Tracking

**File:** `server/src/PlayerStats.ts` (new file)

```typescript
export interface PlayerStats {
  playerId: string;
  averageSpeed: number;
  maxSpeed: number;
  teleportCount: number;
  suspiciousActivityCount: number;
  lastSpeedCheck: number;
}

export class StatsTracker {
  private stats: Map<string, PlayerStats> = new Map();
  private static readonly MAX_SPEED = 15.0;

  trackPlayerSpeed(playerId: string, speed: number): void {
    let stats = this.stats.get(playerId);
    if (!stats) {
      stats = {
        playerId,
        averageSpeed: speed,
        maxSpeed: speed,
        teleportCount: 0,
        suspiciousActivityCount: 0,
        lastSpeedCheck: Date.now()
      };
      this.stats.set(playerId, stats);
    }

    // Update average speed (exponential moving average)
    stats.averageSpeed = (stats.averageSpeed * 0.9) + (speed * 0.1);
    stats.maxSpeed = Math.max(stats.maxSpeed, speed);
    stats.lastSpeedCheck = Date.now();

    // Track suspicious activity
    if (speed > this.MAX_SPEED * 1.5) {
      stats.suspiciousActivityCount++;
    }
  }

  recordTeleportation(playerId: string): void {
    const stats = this.stats.get(playerId);
    if (stats) {
      stats.teleportCount++;
      stats.suspiciousActivityCount++;
    }
  }

  getStats(playerId: string): PlayerStats | undefined {
    return this.stats.get(playerId);
  }
}
```

**Integration:** Add to `MessageHandler.ts`, track on each position update

**Cost:** Minimal
**Impact:** Detects patterns, flag suspicious players

### 3.2 Kick/Ban System

**File:** `server/src/AntiCheat.ts` (new file)

```typescript
export class AntiCheat {
  private static readonly MAX_SUSPICIOUS_ACTIVITY = 10;
  private static readonly MAX_TELEPORTS = 5;

  static checkAndKickSuspiciousPlayer(
    playerId: string,
    stats: PlayerStats,
    kickCallback: (playerId: string, reason: string) => void
  ): void {
    if (stats.suspiciousActivityCount > this.MAX_SUSPICIOUS_ACTIVITY) {
      const reason = `Excessive suspicious activity (${stats.suspiciousActivityCount} incidents)`;
      console.warn(`[AntiCheat] Kicking ${playerId}: ${reason}`);
      kickCallback(playerId, reason);
    }

    if (stats.teleportCount > this.MAX_TELEPORTS) {
      const reason = `Excessive teleportations (${stats.teleportCount} incidents)`;
      console.warn(`[AntiCheat] Kicking ${playerId}: ${reason}`);
      kickCallback(playerId, reason);
    }
  }
}
```

**Integration:** Add to `MessageHandler.ts`, check after each validation failure

**Cost:** Minimal
**Impact:** Removes cheaters from game

## Implementation Timeline

### Week 1: Phase 1 (Basic Validation)
- Day 1-2: Create `Validation.ts`, implement speed and teleportation validation
- Day 3: Implement input validation and rate limiting
- Day 4-5: Integrate with `MessageHandler.ts`, test
- **Result:** 60-70% cheat detection

### Week 2: Phase 2 (Lightweight Physics)
- Day 1-2: Create `ServerPhysics.ts`, implement gravity simulation
- Day 3: Create `ServerTerrain.ts`, implement height validation
- Day 4-5: Integrate with `GameLoop.ts` and `MessageHandler.ts`, test
- **Result:** 80-90% cheat detection, fixes alt-tab issue

### Week 3: Phase 3 (Behavioral Analysis)
- Day 1-2: Create `PlayerStats.ts`, implement statistical tracking
- Day 3: Create `AntiCheat.ts`, implement kick/ban system
- Day 4-5: Integrate with `MessageHandler.ts`, test
- **Result:** Sophisticated cheat detection, auto-kick

## Testing Strategy

### Unit Tests
- Test each validation function with valid and invalid inputs
- Test edge cases (boundary values)
- Test performance (ensure no significant CPU impact)

### Integration Tests
- Test validation in game loop
- Test reconciliation with validation failures
- Test kick/ban system

### Security Tests
- Simulate speed hacking
- Simulate teleportation
- Simulate input manipulation
- Verify detection and kicking

## Cost Impact Analysis

### Server CPU Impact
- **Phase 1:** +5% (simple math)
- **Phase 2:** +10-15% (gravity simulation, terrain lookups)
- **Phase 3:** +5% (statistical tracking)
- **Total:** +20-25% server CPU

### DigitalOcean Cost Impact
- **Current:** $4/month per 200 players
- **With validation:** $4/month per ~160 players (25% fewer players per droplet)
- **For 1,000 players:** 7 droplets instead of 5 = $28/month instead of $20/month
- **Additional cost:** $8/month for 1,000 concurrent players

### ROI Analysis
- **Security improvement:** From critical to high (80-90% cheat detection)
- **Cost increase:** $8/month for 1,000 players
- **Value:** Prevents game-breaking cheats, maintains fair gameplay
- **Conclusion:** Acceptable cost for significant security improvement

## Risk Mitigation

### False Positives
- **Risk:** Legitimate players flagged as cheaters
- **Mitigation:** 
  - Set conservative thresholds (MAX_SPEED = 15m/s is generous)
  - Require multiple violations before kicking
  - Log warnings before kicking
  - Allow appeal process

### Performance Impact
- **Risk:** Validation slows down game loop
- **Mitigation:**
  - Keep validation simple (no complex physics)
  - Profile and optimize hot paths
  - Cache terrain height lookups
  - Use efficient data structures

### Compatibility
- **Risk:** Validation breaks legitimate gameplay
- **Mitigation:**
  - Test with normal gameplay
  - Adjust thresholds based on testing
  - Monitor validation logs
  - Gradual rollout with monitoring

## Success Metrics

### Security Metrics
- **Cheat detection rate:** Target 80-90%
- **False positive rate:** Target <5%
- **Time to kick:** Target <30 seconds after detection

### Performance Metrics
- **Server CPU increase:** Target <25%
- **Tick rate stability:** Maintain 15Hz
- **Player capacity:** Target >150 players per droplet

### UX Metrics
- **Client responsiveness:** Maintain LAN-like feel
- **Reconciliation smoothness:** No noticeable snaps
- **Player satisfaction:** Monitor feedback

## Conclusion

This implementation plan provides a **balanced approach** to security:
- **Maintains client-driven LAN-like feel** (excellent responsiveness)
- **Adds effective server validation** (80-90% cheat detection)
- **Acceptable cost increase** (+20-25% server CPU)
- **Phased implementation** (gradual rollout, manageable scope)

The plan aligns with the cost-conscious approach of Narrow.one while providing significantly better security than the current vulnerable implementation. The three-phase approach allows for incremental improvement and risk mitigation.
