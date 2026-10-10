// Leaf helpers shared by TickLoop and its fanout family (tickRecords):
// heal math, record suppression, the TickRecord shape. Pulled out so
// tickRecords doesn't import TickLoop — an arsenal-style runtime cycle.
import { CONFIG } from './config.ts';
import { STATUS, MEND_HP_PER_SEC } from '../../shared/status.ts';
import { perkMods } from '../../shared/perks.ts';
import { POWERUP } from '../../shared/pickups.ts';
import type { PlayerState } from './types.ts';

// Medkit: hp restored per broadcast tick while the mending flag is up —
// a field patch, not a fountain. Rate is shared (status.ts).
const MEND_HP_PER_TICK = MEND_HP_PER_SEC / CONFIG.tickRate;

/** Server-owned heal channels for one broadcast tick: medkit channel,
 *  regenerator perk, regen powerup — all cap at the perk max (the caller
 *  applies the clamp). */
export function healPerTick(p: Pick<PlayerState, 'isDead' | 'health' | 'maxHealth' | 'status' | 'regenUntil' | 'perk' | 'lastDamageAt'>, now: number): number {
  if (p.isDead || p.health >= p.maxHealth) return 0;
  const mods = perkMods(p.perk);
  // Regenerator pays per UNHURT second, not a flat drip — a hit zeroes
  // the ramp so chip damage denies the heal entirely.
  let heal = (mods.regen + mods.regenRamp * Math.max(0, (now - p.lastDamageAt) / 1000)) / CONFIG.tickRate;
  if (p.status & STATUS.MEND) heal += MEND_HP_PER_TICK;
  if (now < p.regenUntil) heal += POWERUP.regenHpPerSec / CONFIG.tickRate;
  return heal;
}

interface SuppressablePlayer { position: { x: number; y: number; z: number }; rotation: { yaw: number; pitch: number }; health: number; isDead: boolean; skiing: number; jetting: number; status: number }
interface SuppressableSent { x: number; y: number; z: number; vx: number; vy: number; vz: number; yaw: number; pitch: number; hp: number; dead: boolean; ski: number; jet: number; status: number; sheep: number; t: number }

/** Update suppression: if the player still sits where a dead-reckoning
 *  client would extrapolate them (linear pos+vel from the last sent
 *  record), the update carries no new information — skip it. */
export function recordSuppressed(p: SuppressablePlayer, lastSent: SuppressableSent, now: number, sheep = 0, wireStatus = p.status): boolean {
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
  // wireStatus is the record's status byte — client bits with REGEN/DD/
  // CHARGED OR'd in — so comparing it whole ships each buff transition
  // as exactly one record (up AND down), instead of either re-defeating
  // suppression for the buff's life or eating its expiry for good.
  const stateChanged = p.health !== lastSent.hp || p.isDead !== lastSent.dead || p.skiing !== lastSent.ski || p.jetting !== lastSent.jet || wireStatus !== lastSent.status
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
