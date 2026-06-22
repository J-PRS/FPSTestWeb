# WYSIWYG Shooting and Movement: LAN-Like Feel Without Lag

**Date:** 2026-06-22
**Objective:** Analyze and implement "What You See Is What You Get" shooting and movement where the local player never feels lag

## Problem Statement

In competitive FPS games, the worst experience is:
- Shooting at a player and missing due to lag
- Pressing a key and movement feeling delayed
- Projectiles not going where you aimed
- Feeling "rubber-banded" or snapped around

**Goal:** Make the local player's experience feel instant, like playing on LAN, while maintaining server authority for fairness.

## Core Principles

### 1. Client-Side Prediction (Instant Feedback)
**Principle:** The client immediately processes input and shows the result locally, without waiting for server confirmation.

**Why it works:**
- Input → Immediate visual feedback (0ms delay)
- Later: Server confirms or corrects
- Player feels instant response

**Example:**
```typescript
// Player presses W
// IMMEDIATE (0ms):
player.vel.x += acceleration;
// Visual: Player starts moving forward

// LATER (50-100ms):
// Server confirms position
// If different, reconcile (snap or smooth correction)
```

### 2. Server Authority (Fairness)
**Principle:** Server is the source of truth for game state, but client predicts locally.

**Why it works:**
- Prevents cheating
- Ensures fair gameplay
- Client prediction provides responsiveness
- Server reconciliation ensures correctness

### 3. Lag Compensation (Hit Accuracy)
**Principle:** Server rewinds time to when the shot was fired to validate hits.

**Why it works:**
- Compensates for network latency
- "What you see is what you hit"
- Validates shots against historical positions

## Current Implementation Analysis

### Movement (Local Player)

**Current Status:** PARTIAL

**What works:**
- ✓ Client-side physics simulation (`movement.ts`)
- ✓ Immediate input processing
- ✓ Local player updates at 60Hz (render loop)
- ✓ Client sends position updates to server

**What's missing:**
- ✗ Client-side prediction with input replay
- ✗ Server reconciliation for position correction
- ✗ Smooth correction (currently snaps)

**Current experience:**
- Movement feels responsive (good)
- But if server disagrees, player snaps (bad)
- No input replay to smooth corrections

### Shooting (Local Player)

**Current Status:** PARTIAL

**What works:**
- ✓ Client-side projectile creation (`pendingLocalRockets`)
- ✓ Server-side lag compensation (rewind buffer)
- ✓ Server validates hits
- ✓ Client shows projectiles immediately

**What's missing:**
- ✗ Client-side hit confirmation (show hit marker immediately)
- ✗ Client-side hit detection (raycast on client)
- ✗ Projectile interpolation for smooth movement
- ✗ 15Hz tick rate (too low for competitive shooting)

**Current experience:**
- Projectiles appear immediately (good)
- But hit confirmation waits for server (bad)
- 15Hz tick rate causes accuracy issues (bad)

### Movement (Remote Players)

**Current Status:** PARTIAL

**What works:**
- ✓ Remote player interpolation (`RemotePlayer.update`)
- ✓ Server sends position updates
- ✓ Delta compression for bandwidth

**What's missing:**
- ✗ Extrapolation (predict movement between updates)
- ✗ Higher tick rate (15Hz is low)
- ✗ Smooth interpolation parameters

**Current experience:**
- Remote players move somewhat smoothly
- But can appear jerky at 15Hz
- No prediction between updates

## What Makes WYSIWYG Shooting

### 1. Client-Side Hit Detection

**How it works:**
```typescript
// Client fires weapon
// IMMEDIATE (0ms):
const hit = raycastFromCamera();
if (hit) {
  showHitMarker(); // Instant feedback
  playHitSound();
}

// LATER (50-100ms):
// Server validates hit
// If server disagrees, remove hit marker
```

**Benefits:**
- Instant feedback
- Player feels shots connect immediately
- Server validates for fairness

**Trade-off:**
- False positives (client thinks hit, server disagrees)
- Need to handle hit marker removal

### 2. Client-Side Hit Confirmation

**How it works:**
```typescript
// Client fires and hits
showHitMarker();
playHitSound();

// Server validates
if (serverConfirmsHit) {
  // Keep hit marker
  applyDamage();
} else {
  // Remove hit marker
  hideHitMarker();
}
```

**Benefits:**
- Psychological satisfaction
- Reduces perceived lag
- Better shooting feel

### 3. High Tick Rate

**Why it matters:**
- At 15Hz: 67ms between updates
- At 30Hz: 33ms between updates
- At 60Hz: 16ms between updates

**Impact on shooting:**
- Player moving at 10m/s:
  - 15Hz: 0.67m between updates (can miss shots)
  - 30Hz: 0.33m between updates (better accuracy)
  - 60Hz: 0.17m between updates (excellent accuracy)

