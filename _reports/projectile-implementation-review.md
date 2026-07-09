# Projectile Class Implementation Review

**Scope:** `client/src/projectiles/Projectile.ts` and related configuration (`projectiles/types.ts`, `rocketConfig.ts`, `discConfig.ts`, `grenadeConfig.ts`, `config.ts`, `balls.ts`).

**Date:** 2026-07-09

**Summary:**
`Projectile.ts` introduces a self-contained, client-authoritative projectile class with swept collision against terrain, balls, and remote players, plus visual effects (mesh, glow shell, particle trail). It aligns with the project priority of client-driven feel and low server cost by doing hit detection on the client. The design is generally sound, but there are several correctness and performance issues that should be addressed before the code is considered production-ready.

---

## What is done well

- **Client-authoritative design.** The `Projectile` class performs its own movement, swept collision, and hit detection. The server validation path is left to `main.ts` via `sendShot`, which matches the stated architecture of low-cost server validation.
- **Continuous swept collision.** `sweepBall`, `sweepTerrain`, and `sweepPlayer` use line-segment sampling or analytic closest-point tests rather than single-point checks, reducing tunneling for fast-moving projectiles.
- **Separation of remote vs. local projectiles.** `isRemote` cleanly disables collision for server-authoritative and demo playback projectiles while still rendering them and emitting trails.
- **Config-driven behavior.** `ProjectileConfig` centralizes all per-weapon constants (speed, gravity, trail, mesh, hitbox growth, etc.). Adding new weapons is mostly a matter of creating a new config object.
- **Visual polish.** Mesh ramp-in, glow shells, and additive trail particles with color gradients and per-particle orientation (`ring`/`disc` options) give the projectiles a nice look.

---

## Correctness and Design Issues

### 1. `sweepPlayer` missing `passedCenter` guard
**File:** `Projectile.ts:223-288`

`sweepBall` tracks a `passedCenter` flag and only triggers a wake hit when `d > prevMin` **and** the projectile has passed the closest point of the current sweep. This prevents stale per-frame minima from firing premature wake hits when a target re-approaches.

`sweepPlayer` does not implement this guard. It only checks `totalDist > prevMin`:

```ts
if (totalDist < prevMin) {
  this.wakePlayerDistances.set(playerId, totalDist);
  return false;
} else if (totalDist > prevMin) {
  this.directHit = false;
  return true;
}
```

Because remote players can move, `prevMin` from a previous frame can become stale. A moving player can cause `totalDist > prevMin` to fire even though the projectile is still approaching the player or has not passed the closest point.

**Recommendation:** Add `passedCenter` logic to `sweepPlayer` consistent with `sweepBall`, e.g. by comparing the current `totalDist` to the previous frame's value or by computing the projection parameter `t` and only allowing wake hits once the projectile has moved past the closest point.

---

### 2. `sweepBall` `passedCenter` is computed *after* the wake check
**File:** `Projectile.ts:158-219`

Inside the `sweepBall` loop, the `passedCenter` flag is set at the end of each iteration:

```ts
if (d2 > prevD2) {
  passedCenter = true;
}
```

But the wake-hit check at the top of the loop uses the *previous* value of `passedCenter`. For `steps === 1` (a common case for fast motion), the wake check at the final step is evaluated with `passedCenter === false`, meaning a wake hit that should be detected at the end of the segment is deferred to the next frame. This can miss wake hits entirely for projectiles that pass a ball within a single frame.

**Recommendation:** Move the `passedCenter` update to the top of the loop (or otherwise ensure it is set before the wake check) when `i > 0`.

---

### 3. `hitDistance` and `hitAge` are inaccurate for fast projectiles
**File:** `Projectile.ts:322-339`

When a hit is detected, `hitDistance` is computed from `this.pos`, which is the **end-of-frame** projectile position, not the impact point:

```ts
this.hitDistance = this.pos.distanceTo(this.shotOrigin);
```

