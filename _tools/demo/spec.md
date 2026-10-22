# Demo System Specification

## Overview

The demo system records and replays gameplay using a hybrid keyframe + simulation model. Player camera state is fully keyframed (every tick). Projectiles and targets (balls) use sparse keyframe events with physics simulation between them, accepting small drift because visual precision is unimportant for background objects.

## Binary Format

All values are little-endian.

### Header

| Field | Type | Bytes | Description |
|-------|------|-------|-------------|
| magic | uint8 | 1 | Must be `0x44` ('D') |
| formatVersion | int32 | 4 | Currently `1` |
| gameVersion | string | 2 + N | uint16 length + UTF-8 bytes |
| timestamp | int64 | 8 | Epoch milliseconds |
| duration | float32 | 4 | Total recording time in seconds |
| totalFrames | uint32 | 4 | Number of frames |
| projectileEventCount | uint32 | 4 | Number of projectile events |
| targetEventCount | uint32 | 4 | Number of target events |
| checksum | uint32 | 4 | CRC32 (currently 0) |
| description | string | 2 + N | uint16 length + UTF-8 bytes |
| startPosX/Y/Z | 3 × float32 | 12 | Player start position |
| startYaw | float32 | 4 | Player start yaw |
| startPitch | float32 | 4 | Player start pitch |
| startVelX/Y/Z | 3 × float32 | 12 | Player start velocity |

### Frames (48 bytes each)

Recorded at a fixed tick rate (default 60 Hz). Each frame fully describes the player's camera state.

| Field | Type | Bytes | Description |
|-------|------|-------|-------------|
| frameNumber | uint16 | 2 | Sequential frame index (wraps at 65536) |
| timestamp | float32 | 4 | Time in seconds from recording start |
| posX, posY, posZ | 3 × float32 | 12 | Player position |
| velX, velY, velZ | 3 × float32 | 12 | Player velocity |
| yaw | float32 | 4 | Camera yaw (radians) |
| pitch | float32 | 4 | Camera pitch (radians) |
| inputFlags | uint8 | 1 | Bitmask: Forward, Backward, Left, Right, Jump, Ski, Fire, Disc |
| mouseDeltaX | int16 | 2 | Mouse X delta since last frame |
| mouseDeltaY | int16 | 2 | Mouse Y delta since last frame |
| jetpackFlags | uint8 | 1 | Bitmask: Active |
| jetpackFuel | float32 | 4 | Remaining jetpack energy |

### Projectile Events (59 bytes each)

Sparse events marking projectile lifecycle milestones.

| Field | Type | Bytes | Description |
|-------|------|-------|-------------|
| eventType | uint8 | 1 | `ProjectileEventType` enum |
| timestamp | float32 | 4 | Time in seconds |
| posX, posY, posZ | 3 × float32 | 12 | Position at event |
| velX, velY, velZ | 3 × float32 | 12 | Velocity at event |
| projectileId | uint16 | 2 | Unique projectile ID |
| weaponType | uint8 | 1 | 0 = rocket, 1 = disc |
| surfaceNormalX/Y/Z | 3 × float32 | 12 | Surface normal (bounce events only) |
| targetId | uint16 | 2 | Target hit (Hit events only), `0xFFFF` = player, `0` = terrain |
| hasPeakPosition | uint8 | 1 | Boolean: peak position follows |
| peakPosX, peakPosY, peakPosZ | 3 × float32 | 12 | Peak (apex) position |

#### Projectile Event Types

| Value | Name | When | Keyframed | Simulated between |
|-------|------|------|-----------|-------------------|
| 0 | **Fired** | Projectile created | Position, velocity, weaponType | Full trajectory (gravity + bounce) |
| 1 | **Bounce** | Projectile hits terrain | Position, post-bounce velocity, surface normal | Arc between bounces |
| 2 | **Hit** | Projectile hits a target (ball or player) | Position, targetId | N/A (terminal event) |
| 3 | **Destroyed** | Projectile removed | Position | N/A (terminal event) |

### Target Events (49 bytes each)

Sparse events marking target (ball) lifecycle and keyframe corrections.

