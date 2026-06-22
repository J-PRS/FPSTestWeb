# Tick Rate Optimization for Cost Reduction

**Date:** June 22, 2026  
**Purpose:** Strategies for reducing server costs through lower tick rates while maintaining smooth gameplay via client-side techniques

---

## Executive Summary

Server tick rate is one of the largest cost drivers for multiplayer FPS games. By reducing server tick rates from 60-128 tick/s to 20-30 tick/s and relying on client-side prediction, interpolation, and lag compensation, you can achieve **50-75% cost reduction** while maintaining smooth gameplay and server authority for anti-cheat.

**Key Findings:**
- 20 tick/s: ~67% bandwidth reduction vs 60 tick/s, acceptable for casual FPS
- 30 tick/s: ~50% bandwidth reduction vs 60 tick/s, good balance for most games
- Client-side techniques (prediction, interpolation) mask lower tick rates
- Server remains authoritative for critical actions (shots, hits, movement validation)

---

## Tick Rate vs Cost Analysis

### Server Cost Drivers

| Tick Rate | CPU Usage | Memory Usage | Bandwidth/Player | Cost Multiplier |
|-----------|-----------|--------------|------------------|-----------------|
| 20 tick/s | Baseline | Baseline | Baseline | 1.0x |
| 30 tick/s | 1.5x | 1.2x | 1.5x | 1.4x |
| 60 tick/s | 3.0x | 1.5x | 3.0x | 2.8x |
| 128 tick/s | 6.4x | 2.0x | 6.4x | 5.8x |

**Assumptions:**
- Linear CPU scaling with tick rate (simplified)
- Memory usage scales sub-linearly (state shared between ticks)
- Bandwidth scales linearly with tick rate
- Cost includes compute, memory, and network egress

### Bandwidth Savings with Delta Encoding

Your `POSITION_DELTA` encoding compounds tick rate savings:

| Tick Rate | Full Position (bytes) | Delta Position (bytes) | Savings |
|-----------|----------------------|----------------------|---------|
| 20 tick/s | 30 bytes × 20 = 600 | 12 bytes × 20 = 240 | 60% |
| 30 tick/s | 30 bytes × 30 = 900 | 12 bytes × 30 = 360 | 60% |
| 60 tick/s | 30 bytes × 60 = 1800 | 12 bytes × 60 = 720 | 60% |

**Combined savings (30 tick/s + delta encoding):**
- Baseline (60 tick/s, full position): 1800 bytes/s
- Optimized (30 tick/s, delta encoding): 360 bytes/s
- **Total reduction: 80%**

---

## Client-Side Techniques

### 1. Client-Side Prediction

**Purpose:** Provide instant feedback for local player actions despite network latency.

**How it works:**
1. Client sends input to server
2. Client immediately applies input locally (prediction)
3. Server processes input and sends authoritative state
4. Client reconciles prediction with server state
5. If prediction was wrong, client corrects (reconciliation)

**Implementation:**
```typescript
// Client-side prediction for movement
function predictMovement(input: Input, currentState: PlayerState): PlayerState {
  const predicted = { ...currentState };
  
  // Apply input immediately
  if (input.forward) predicted.position.z -= input.speed * dt;
  if (input.backward) predicted.position.z += input.speed * dt;
  if (input.left) predicted.position.x -= input.speed * dt;
  if (input.right) predicted.position.x += input.speed * dt;
  
  // Apply rotation
  predicted.rotation.yaw += input.yawDelta;
  predicted.rotation.pitch += input.pitchDelta;
  
  return predicted;
}

// Reconciliation when server state arrives
function reconcile(serverState: PlayerState, predictedState: PlayerState): PlayerState {
  const error = Math.abs(serverState.position.x - predictedState.position.x);
  
  if (error > RECONCILIATION_THRESHOLD) {
    // Snap to server state (hard correction)
    return serverState;
  } else {
    // Smooth correction (soft)
    return lerp(predictedState, serverState, 0.2);
  }
}
```

**Benefits:**
- Instant feedback (0ms perceived latency)
- Smooth movement regardless of network conditions
- Player feels responsive even at 20-30 tick/s

**Trade-offs:**
- Prediction errors visible when network is poor
- Requires reconciliation logic
- More complex client code

### 2. Snapshot Interpolation

**Purpose:** Smoothly render other players between server updates.

**How it works:**
1. Server sends position updates at 20-30 tick/s
2. Client renders at 60-144 FPS
3. Client interpolates between two server snapshots
4. Entities appear smooth despite low tick rate