Similarly, `hitAge` is `this.age` at the end of the frame. For a rocket moving at 120 units/s with a 60 FPS step, `this.pos` can be 2 units past the impact. Since `hitDistance` and `hitAge` are used for the score calculation and the cool-shot log, this introduces a noticeable error.

**Recommendation:** Return the impact t-value from `sweepBall` and `sweepPlayer` (or the interpolated impact point), and use that to compute `hitDistance` and `hitAge`. A simple approach is to track the hit point in the `Projectile` instance during the sweep.

---

### 4. Terrain collision is too coarse and uses the wrong point for rockets/grenades
**File:** `Projectile.ts:139-155`

`sweepTerrain` samples the **center** of the projectile (`this.pos`) along the movement path, and uses a fixed `STEP = 0.5`:

```ts
if (sy <= terrain.getHeight(sx, sz) + this.config.terrainOffset) return true;
```

For rocket/grenade configs, `terrainOffset` is `HIT_MIN` (0.0). The rocket mesh is a 0.7-unit cylinder, so the front tip is ~0.35 units ahead of the center. With `terrainOffset: 0.0`, the tip can be 0.35 units underground before the center collides. Combined with `STEP = 0.5` (which is larger than the `terrainOffset` for rocket and grenade), the projectile can also tunnel through small terrain spikes.

**Recommendation:**
- Move the `terrainOffset` for rocket/grenade to a non-zero value that matches the mesh geometry (e.g., half the mesh length, or at least `bodyRadius`).
- Make `STEP` depend on `terrainOffset` (or `bodyRadius`) to guarantee no tunneling: `STEP = Math.min(0.5, terrainOffset / 2)` or similar.
- Alternatively, sample the front tip of the projectile instead of the center.

---

### 5. Trail particles are expensive and allocation-heavy
**File:** `Projectile.ts:380-447`

Each trail particle is a full `THREE.Mesh` with its own `THREE.MeshBasicMaterial`. `emitTrail` also allocates several `THREE.Vector3` objects per particle:

```ts
const dir = this.vel.lengthSq() > 0.0001
  ? this.vel.clone().normalize()
  : new THREE.Vector3(0, 1, 0);
const arbitrary = Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
const right = new THREE.Vector3().crossVectors(dir, arbitrary).normalize();
const up = new THREE.Vector3().crossVectors(right, dir).normalize();
// ...
const offset = new THREE.Vector3()...;
const pos = spawnPos.clone().add(offset);
const drift = new THREE.Vector3(...);
```

For a rocket at 120 units/s with `trailParticlesPerUnit: 2`, this produces ~240 particles per second. With 2-3 active rockets plus grenades/discs, each with many particles, the scene can quickly accumulate thousands of individual meshes and draw calls. This is the biggest performance risk in the class.

**Recommendation:**
- Use `THREE.InstancedMesh` for trail particles with per-instance color and scale. Update the instance matrices and colors in `updateTrail` rather than moving individual meshes.
- Reuse temporary `THREE.Vector3` objects in `emitTrail` (or compute them locally) to reduce GC pressure.
- Consider `THREE.Sprite` or `THREE.Points` for spherical trail particles; they are far cheaper than `Mesh` with geometry.

---

### 6. `hitMin` can be smaller than `bodyRadius`, disabling wake at spawn
**File:** `config.ts` and `projectiles/*.ts` (config values)

The wake-hit threshold is `target.radius + this.hitRadius` for balls and `PLAYER_RADIUS + this.hitRadius` for players. `hitRadius` starts at `ProjectileConfig.hitMin` and grows to `hitMax`.

For the rocket:
- `bodyRadius = 0.18`
- `hitMin = 0.0`

For the disc:
- `bodyRadius = 0.5`
- `hitMin = 0.3`

If `hitMin < bodyRadius`, the wake threshold is smaller than the core threshold, so the wake `else if` branch is unreachable until `hitRadius` grows past `bodyRadius`. This effectively removes the wake hitbox for the first few frames of the projectile's life.

