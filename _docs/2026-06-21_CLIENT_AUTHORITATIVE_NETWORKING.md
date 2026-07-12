# Client-Authoritative Networking with Server Validation

## Overview

This document describes the networking architecture for responsive browser-based FPS games, focusing on the client-authoritative approach with server validation that enables "LAN-like" feel regardless of network conditions.

## Core Philosophy

**Client is the source of feel, server is the source of truth.**

- Client processes everything immediately for instant feedback
- Server validates and authorizes the final game state
- Trust client for responsiveness, verify server-side for security

## Attacker-Side Hit Detection

**Critical Principle**: If it looks like a hit on your screen, it's a hit.

### How It Works

1. **Client** calculates hit locally
2. **Client** shows hit marker immediately
3. **Server** trusts client's hit calculation
4. **Victim** might see themselves die "unfairly" (around corner, behind cover)
5. **Shooter** always gets the hit they saw

### Why This Works

- **Shooter satisfaction** - you never feel cheated
- **Responsive combat** - instant feedback
- **Skill expression** - your aim matters
- **Fairness trade-off** - victim takes the hit for shooter's good experience

### Examples

- **CS:GO** - Attacker-side hit detection (mostly)
- **Krunker** - Client-side hits
- **Valorant** - Hybrid but leans attacker-side
- **Overwatch** - Server-side (feels worse for shooter)

### The "Die Around Corner" Problem

Victim perspective:
- They run behind cover
- They think they're safe
- They die anyway (shooter saw them exposed)

This is **acceptable** because:
- Shooter had to aim and time the shot
- Shooter's experience is prioritized
- It's a shooter game, not a hiding game

### Priority Order

1. **Shooter feel** - What you see is what you get
2. **Movement feel** - Raw input, instant response
3. **Victim experience** - Secondary concern

This is the right call for a competitive shooter. Fairness is less important than satisfying the core loop: aiming and shooting.

### Cost-Benefit Analysis

**If shooter is NOT prioritized:**
- Every single hit feels wrong
- Ruins the entire game for everyone
- Core gameplay loop is broken

**If victim is NOT prioritized:**
- Only apparent in rare cases (behind corner)
- Affects small subset of players at specific times
- Most of the time, victim can't even tell

**Conclusion:** Prioritizing shooter feel is the clear choice - it's the difference between breaking the game for everyone vs. minor unfairness in edge cases.

## Architecture

### Client Responsibilities

1. **Input Processing**
   - Raw mouse input (no smoothing, no acceleration)
   - Immediate movement calculation
   - Instant shooting feedback

2. **Local Simulation**
   - Full physics simulation locally
   - Client-side hit detection
   - Movement prediction
   - Visual effects (muzzle flash, hit markers)

3. **Network Communication**
   - Send input sequences to server (not positions)
   - Receive authoritative state from server
   - Interpolate other players' positions
   - Smooth corrections when needed

### Server Responsibilities

1. **Input Processing**
   - Receive client input sequences
   - Run same physics simulation
   - Validate all actions
   - Detect cheating

2. **Authoritative State**
   - Maintain true game state
   - Broadcast to all clients
   - Handle lag compensation
   - Resolve conflicts

3. **Anti-Cheat**
   - Validate movement (speed, position)
   - Verify shots (was player actually there?)
   - Check resource constraints (ammo, health)
   - Rate limiting

## Key Techniques

### 1. Client-Side Prediction

Client predicts the result of actions before server confirmation:

```typescript
// Client
function processInput(input) {
  // Apply immediately
  localState.velocity += input.movement;
  localState.position += localState.velocity * dt;
  
  // Send to server
  sendToServer({
    type: 'input',
    sequence: inputSequence++,
    input: input
  });
}

// When server confirmation arrives
function onServerState(state) {
  if (state.sequence > lastConfirmedSequence) {
    // Reconcile if prediction was wrong
    if (distance(state.position, localState.position) > threshold) {
      smoothCorrection(state.position);
    }
    lastConfirmedSequence = state.sequence;
  }
}
```

### 2. Interpolation

Smooth other players' movement between server updates:

```typescript
// Buffer of server states
const stateBuffer = [];

function update() {
  const renderTime = currentTime - interpolationDelay;
  
  // Find two states to interpolate between
  const stateA = findStateBefore(renderTime);
  const stateB = findStateAfter(renderTime);
  
  if (stateA && stateB) {
    const t = (renderTime - stateA.time) / (stateB.time - stateA.time);
    otherPlayer.position = lerp(stateA.position, stateB.position, t);
  }
}
```

### 3. Lag Compensation

