---
title: "Demo System End-to-End Review"
category: "review"
status: "current"
date: "2026-07-09"
version: "1.0"
tags: ["demo", "recording", "replay", "missing-balls", "desync", "projectiles", "targets"]
---

# Demo System End-to-End Review

## Scope

Review of the client-side demo recording and playback pipeline, focused on ensuring that demo playback accurately reconstructs all balls and projectiles and prevents `ball X not found` errors and visual desync.

Files reviewed:
- `client/src/demo/DemoRecorder.ts`
- `client/src/demo/DemoPlayer.ts`
- `client/src/demo/DemoSerializer.ts`
- `client/src/demo/DemoManager.ts`
- `client/src/demo/DemoUI.ts`
- `client/src/demo/types.ts`
- `client/src/main.ts`
- `client/src/projectiles/Projectile.ts`
- `client/src/projectiles/index.ts`
- `client/src/balls.ts`

## What's working

### Recording pipeline
- `DemoRecorder` records `targetType` and `health` in every target event (`Spawned`, `Bounce`, `StateChanged`, `Hit`, `Destroyed`).
- `DemoRecorder.extractClip` builds a snapshot of balls and projectiles alive at `clipStart` and injects synthetic `Spawned`/`Fired` events at `clipStart`.
- `DemoRecorder.extractClip` also creates `additionalSpawned` events for target IDs that appear mid-clip without a spawn event, using the first in-clip event's `targetType` and `health`.
- `DemoSerializer` reads/writes `targetType` and `health` correctly and supports format v2 `projectileLifetime`.
- `DemoManager` forwards all recording calls and sets up red (hit) and blue (fired) seekbar markers using the longest-airtime hit.
- `DemoPlayer` emits `projectiles` and `targets` arrays and resets event indices on seek/loop.
- `Projectile.explode()` sets `exploded = true` and removes the mesh exactly once via `projectileRemoved`. `dead` is set only after trail particles have faded.
- `main.ts` `spawnBall` and `snapshotExistingBallsForRecording` record `Spawned` events with `targetType` and set `onBounce`/`onPeak` callbacks for keyframes.
- `main.ts` `updateProjectiles` records `ProjectileHit`/`ProjectileDestroyed` with the correct `targetId` and `demoProjectileId`.
- `main.ts` `onPlaybackEvent` uses `getProjectileConfig(ev.weaponType)` to reconstruct the correct weapon type (rocket/disc/grenade) during playback.

## Issues found

### 1. `main.ts` playback processes projectile events before target events
**Location**: `client/src/main.ts`, `demoManager.onPlaybackEvent` callback.

`DemoPlayer` passes `projectiles` and `targets` as two separate arrays. The `onPlaybackEvent` callback processes the `projectiles` loop first and the `targets` loop second in both the seek-reconstruction branch and the normal forward-playback branch.

Because `Projectile Hit` events are processed before `Target Spawned`/`Hit`/`Destroyed` events that may share the same timestamp, the referenced `ball` does not exist in `playbackBallById` yet when the hit is applied. This is the remaining cause of `ball X not found` console logs and can cause:
- Missing debug comparison output for projectile hit vs. ball position.
- Incorrect frag-message accuracy because the ball has not been snapped to its recorded keyframe.

**Fix**: process `events.targets` before `events.projectiles` in both branches, or merge the two arrays and iterate by `timestamp`.

### 2. `computeAccuracy(r.hitRadius, false)` is semantically wrong
**Location**: `client/src/main.ts` line 1164.

`computeAccuracy` expects a raw center-to-center distance value (or `minHitDist - targetRadius`). `r.hitRadius` is the expanding wake hitbox radius, not a distance, so the computed accuracy is meaningless.

During playback, `r.isRemote = true` and `Projectile.update` is called without the `balls` array, so `sweepBall` never runs and `r.minHitDist`/`r.directHit` remain at their default `0`/`false`.

**Fix options**:
- Short-term: use `computeAccuracy(r.minHitDist, r.directHit)` as a fallback (will always return max accuracy for playback hits).
- Correct: extend `ProjectileEvent` to record `directHit` and `hitAccuracy` (or `minHitDist`) and bump the demo format version.

### 3. `DemoRecorder.extractClip` synthetic `Spawned` health edge case
**Location**: `client/src/demo/DemoRecorder.ts` lines 359–428.

`additionalSpawned` uses the first in-clip event's `targetType` and `health`. If the first in-clip event is a `Hit` (recorded after `takeDamage`), the synthetic `Spawned` will carry post-damage `health`. `onPlaybackEvent` currently ignores `ev.health` for `Spawned` events, so this does not affect playback, but it is inconsistent.

### 4. `Projectile.ts` wake-hit issues
**Location**: `client/src/projectiles/Projectile.ts`.

- `sweepBall` computes `passedCenter` **after** the wake-hit check. A wake hit can therefore be delayed by one step.
- `sweepPlayer` does not have a `passedCenter` guard at all, so wake hits against players can fire prematurely.
- `hitDistance` and `hitAge` are computed from the end-of-frame position, not the actual impact point. This is already documented in the TODO block.

These are not the cause of missing balls in playback, but they affect the accuracy of recorded data and the consistency of direct/wake hit classification.

### 5. `main.ts` playback does not re-apply explosion forces
**Location**: `client/src/main.ts` `onPlaybackEvent` `Hit` branch.

The playback code spawns `Explosion`/`Implosion` visuals but does not call `processProjectileExplosion`. This is mostly mitigated because:
- `Target Hit` events carry the post-knockback `pos` and `vel` for balls.
- The player is driven by interpolated demo frames.

However, if `Implosion` ever has side effects beyond visuals, those will not run during playback. A more robust approach would be to call `processProjectileExplosion` with a flag to suppress damage numbers/frag messages, or to rely entirely on the target events for ball state.

### 6. `Target Hit` playback ignores `ev.health`
**Location**: `client/src/main.ts` `onPlaybackEvent` `TargetEventType.Hit` branch.

The playback code calls `ball.takeDamage()` and ignores the recorded `health` value. As long as the number of `Hit`/`Destroyed` events matches the ball's max health, this is correct. If events are pruned or if a ball is restored by seeking, the health could drift.

## Suggested fixes

1. **Reorder `onPlaybackEvent` loops** so `targets` are processed before `projectiles` in both the seek and normal playback branches. This is the single most important fix for missing-ball logs.
2. **Fix playback frag-message accuracy** by using `r.minHitDist` and `r.directHit` as a fallback, and consider adding `directHit`/`hitAccuracy` to `ProjectileEvent` for accurate replay.
3. **Sync `ball.health` from `Target Hit` events** in `onPlaybackEvent` instead of relying only on `takeDamage()`.
4. **Clean up `Projectile` wake-hit logic** by moving `passedCenter` before the wake check in `sweepBall` and adding the same guard to `sweepPlayer`.
5. **Document `health` semantics** in `additionalSpawned` or explicitly set `health` to a default value when synthesizing `Spawned` events.

## Next steps

- Apply the fixes above.
- Test with both rocket and disc weapons, recording and playing back clips.
- Verify that no `ball X not found` messages appear during playback.
- Verify that red (hit) and blue (fired) markers appear on the demo seekbar.
- Verify that projectile trails, explosion/implosion visuals, and ball knockback/pull look correct during playback.