**Cost analysis:**
- 15Hz: Baseline cost
- 30Hz: 2x CPU cost
- 60Hz: 4x CPU cost

**Recommendation:** 30Hz (balance of cost and accuracy)

### 4. Projectile Interpolation

**How it works:**
```typescript
// Server sends projectile updates at 15Hz
// Client interpolates between updates at 60Hz
function interpolateProjectile(projectile, dt) {
  const t = (now - lastUpdateTime) / (updateInterval);
  projectile.position = lerp(lastPosition, targetPosition, t);
}
```

**Benefits:**
- Smooth projectile movement
- Reduces jerkiness
- Better visual accuracy

## What Makes WYSIWYG Movement

### 1. Client-Side Prediction with Input Replay

**How it works:**
```typescript
// Client stores input history
inputHistory = [
  { seq: 1, input: { forward: 1 }, timestamp: 1000 },
  { seq: 2, input: { forward: 1 }, timestamp: 1016 },
  { seq: 3, input: { forward: 0 }, timestamp: 1032 },
];

// Server reconciles with sequence 2
// Client replays unprocessed inputs (seq 3+)
function reconcile(serverState, lastProcessedSeq) {
  player.position = serverState.position;
  
  // Replay unprocessed inputs
  for (const input of inputHistory) {
    if (input.seq > lastProcessedSeq) {
      simulatePhysics(input);
    }
  }
}
```

**Benefits:**
- Smooth corrections (no snapping)
- Maintains prediction
- Player never feels out of control

**Complexity:** Medium (need input replay system)

### 2. Instant Input Processing

**How it works:**
```typescript
// Input event
document.addEventListener('keydown', (e) => {
  // IMMEDIATE (0ms):
  processInput(e.code);
  updatePlayerVelocity();
  // Visual: Player starts moving
});
```

**Benefits:**
- Zero perceived input delay
- Instant feedback
- LAN-like feel

### 3. High Refresh Rate Rendering

**How it works:**
```typescript
// Render at monitor refresh rate (60Hz, 120Hz, 144Hz)
function renderLoop() {
  requestAnimationFrame(renderLoop);
  updateVisuals();
  render();
}
```

**Benefits:**
- Smooth visual updates
- Reduces motion blur
- Better tracking of fast movement

## Implementation Plan

### Phase 1: Client-Side Hit Confirmation (Immediate Impact)

**1.1 Add Client-Side Hit Detection**
```typescript
// client/src/main.ts
function fireWeapon() {
  // Raycast from camera
  const hit = raycastFromCamera();
  
  if (hit) {
    // IMMEDIATE feedback
    showHitMarker();
    playHitSound();
    
    // Store for server validation
    pendingHits.push({
      targetId: hit.playerId,
      timestamp: Date.now()
    });
  }
  
  // Send shot to server
  networkManager.sendShot(hit?.playerId, position, velocity);
}
```

**1.2 Handle Server Hit Validation**
```typescript
// client/src/main.ts
networkManager.onPlayerHit = (shooterId, targetId, damage) => {
  if (shooterId === localPlayerId) {
    // Server confirmed hit
    // Keep hit marker (already shown)
    applyDamageEffect(targetId);
  }
};

// If server doesn't confirm hit within timeout
setTimeout(() => {
  // Remove unconfirmed hit markers
  removeUnconfirmedHitMarkers();
}, 200); // 200ms timeout
```

**Cost:** Minimal (client-side only)
**Impact:** Massive (instant shooting feedback)

### Phase 2: Increase Tick Rate (Medium Impact, Medium Cost)

**2.1 Update Server Tick Rate**
```typescript
// server/src/Server.ts
const TICK_RATE = 30; // Increased from 15Hz to 30Hz
```

**2.2 Update Client Send Rate**
```typescript
// client/src/networking/NetworkManager.ts
private readonly POSITION_SEND_INTERVAL = 33; // 30Hz = 33ms
```

**Cost:** 2x server CPU
**Impact:** 2x shooting accuracy, smoother movement

### Phase 3: Input Replay for Smooth Reconciliation (High Impact, Medium Complexity)

**3.1 Store Input History**
```typescript
// client/src/networking/NetworkManager.ts
private inputHistory: Map<number, { input: any; timestamp: number }> = new Map();

sendInput(input: InputState): void {
  const sequence = this.inputSequence++;
  this.inputHistory.set(sequence, { input, timestamp });
  // ... send to server
}
```

**3.2 Replay Inputs on Reconciliation**
```typescript
// client/src/main.ts
networkManager.onStateReconciliation = (state) => {
  // Set to server position
  player.pos.set(state.position.x, state.position.y, state.position.z);
  player.vel.set(state.velocity.x, state.velocity.y, state.velocity.z);
  
  // Replay unprocessed inputs
  const unprocessedInputs = networkManager.getUnprocessedInputs(state.lastProcessedSequence);
  for (const input of unprocessedInputs) {
    player.applyInput(input.input);
    player.update(0.016); // Simulate one frame
  }
};
```

