import type { Projectile } from '../projectiles/Projectile.js';

// Local-projectile → server-id bookkeeping. The client fires and simulates
// immediately; the server assigns ids asynchronously via projectileCreated,
// so each tracked shell carries a client-minted shotId nonce that echoes
// back in that broadcast — binding is explicit, never order inference.
// (Replaces the old FIFO pending queue: one dropped/rejected spawn claim
// used to shift every later link one slot.)
// Shared between combat.ts (spawns) and netHandlers.ts (id assignment /
// destroys) as an injected object — previously three module-level globals
// that made the two files secretly one object.
export interface ProjectileRegistry {
  /** shotId nonce → local projectile — set at spawn, echoed by the server */
  byShotId: Map<string, Projectile>;
  /** server projectileId → local Projectile (server-ordered destroys) */
  byId: Map<string, Projectile>;
  /** Monotonic counter minting shotId nonces for this session. */
  seq: number;
}

export function createProjectileRegistry(): ProjectileRegistry {
  return { byShotId: new Map(), byId: new Map(), seq: 0 };
}
