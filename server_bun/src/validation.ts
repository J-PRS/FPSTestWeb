import { CONFIG } from './config.ts';
import type { Vec3, Rotation } from './types.ts';

export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

export function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

// Room/map/mode name grammar — shared by the join handshake and switchRoom.
export const word = (v: unknown): string | undefined =>
  typeof v === 'string' && /^[\w-]{1,32}$/.test(v) ? v : undefined;

export function validateVec3(value: unknown): ValidationResult<Vec3> {
  if (typeof value !== 'object' || value === null) {
    return { success: false, error: 'Expected object' };
  }
  const obj = value as Record<string, unknown>;
  if (!isFiniteNumber(obj.x) || !isFiniteNumber(obj.y) || !isFiniteNumber(obj.z)) {
    return { success: false, error: 'Expected { x, y, z } as finite numbers' };
  }
  return { success: true, data: { x: obj.x, y: obj.y, z: obj.z } };
}

export function validateRotation(value: unknown): ValidationResult<Rotation> {
  if (typeof value !== 'object' || value === null) {
    return { success: false, error: 'Expected object' };
  }
  const obj = value as Record<string, unknown>;
  if (!isFiniteNumber(obj.yaw) || !isFiniteNumber(obj.pitch)) {
    return { success: false, error: 'Expected { yaw, pitch } as finite numbers' };
  }
  return { success: true, data: { yaw: obj.yaw, pitch: obj.pitch } };
}

export function validatePlayerId(id: unknown): ValidationResult<string> {
  if (typeof id !== 'string') {
    return { success: false, error: 'Player ID must be a string' };
  }
  if (id.length < CONFIG.playerIdMinLength || id.length > CONFIG.playerIdMaxLength) {
    return { success: false, error: `Player ID length must be ${CONFIG.playerIdMinLength}-${CONFIG.playerIdMaxLength}` };
  }
  if (!CONFIG.playerIdPattern.test(id)) {
    return { success: false, error: 'Player ID contains invalid characters' };
  }
  return { success: true, data: id };
}

// Movement body shared by position + teleport — velocity feeds other
// clients' dead reckoning, so a finite-but-absurd magnitude is poisoned.
export function validateBody(obj: Record<string, unknown>): ValidationResult<{ position: Vec3; rotation: Rotation; velocity: Vec3 }> {
  const pos = validateVec3(obj.position);
  if (!pos.success) return { success: false, error: `position: ${pos.error}` };
  const rot = validateRotation(obj.rotation);
  if (!rot.success) return { success: false, error: `rotation: ${rot.error}` };
  const vel = validateVec3(obj.velocity);
  if (!vel.success) return { success: false, error: `velocity: ${vel.error}` };
  const v = vel.data;
  if (v.x * v.x + v.y * v.y + v.z * v.z > 1000 * 1000) {
    return { success: false, error: 'velocity magnitude out of range' };
  }
  // Position is judge-mode truth — an unbounded coordinate becomes
  // broadcast state and poisons lag-comp history, not just a reject.
  const p = pos.data;
  if (p.x * p.x + p.y * p.y + p.z * p.z > 8192 * 8192) {
    return { success: false, error: 'position magnitude out of range' };
  }
  return { success: true, data: { position: pos.data, rotation: rot.data, velocity: vel.data } };
}

// Optional vec — absent is fine, present-but-bad is not.
type OptVec = { ok: true; data?: Vec3 } | { ok: false; error: string };
/** Client shot nonce — bounded opaque token, never a path/keys source. */
export function optShotId(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= 40 ? v : undefined;
}

/** Wire projectile id — a ledger/record key, so it must be bounded: a 1MB
 *  frame's id would otherwise sit in capped-but-fat maps. Rejects outright —
 *  an oversized id is never a live projectile. */
export function optProjId(v: unknown): { ok: boolean; v?: string } {
  if (typeof v !== 'string' || v.length === 0 || v.length > 64) return { ok: false };
  return { ok: true, v };
}
export function optProjIdOpt(v: unknown): { ok: boolean; v?: string } {
  // null is legal on shot claims — "the shooter's most recent spawn of
  // that weapon" (real clients send it when a miss never minted an id).
  return v === undefined || v === null ? { ok: true } : optProjId(v);
}

/** Claim verdict cursor — the seq the client wants a claimAck for. */
export function optClaimSeq(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff ? v : undefined;
}

export function optVec(value: unknown): OptVec {
  if (value === undefined) return { ok: true };
  const r = validateVec3(value);
  return r.success ? { ok: true, data: r.data } : { ok: false, error: r.error };
}