**Implementation:**
```typescript
class Interpolator {
  private snapshots: Map<string, Snapshot[]> = new Map();
  private interpolationDelay = 100; // ms delay for smoothness

  addSnapshot(playerId: string, state: PlayerState, timestamp: number) {
    if (!this.snapshots.has(playerId)) {
      this.snapshots.set(playerId, []);
    }
    this.snapshots.get(playerId)!.push({ state, timestamp });
    
    // Keep only last 2 snapshots
    if (this.snapshots.get(playerId)!.length > 2) {
      this.snapshots.get(playerId)!.shift();
    }
  }

  getInterpolatedState(playerId: string, currentTime: number): PlayerState | null {
    const snapshots = this.snapshots.get(playerId);
    if (!snapshots || snapshots.length < 2) return null;

    const [older, newer] = snapshots;
    const renderTime = currentTime - this.interpolationDelay;

    if (renderTime < older.timestamp) return older.state;
    if (renderTime >= newer.timestamp) return newer.state;

    const alpha = (renderTime - older.timestamp) / (newer.timestamp - older.timestamp);
    return this.lerp(older.state, newer.state, alpha);
  }

  private lerp(a: PlayerState, b: PlayerState, t: number): PlayerState {
    return {
      position: {
        x: a.position.x + (b.position.x - a.position.x) * t,
        y: a.position.y + (b.position.y - a.position.y) * t,
        z: a.position.z + (b.position.z - a.position.z) * t,
      },
      rotation: {
        yaw: a.rotation.yaw + (b.rotation.yaw - a.rotation.yaw) * t,
        pitch: a.rotation.pitch + (b.rotation.pitch - a.rotation.pitch) * t,
      },
    };
  }
}
```

**Benefits:**
- Smooth rendering at any tick rate
- Eliminates "teleporting" entities
- 30 tick/s can look as smooth as 60 tick/s

**Trade-offs:**
- 100ms interpolation delay adds perceived latency
- More complex client code
- Requires buffer management

### 3. Lag Compensation

**Purpose:** Server validates hits based on client's perspective, not server's current time.

**How it works:**
1. Client sends shot with timestamp
2. Server rewinds simulation to client's timestamp
3. Server checks if shot would have hit at that time
4. Server applies damage if hit was valid
5. Server fast-forwards to current time

**Implementation:**
```typescript
// Server-side lag compensation
function processShot(shot: ShotMessage, gameState: GameState): boolean {
  const clientLatency = Date.now() - shot.timestamp;
  const rewindTime = shot.timestamp;
  
  // Save current state
  const currentState = gameState.clone();
  
  // Rewind to client's timestamp
  gameState.rewind(rewindTime);
  
  // Check if shot hits at that time
  const target = gameState.getPlayer(shot.targetId);
  const hit = checkHit(shot.position, shot.direction, target);
  
  // Restore current state
  gameState.restore(currentState);
  
  if (hit) {
    gameState.applyDamage(shot.targetId, shot.damage);
    return true;
  }
  
  return false;
}
```

**Benefits:**
- Fair hit registration regardless of latency
- Players don't feel "shot around corners"
- Works well at any tick rate

**Trade-offs:**
- Complex server logic
- Requires state history for rewinding
- Can be exploited if not carefully implemented

### 4. Extrapolation

**Purpose:** Predict entity positions beyond last known snapshot.

**How it works:**
1. Client receives position update
2. Client calculates velocity from last two updates
3. Client extrapolates position based on velocity
4. When new update arrives, corrects if needed

**Implementation:**
```typescript
function extrapolate(
  lastState: PlayerState,
  previousState: PlayerState,
  dt: number
): PlayerState {
  const velocity = {
    x: (lastState.position.x - previousState.position.x) / dt,
    y: (lastState.position.y - previousState.position.y) / dt,
    z: (lastState.position.z - previousState.position.z) / dt,
  };

  return {
    ...lastState,
    position: {
      x: lastState.position.x + velocity.x * dt,
      y: lastState.position.y + velocity.y * dt,
      z: lastState.position.z + velocity.z * dt,
    },
  };
}
```

**Benefits:**
- Reduces perceived latency
- Smoother movement during packet loss
- Works well with interpolation

**Trade-offs:**
- Predictions can be wrong
- Requires correction logic
- Can cause "rubber-banding" if wrong

---

## Recommended Configurations

### Casual FPS (20 tick/s)

**Server:**
- Tick rate: 20 tick/s (50ms interval)
- Authority: Full (movement, shots, hits)
- Lag compensation: 100-150ms rewind
- State updates: Delta-encoded POSITION_DELTA

**Client:**
- Render rate: 60-144 FPS
- Prediction: Full client-side prediction
- Interpolation: 100ms delay
- Extrapolation: Optional for packet loss

**Cost:** ~67% reduction vs 60 tick/s  
**Latency:** ~100-150ms perceived  
**Use case:** Casual games, co-op, non-competitive

### Balanced FPS (30 tick/s)

**Server:**
- Tick rate: 30 tick/s (33ms interval)
- Authority: Full (movement, shots, hits)
- Lag compensation: 50-100ms rewind
- State updates: Delta-encoded POSITION_DELTA

**Client:**
- Render rate: 60-144 FPS
- Prediction: Full client-side prediction
- Interpolation: 50-100ms delay
- Extrapolation: Enabled for packet loss