| Field | Type | Bytes | Description |
|-------|------|-------|-------------|
| eventType | uint8 | 1 | `TargetEventType` enum |
| timestamp | float32 | 4 | Time in seconds |
| posX, posY, posZ | 3 × float32 | 12 | Position at event |
| velX, velY, velZ | 3 × float32 | 12 | Velocity at event |
| targetId | uint16 | 2 | Stable ball ID |
| targetType | uint8 | 1 | Ball variant: 0 = normal, 1 = medium, 2 = large |
| health | float32 | 4 | Remaining health (Hit events only) |
| hasPeakPosition | uint8 | 1 | Boolean: peak position follows |
| peakPosX, peakPosY, peakPosZ | 3 × float32 | 12 | Peak (apex) position |

#### Target Event Types

| Value | Name | When | Keyframed | Simulated between |
|-------|------|------|-----------|-------------------|
| 0 | **Spawned** | Ball created | Position, velocity, variant | Full physics (gravity + terrain bounce) |
| 1 | **Bounce** | Ball hits terrain | Position, post-bounce velocity | Arc between bounces |
| 2 | **Hit** | Ball takes damage | Position, remaining health | N/A (instantaneous) |
| 3 | **Destroyed** | Ball killed | Position | N/A (terminal event) |
| 4 | **StateChanged (Peak)** | Ball reaches apex (vel.y crosses positive → negative) | Position, velocity at peak | Gravity arc between peak and next bounce/peak |

## Keyframe vs Simulation Strategy

### Player — Fully Keyframed

The player's camera state (position, velocity, yaw, pitch, inputs) is recorded every tick. Playback sets these directly from frame data. No simulation is needed — the player camera is bit-exact on replay.

### Projectiles — Keyframed at Lifecycle Events

Projectiles are simulated from `Fired` velocity using the same physics (gravity, terrain bounce). Keyframes at `Fired` and `Bounce` correct position and velocity, preventing drift from accumulating across bounces. `Hit` and `Destroyed` are terminal events that need no simulation after.

**What we accept drift on:** Nothing significant — projectile bounces are exact keyframes, and between bounces the parabolic arc is deterministic (gravity is constant).

### Targets (Balls) — Keyframed at Bounce + Peak

Balls are the most numerous and least important visually. We use the sparsest keyframe strategy:

- **Spawned**: Initial position + velocity. Playback creates the ball and simulates from here.
- **Bounce**: Position + post-bounce velocity. Snaps the ball back to the recorded trajectory on every terrain hit. Also fires on teleport (when ball is too far from player and gets repositioned).
- **Peak (StateChanged)**: Position + velocity at the apex of each arc. Corrects drift from the simulated parabola between bounces.
- **Hit**: Position + health. Triggers damage flash.
- **Destroyed**: Position. Marks ball as dead, spawns debris.

**What we accept drift on:** Between keyframes, balls simulate with the same gravity and terrain bounce physics. Small position errors accumulate from float precision differences and terrain normal sampling, but each bounce/peak keyframe snaps back to the correct trajectory. Since balls are background objects that the viewer isn't tracking precisely, sub-meter drift between keyframes is visually irrelevant.

**Why not keyframe every frame:** Balls bounce every 1-3 seconds and peak once per arc. For a 12-second clip with 8 balls, this produces roughly 50-80 keyframe events (~2.5-4 KB). Per-frame recording would produce 8 × 720 = 5,760 events (~280 KB) — 70× larger for no visible benefit.

## Clip Extraction

Cool shots are auto-detected when a projectile hits a target (ball or player) with airtime > 2.0 seconds. The clip is extracted from the circular frame buffer with configurable buffer time (default: 5s before hit, 5s after hit).

- **Clip trigger**: `r.hitAge > 2.0` (rocket) or `d.hitAge > 2.0` (disc), where `hitAge` is the projectile's age at the moment of target impact (not terrain hit).
- **Extraction timing**: Deferred by `bufferAfter` seconds after the hit to capture post-hit footage.
- **Clip window**: `[hitTime - projectileLifetime - bufferBefore, hitTime + bufferAfter]`
- **Description format**: `Cool shot (X.XXs air, Y.Ys clip)`

## Server Storage

Demos are uploaded to the server as binary blobs. The server maintains a `index.json` file with metadata (filename, projectileLifetime, timestamp, description, fileSize) sorted by lifetime descending. On startup, the server reconciles the index against the `demos/` directory — orphaned `.demo` files are parsed and added, stale index entries pointing to missing files are pruned. The server serves the top 10 demos by lifetime.