**Recommendation:** Either clamp `hitRadius` to `bodyRadius` in the `hitRadius` getter, or ensure `hitMin >= bodyRadius` in the configs. If intentional, document it explicitly.

---

### 7. `dispose()` does not stop the projectile from updating
**File:** `Projectile.ts:501-510`

`dispose()` removes the mesh and particles, but it does not set `this.dead = true` or `this.exploded = true`:

```ts
dispose(): void {
  if (this.disposed) return;
  this.removeProjectileMesh();
  for (const p of this.particles) { ... }
  this.particles.length = 0;
  this.disposed = true;
}
```

If `update()` is called after `dispose()`, it will continue to move the projectile and emit new trail particles, even though the mesh is gone. The `this.disposed` flag is private and not checked in `update()`.

**Recommendation:** Add `this.dead = true` at the end of `dispose()` to prevent further updates.

---

### 8. `explosionProcessed` is declared but never used
**File:** `Projectile.ts:73`

`explosionProcessed` is initialized to `false` and is never read or written again. It appears to be dead code or a placeholder for an unimplemented effect stage.

**Recommendation:** Either use it for an external explosion effect (e.g., `if (!this.explosionProcessed) { spawnExplosion(); this.explosionProcessed = true; }`) or remove it.

---

## Minor Observations

- **Geometry reuse.** `TRAIL_GEO`, `TRAIL_RING_GEO`, and `TRAIL_DISC_GEO` are shared, which is good. However, `SphereGeometry(1, 8, 6)` still has 48 vertices per particle. If `InstancedMesh` or `Points` is adopted later, the geometry can be made cheaper or replaced with billboards.
- **Mesh orientation.** Rocket geometry is rotated with `geo.rotateX(Math.PI / 2)` and then aligned with `setFromUnitVectors(new THREE.Vector3(0, 0, 1), velDir)`. This works, but it creates a new `THREE.Vector3(0, 0, 1)` every frame. A small allocation, but trivial to avoid.
- **Velocity inheritance.** `this.vel = dir.normalize().multiplyScalar(config.speed).addScaledVector(playerVel, 0.5)` adds half the player velocity. This is described as Tribes-style and is a reasonable gameplay choice.
- **Remote projectiles.** `isRemote` skips collision and still emits trails. This is correct for visualizing server-authoritative or demo projectiles, but trail emission for many remote projectiles could compound the performance issue in point 5.
- **Capsule distance calculation.** `sweepPlayer` correctly computes the closest point to a vertical capsule (cylinder + spherical caps). The `hitAccuracy = this.minHitDist - PLAYER_RADIUS` correctly converts the center-to-center distance to a surface-to-surface distance.

---

## Recommendations (Priority Order)

1. **Fix `sweepPlayer` wake-hit logic** by adding a `passedCenter` guard.
2. **Fix `sweepBall` `passedCenter` ordering** so the wake check at the final step has the correct flag.
3. **Fix `dispose()`** to set `this.dead = true`.
4. **Improve terrain collision** for rocket/grenade by adjusting `terrainOffset` and/or `sweepTerrain` step size.
5. **Compute `hitDistance` and `hitAge` from the actual impact point**, not the end-of-frame position.
6. **Address trail performance** by using `InstancedMesh` or `Points` and reusing temporary vectors.
7. **Resolve the `hitMin` vs `bodyRadius` mismatch** so the wake hitbox is active from launch.
8. **Remove or use `explosionProcessed`.**

---

## Conclusion

`Projectile.ts` is a solid foundation for the weapon system. The swept collision and config-driven design are appropriate for a client-authoritative browser FPS. However, the wake-hit logic has real correctness bugs (missing guard in `sweepPlayer`, ordering bug in `sweepBall`), the terrain collision is too lenient for rockets, and the trail rendering is a likely performance bottleneck. Fixing these issues before scaling up to multiple players and projectiles will significantly improve both gameplay feel and frame rate.
