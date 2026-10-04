// Leaf helpers shared by TickLoop and its fanout family (tickRecords):
// heal math, record suppression, the TickRecord shape. Pulled out so
// tickRecords doesn't import TickLoop — an arsenal-style runtime cycle.
import { CONFIG } from './config.ts';
import { STATUS, CLIENT_STATUS_MASK, MEND_HP_PER_SEC } from '../../shared/status.ts';
import { perkMods } from '../../shared/perks.ts';
import { POWERUP } from '../../shared/pickups.ts';
import type { PlayerState } from './types.ts';

// Medkit: hp restored per broadcast tick while the mending flag is up —
// a field patch, not a fountain. Rate is shared (status.ts).
const MEND_HP_PER_TICK = MEND_HP_PER_SEC / CONFIG.tickRate;

/** Server-owned heal channels for one broadcast tick: medkit channel,
 *  regenerator perk, regen powerup — all cap at the perk max (the caller
 *  applies the clamp). */
export function healPerTick(p: Pick<PlayerState, 'isDead' | 'health' | 'maxHealth' | 'status' | 'regenUntil' | 'perk'>, now: number): number {
  if (p.isDead || p.health >= p.maxHealth) return 0;
  let heal = perkMods(p.perk).regen / CONFIG.tickRate;
  if (p.status & STATUS.MEND) heal += MEND_HP_PER_TICK;
  if (now < p.regenUntil) heal += POWERUP.regenHpPerSec / CONFIG.tickRate;
  return heal;
}

interface SuppressablePlayer { position: { x: number; y: number; z: number }; rotation: { yaw: number; pitch: number }; health: number; isDead: boolean; skiing: number; status: number }
interface SuppressableSent { x: number; y: number; z: number; vx: number; vy: number; vz: number; yaw: number; pitch: number; hp: number; dead: boolean; ski: number; status: number; sheep: number; t: number }

/** Update suppression: if the player still sits where a dead-reckoning
 *  client would extrapolate them (linear pos+vel from the last sent
 *  record), the update carries no new information — skip it. */
export function recordSuppressed(p: SuppressablePlayer, lastSent: SuppressableSent, now: number, sheep = 0): boolean {
  const elapsed = (now - lastSent.t) / 1000;
  const ex = lastSent.x + lastSent.vx * elapsed;
  const ey = lastSent.y + lastSent.vy * elapsed;
  const ez = lastSent.z + lastSent.vz * elapsed;
  const dx = p.position.x - ex;
  const dy = p.position.y - ey;
  const dz = p.position.z - ez;
  const predErrSq = dx * dx + dy * dy + dz * dz;
  // Yaw wraps — a raw |a-b| reads a 6.27→0.01 crossing as a huge turn and
  // permanently defeats suppression for spinners. Compare the shortest arc.
  const yawDiff = Math.abs(((p.rotation.yaw - lastSent.yaw + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
  const pitchDiff = Math.abs(p.rotation.pitch - lastSent.pitch);
  // State fields (health/death/ski/status) must never be eaten by the
  // position check — a flag change forces the record even when the
  // player hasn't moved.
  // lastSent.status is the wire value — REGEN/DD bits OR'd in at send time —
  // so mask it back to client bits before comparing or a buff defeats
  // suppression for its whole duration.
  const stateChanged = p.health !== lastSent.hp || p.isDead !== lastSent.dead || p.skiing !== lastSent.ski || p.status !== (lastSent.status & CLIENT_STATUS_MASK)
    // Sheep isn't a player field — it lives on the bot driver — so the
    // suppression check reads it off the record args (0 for humans).
    || sheep !== lastSent.sheep;
  // Idle players still heartbeat at 4Hz — a >300ms silence would trigger
  // client-side dead reckoning on a stationary player.
  return !stateChanged && predErrSq < 0.09 && yawDiff < 0.02 && pitchDiff < 0.03 && now - lastSent.t < 250;
}

/** One encoded position update waiting for fanout — data is pre-encoded
 *  once so per-recipient sends are buffer concatenation, not re-serialization. */
export interface TickRecord {
  playerId: string;
  data: Uint8Array;
  pos: { x: number; y: number; z: number };
  force: boolean;
}