Server rewinds time to validate shots from client's perspective:

```typescript
// Server
function processShot(clientId, shotData) {
  const client = clients[clientId];
  const rewindTime = currentTime - client.ping;
  
  // Rewind all entities to that time
  const pastStates = rewindEntities(rewindTime);
  
  // Check if shot would have hit
  const hit = checkHit(shotData, pastStates);
  
  // Restore current state
  restoreEntities();
  
  if (hit) {
    applyDamage(hit.target, shotData.damage);
  }
  
  sendToClient(clientId, { type: 'shot_result', hit: hit });
}
```

### 4. State Buffering

Maintain history of states for reconciliation:

```typescript
class StateBuffer {
  constructor(maxSize = 100) {
    this.buffer = [];
    this.maxSize = maxSize;
  }
  
  add(state) {
    this.buffer.push(state);
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }
  
  getStateAt(time) {
    return this.buffer.find(s => s.time === time);
  }
  
  getStateBefore(time) {
    return this.buffer.filter(s => s.time <= time).pop();
  }
  
  getStateAfter(time) {
    return this.buffer.find(s => s.time > time);
  }
}
```

### 5. Smooth Corrections

Avoid snapping when correcting prediction errors:

```typescript
function smoothCorrection(targetPosition) {
  const correctionSpeed = 0.2; // 20% per frame
  localState.position = lerp(
    localState.position,
    targetPosition,
    correctionSpeed
  );
}
```

## Network Protocol

### Message Types

```typescript
// Client → Server
interface InputMessage {
  type: 'input';
  sequence: number;
  input: {
    movement: Vector3;
    rotation: Quaternion;
    actions: Action[];
  };
}

interface ShotMessage {
  type: 'shot';
  sequence: number;
  position: Vector3;
  direction: Vector3;
  timestamp: number;
}

// Server → Client
interface StateMessage {
  type: 'state';
  sequence: number;
  players: PlayerState[];
  timestamp: number;
}

interface ShotResultMessage {
  type: 'shot_result';
  sequence: number;
  hit: boolean;
  target?: string;
  damage?: number;
}
```

### Binary Protocol Optimization

Use binary encoding for efficiency:

```typescript
// Binary protocol example
function encodeInput(input: InputMessage): ArrayBuffer {
  const buffer = new ArrayBuffer(32);
  const view = new DataView(buffer);
  
  view.setUint8(0, MessageType.INPUT);
  view.setUint32(1, input.sequence);
  view.setFloat32(5, input.input.movement.x);
  view.setFloat32(9, input.input.movement.y);
  view.setFloat32(13, input.input.movement.z);
  // ... etc
  
  return buffer;
}
```

## Implementation Priorities

### Phase 1: Foundation
1. Basic WebSocket connection
2. Input message sending
3. Server state broadcasting
4. Basic interpolation

### Phase 2: Prediction
1. Client-side movement prediction
2. Input sequence tracking
3. Server reconciliation
4. Smooth corrections

### Phase 3: Combat
1. Client-side hit detection
2. Server validation
3. Lag compensation
4. Shot confirmation/rejection

### Phase 4: Polish
1. Adaptive interpolation
2. Rubber banding prevention
3. Visual feedback priority
4. Performance optimization

## Critical Requirements

### Input Handling
- **NO mouse smoothing** - raw input only
- **NO input acceleration** - 1:1 mapping
- **High polling rate** - if possible
- **Immediate processing** - zero delay

### Performance
- **60+ FPS client** - independent of server tick rate
- **Fixed timestep physics** - consistency
- **Binary protocols** - reduce bandwidth
- **Delta compression** - only send changes

### Security
- **Validate everything** - server never trusts blindly
- **Rate limiting** - prevent spam
- **Sanity checks** - impossible movement detection
- **Checksums** - detect tampering

## Best Practices & Secrets from Industry

### Interpolation Buffer Sizing (Gaffer On Games)

**Rule of thumb**: Buffer delay = 3X packet send rate

- At 10 packets/second: 300ms buffer
- At 30 packets/second: 100ms buffer
- At 60 packets/second: 50ms buffer

**Why**: Buffer should survive losing 2 packets in a row without hitching. Add extra delay for jitter (typically 1-2 frames @ 60fps).

**Secret**: The interpolation videos were recorded at 5% packet loss with +/- 2 frames jitter at 60fps. Proper buffer sizing makes this invisible.

### Server-Side History Limits

**Source Engine**: 1 second of position history
**Unity Netcode**: 250-500ms recommended

**Why**: Too much history causes players to be shot "behind walls" from their perspective due to large timeline discrepancies between low and high latency clients.