**Cost:** Minimal (client-side only)
**Impact:** Smooth corrections, no snapping

### Phase 4: Projectile Interpolation (Medium Impact, Low Complexity)

**4.1 Add Interpolation to Projectiles**
```typescript
// client/src/main.ts
class InterpolatedProjectile {
  private lastPosition: Vector3;
  private targetPosition: Vector3;
  private lastUpdateTime: number;
  
  update(targetPosition: Vector3, timestamp: number) {
    this.lastPosition = this.position.clone();
    this.targetPosition = targetPosition;
    this.lastUpdateTime = timestamp;
  }
  
  render(now: number) {
    const t = (now - this.lastUpdateTime) / 33; // 33ms = 30Hz
    this.position.lerpVectors(this.lastPosition, this.targetPosition, t);
  }
}
```

**Cost:** Minimal
**Impact:** Smooth projectile movement

## Cost vs Quality Trade-offs

### Option 1: Minimal Changes (Current + Hit Confirmation)
- **Cost:** +0% server CPU, minimal client CPU
- **Quality:** Good (instant hit feedback)
- **Experience:** Shooting feels instant, movement feels responsive
- **Recommendation:** Start here

### Option 2: Balanced (Current + Hit Confirmation + 30Hz)
- **Cost:** +100% server CPU (2x)
- **Quality:** Very Good (instant feedback + better accuracy)
- **Experience:** Shooting feels instant and accurate
- **Recommendation:** Target for production

### Option 3: Optimal (All phases)
- **Cost:** +100% server CPU, minimal client CPU
- **Quality:** Excellent (instant feedback + high accuracy + smooth corrections)
- **Experience:** Near-LAN feel
- **Recommendation:** Long-term goal

## Technical Challenges

### 1. False Positives in Hit Detection
**Problem:** Client thinks hit, server disagrees
**Solution:** Show hit marker immediately, remove if server disagrees within 200ms

### 2. Input Replay Complexity
**Problem:** Need deterministic physics for replay
**Solution:** Ensure physics is deterministic (fixed timestep, no randomness)

### 3. Server CPU Cost
**Problem:** Higher tick rate increases cost
**Solution:** Start with 30Hz (2x cost), monitor performance, consider 60Hz if needed

### 4. Network Bandwidth
**Problem:** Higher tick rate increases bandwidth
**Solution:** Delta compression (already implemented), further optimization if needed

## Comparison with Industry Standards

### Krunker.io
- **Tick rate:** ~20-30Hz
- **Client-side prediction:** Yes
- **Hit confirmation:** Client-side (immediate)
- **Experience:** Very responsive shooting

### Narrow.one
- **Tick rate:** Unknown (likely 15-30Hz for cost)
- **Client-side prediction:** Likely
- **Hit confirmation:** Unknown
- **Experience:** Good (cost-conscious approach)

### CS:GO / Valorant
- **Tick rate:** 64Hz (competitive), 128Hz (professional)
- **Client-side prediction:** Yes
- **Hit confirmation:** Client-side with server validation
- **Experience:** Excellent (high server cost)

## Success Metrics

### Shooting Metrics
- **Hit confirmation latency:** Target <50ms (client-side)
- **Hit accuracy:** Target >90% (what you see is what you hit)
- **False positive rate:** Target <5% (client thinks hit, server disagrees)

### Movement Metrics
- **Input latency:** Target <16ms (immediate processing)
- **Reconciliation smoothness:** No noticeable snaps
- **Position accuracy:** Target <0.5m error

### Player Experience Metrics
- **Perceived lag:** Target "feels like LAN"
- **Shooting satisfaction:** Target "instant feedback"
- **Movement responsiveness:** Target "instant control"

## Implementation Priority

### Immediate (Week 1)
1. Client-side hit detection
2. Client-side hit confirmation
3. Hit marker removal on server disagreement

### Short-term (Week 2)
1. Increase tick rate to 30Hz
2. Update client send rate
3. Monitor server CPU impact

### Medium-term (Week 3-4)
1. Input replay system
2. Smooth reconciliation
3. Projectile interpolation

## Conclusion

Achieving WYSIWYG shooting and movement requires:
1. **Client-side prediction** (instant feedback)
2. **Client-side hit confirmation** (psychological satisfaction)
3. **Higher tick rate** (accuracy)
4. **Input replay** (smooth corrections)
5. **Lag compensation** (hit validation)

The current implementation has good foundations (client-side physics, lag compensation). Adding client-side hit confirmation and increasing the tick rate to 30Hz will provide 80% of the WYSIWYG experience with acceptable cost increase (+100% server CPU).

**Recommendation:** Start with Phase 1 (hit confirmation) for immediate impact, then Phase 2 (30Hz tick rate) for accuracy. This provides excellent shooting feel while maintaining cost constraints suitable for DigitalOcean hosting.
