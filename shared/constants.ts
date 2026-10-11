/**
 * Shared player capsule geometry — the server needs these to validate hit
 * claims against networked positions (which are EYE positions, not feet).
 * Client config.ts re-exports them; do not duplicate values there.
 */
export const PLAYER_RADIUS = 0.8;
export const PLAYER_HEIGHT = 2;
export const CAPSULE_CYLINDER_HEIGHT = PLAYER_HEIGHT - 2 * PLAYER_RADIUS;
export const CAPSULE_HALF_HEIGHT = CAPSULE_CYLINDER_HEIGHT / 2;
export const CAPSULE_CENTER_Y = PLAYER_HEIGHT / 2;
export const EYE_OFFSET = 1.8;
// Spawn shield — damage + enemy-blast shove both blocked for this long
// after join/respawn. Shared because the client suppresses the same
// predicted effects the server refuses to apply (silent-window rubber-band).
export const SPAWN_PROTECT_MS = 2000;