### Sequence Number Reconciliation (Gabriel Gambetta)

**Pattern**:
1. Client adds sequence number to each input
2. Server includes last processed sequence in responses
3. Client discards acknowledged inputs
4. Client replays unacknowledged inputs on top of server state

**Secret**: This eliminates the "jump back and forth" problem when server state arrives late.

### Don't Use Extrapolation for Rigid Bodies

**Problem**: Extrapolation doesn't know about physics, collisions, or forces.

**Examples of failure**:
- Objects extrapolate through floors then snap back
- Spring forces not accounted for
- Collision response mispredicted
- Rotational motion wrong (attached cubes continue on tangent)

**Solution**: Use higher send rates instead of extrapolation. 60 packets/second needs only 50ms delay.

### Always Use UDP for Snapshots

**Why**: Snapshots are time-critical but not reliable. If lost, skip to next snapshot. Never wait for retransmission.

**TCP problem**: Head-of-line blocking causes hitches when any packet is lost.

### Input Sequence Tracking

**Pattern**:
```typescript
// Circular buffer of pending inputs
class PendingInputBuffer {
  private buffer: InputEntry[] = new Array(1024);
  private head = 0;
  private tail = 0;

  add(input: Input, sequence: number) {
    this.buffer[this.head] = { input, sequence };
    this.head = (this.head + 1) % this.buffer.length;
  }

  getUnacknowledged(lastProcessedSeq: number): Input[] {
    const result = [];
    let i = this.tail;
    while (i !== this.head) {
      if (this.buffer[i].sequence > lastProcessedSeq) {
        result.push(this.buffer[i].input);
      }
      i = (i + 1) % this.buffer.length;
    }
    return result;
  }
}
```

### Prediction Error Handling

**Two types of corrections**:
1. **Small errors** (< threshold): Smoothly lerp to authoritative position
2. **Large errors** (> threshold): Snap immediately (prevents clipping through walls)

**Threshold**: Typically 0.1-0.5 units depending on game scale

### Deterministic Cooldowns

**Problem**: Client and server can desync on timers (fire rate, reload).

**Solution**: Use deterministic timer system based on ticks, not wall time.

```typescript
class DeterministicTimer {
  private tick: number;
  private interval: number;

  canFire(currentTick: number): boolean {
    return currentTick - this.tick >= this.interval;
  }

  fire(currentTick: number) {
    this.tick = currentTick;
  }
}
```

### Testing with Artificial Latency

**Test at**: 50ms, 150ms, 500ms latency

**Why**: Covers most common network conditions. Unity Netcode PlayMode Tool can emulate this.

### Favor the Attacker (Unity Documentation)

**Psychology 101**: More frustrating for attacker to always miss than for target to get shot behind wall occasionally.

**Implementation**: Server rewinds to shooter's perspective when validating hits.

### Controlled Desync for Corrections

**Technique**: Allow clients to desync for a few seconds if they reach common state independently.

**Use non-gameplay animations** to hide discrepancies (e.g., "smart context-aware interpolation").

**Example**: If prediction wrong, play a quick adjustment animation instead of snapping position.

### Rate Limiting Validation

**Prevent**:
- Spam attacks
- Impossible movement
- Duplicate hits in short window

**Example**:
```typescript
validation: {
  maxLatencySeconds: 0.5,  // Reject if too old
  maxDistance: 100,        // Cap target distance
  duplicateWindowSeconds: 0.1,  // Reject same attack ID
  targetCooldownSeconds: 0.5,  // Prevent rapid repeat hits
  lineOfSight: true  // Check occlusion
}
```

## Common Pitfalls

### Don't Do
- Smooth mouse input
- Send positions instead of inputs
- Wait for server confirmation
- Snap to server positions for small errors
- Trust client blindly
- Use extrapolation for rigid bodies
- Use TCP for snapshots
- Turn off lag compensation (Source Engine warning)

### Do Do
- Process input immediately
- Send input sequences
- Show instant feedback
- Smooth corrections for small errors
- Snap for large errors
- Validate everything server-side
- Use UDP for snapshots
- Buffer 3X packet send rate for interpolation
- Keep 250-500ms server history
- Test with artificial latency

## References

- **Krunker.io** - Browser FPS with excellent netcode
- **Source Engine** - CS:GO lag compensation
- **geckos.io** - WebRTC UDP-like networking
- **Rhubarb** - Optimized WebSocket for games

## Conclusion

The client-authoritative approach with server validation provides the best balance of responsiveness and security for browser-based FPS games. By processing input immediately and validating server-side, games can achieve "LAN-like" feel regardless of network conditions.
