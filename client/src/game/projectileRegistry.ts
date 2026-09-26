import type { Projectile } from '../projectiles/Projectile.js';

// Local-projectile → server-id bookkeeping. The client fires and simulates
// immediately; the server assigns ids asynchronously via projectileCreated,
// so we queue locally-spawned projectiles until their server id arrives.
// Shared between combat.ts (spawns) and netHandlers.ts (id assignment /
// destroys) as an injected object — previously three module-level globals
// that made the two files secretly one object.
export interface ProjectileRegistry {
  /** FIFO: local projectiles awaiting their server-assigned projectileId */
  pending: Projectile[];
  /** server projectileId -> local Projectile (for server-ordered destroys) */
  byId: Map<string, Projectile>;
  /** spawn timestamp per pending projectile — stale-timeout bookkeeping */
  pendingSince: Map<Projectile, number>;
}

export function createProjectileRegistry(): ProjectileRegistry {
  return { pending: [], byId: new Map(), pendingSince: new Map() };
}