**Cost:** ~50% reduction vs 60 tick/s  
**Latency:** ~50-100ms perceived  
**Use case:** Most multiplayer FPS, competitive play

### Competitive FPS (60 tick/s)

**Server:**
- Tick rate: 60 tick/s (16ms interval)
- Authority: Full (movement, shots, hits)
- Lag compensation: 50ms rewind
- State updates: Delta-encoded POSITION_DELTA

**Client:**
- Render rate: 120-240 FPS
- Prediction: Full client-side prediction
- Interpolation: 50ms delay
- Extrapolation: Enabled

**Cost:** Baseline  
**Latency:** ~50ms perceived  
**Use case:** Competitive play, esports

### High-End Competitive (128 tick/s)

**Server:**
- Tick rate: 128 tick/s (7.8ms interval)
- Authority: Full (movement, shots, hits)
- Lag compensation: 20-50ms rewind
- State updates: Delta-encoded POSITION_DELTA

**Client:**
- Render rate: 240+ FPS
- Prediction: Full client-side prediction
- Interpolation: 20-50ms delay
- Extrapolation: Enabled

**Cost:** ~5.8x vs 20 tick/s  
**Latency:** ~20-50ms perceived  
**Use case:** Professional esports (Valorant-level)

---

## Implementation Roadmap

### Phase 1: Basic Optimization (30 tick/s)

**Server:**
- Implement 30 tick/s game loop
- Add delta encoding for position updates
- Implement basic lag compensation (50ms rewind)

**Client:**
- Implement client-side prediction for movement
- Add snapshot interpolation (100ms delay)
- Add basic reconciliation

**Expected savings:** 50% cost reduction

### Phase 2: Advanced Smoothing

**Client:**
- Add extrapolation for packet loss
- Implement adaptive interpolation delay
- Add visual smoothing for rotation

**Server:**
- Optimize state serialization
- Add interest management (only send nearby players)

**Expected savings:** Additional 10-20% bandwidth reduction

### Phase 3: Cost Optimization (20 tick/s)

**Server:**
- Reduce to 20 tick/s
- Increase lag compensation to 100-150ms
- Add more aggressive delta encoding

**Client:**
- Increase interpolation delay to 150ms
- Add more sophisticated prediction
- Implement client-side hit validation (visual only)

**Expected savings:** Additional 33% cost reduction (67% total vs 60 tick/s)

---

## Monitoring and Metrics

### Key Metrics to Track

**Server-side:**
- Tick rate consistency (should be stable)
- CPU usage per player
- Memory usage per player
- Bandwidth per player
- Packet loss rate
- Average latency

**Client-side:**
- Perceived latency (input to visual feedback)
- Prediction error rate
- Interpolation buffer health
- Extrapolation accuracy
- Rubber-banding events

**Business metrics:**
- Cost per player-hour
- Server utilization
- Player retention by latency tier
- Complaint rate about lag

### Alerts

**Critical:**
- Tick rate drops below target
- CPU usage > 80%
- Packet loss > 5%
- Average latency > 200ms

**Warning:**
- Prediction error rate > 10%
- Rubber-banding events > 5/min
- Bandwidth per player > 2KB/s

---

## Trade-offs Summary

| Aspect | 20 tick/s | 30 tick/s | 60 tick/s | 128 tick/s |
|--------|-----------|-----------|-----------|------------|
| Cost | 1.0x | 1.4x | 2.8x | 5.8x |
| Bandwidth | 1.0x | 1.5x | 3.0x | 6.4x |
| Perceived latency | 100-150ms | 50-100ms | 50ms | 20-50ms |
| Hit registration | Good | Good | Excellent | Excellent |
| Movement smoothness | Good | Excellent | Excellent | Excellent |
| Competitive viability | Low | Good | High | Very High |

---

## Conclusion

Reducing server tick rate from 60-128 tick/s to 20-30 tick/s is a highly effective cost optimization strategy when combined with client-side prediction, interpolation, and lag compensation.

**Recommendation:** Start with **30 tick/s** as a balanced configuration:
- 50% cost reduction vs 60 tick/s
- Good competitive viability
- Smooth gameplay with client-side techniques
- Easy to scale to 20 tick/s if needed

**For your project:**
- Your `POSITION_DELTA` encoding is perfect for this optimization
- 30 tick/s with delta encoding = 80% total bandwidth reduction
- Client-side prediction masks the lower tick rate
- Server remains authoritative for anti-cheat

This approach lets you scale more players per server instance while maintaining smooth gameplay and competitive integrity.

---

## References

- Source Multiplayer Networking: https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking
- Netcode: https://en.wikipedia.org/wiki/Netcode
- Server Tick Rate: https://bufferspeed.com/learn/server-tick-rate
- Gaffer On Games: Networked Physics (https://gafferongames.com/post/networked_physics/)
- Fast-Paced Multiplayer: https://www.gabrielgambetta.com/client-side-prediction-and-server-reconciliation.html
