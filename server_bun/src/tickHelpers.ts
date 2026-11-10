// Leaf helpers shared by TickLoop and its fanout family (tickRecords):
// heal math, record suppression, the TickRecord shape. Pulled out so
// tickRecords doesn't import TickLoop -- an arsenal-style runtime cycle.
import { CONFIG } from './config.ts';
import { STATUS, MEND_HP_PER_SEC } from '../../shared/status.ts';
import { perkMods, REGEN_DELAY_S } from '../../shared/perks.ts';
import { POWERUP } from '../../shared/pickups.ts';
import { GRAVITY, MOVEMENT_CONFIG } from '../../shared/movement.ts';
import { classMass } from '../../shared/botClasses.ts';
import type { PlayerState } from './types.ts';

// Medkit: hp restored per broadcast tick while the mending flag is up --
// a field patch, not a fountain. Rate is shared (status.ts).
const MEND_HP_PER_TICK = MEND_HP_PER_SEC / CONFIG.tickRate;

/** Server-owned heal channels for one broadcast tick: medkit channel,
 *  regenerator perk, regen powerup -- all cap at the perk max (the caller
 *  applies the clamp). */
export function healPerTick(p: Pick<PlayerState, 'isDead' | 'health' | 'maxHealth' | 'status' | 'regenUntil' | 'perk' | 'lastDamageAt'>, now: number): number {
  if (p.isDead || p.health >= p.maxHealth) {return 0;}
  const mods = perkMods(p.perk);
  // Regenerator pays per unhurt second PAST the wind-up -- a hit zeroes
  // the ramp, and anything inside REGEN_DELAY_S buys no healing at all.
  let heal = (mods.regen + Math.min(4, mods.regenRamp * Math.max(0, (now - p.lastDamageAt) / 1000 - REGEN_DELAY_S))) / CONFIG.tickRate;
  if (p.status & STATUS.MEND) {heal += MEND_HP_PER_TICK;}
  if (now < p.regenUntil) {heal += POWERUP.regenHpPerSec / CONFIG.tickRate;}
  return heal;
}

interface SuppressablePlayer { position: { x: number; y: number; z: number }; rotation: { yaw: number; pitch: number }; health: number; isDead: boolean; skiing: number; jetting: number; status: number; armorClass?: string }
interface SuppressableSent { x: number; y: number; z: number; vx: number; vy: number; vz: number; yaw: number; pitch: number; hp: number; dead: boolean; ski: number; jet: number; status: number; sheep: number; t: number }

/** Update suppression: if the player still sits where a dead-reckoning
 *  client would extrapolate them, the update carries no new information
 *  -- skip it. The model mirrors the client's DR (remoteInterp.simStep):
 *  gravity on vy always, jet thrust when the wire jet bit rides
 *  (jetForceUp/mass up + jetForceDir/mass along travel). Linear-only
 *  was the conservative version: it missed Tribes' signature smooth
 *  moments -- ski glides, ballistic arcs, held-jet climbs -- the exact
 *  motions a shared model can prove the client already predicts. */
export function recordSuppressed(p: SuppressablePlayer, lastSent: SuppressableSent, now: number, sheep = 0, wireStatus = p.status): boolean {
  const elapsed = (now - lastSent.t) / 1000;
  const t2 = 0.5 * elapsed * elapsed;
  let ex = lastSent.x + lastSent.vx * elapsed;
  let ey = lastSent.y + lastSent.vy * elapsed + GRAVITY * t2;
  let ez = lastSent.z + lastSent.vz * elapsed;
  if (lastSent.jet !== 0) {
    const mass = classMass(p.armorClass);
    ey += (MOVEMENT_CONFIG.jetForceUp / mass) * t2;
    // Directional share rides the velocity heading (the DR proxy when
    // WASD bits aren't on the wire) under the same fwd cap.
    const hv = Math.hypot(lastSent.vx, lastSent.vz);
    if (hv > 0 && hv < MOVEMENT_CONFIG.jetMaxFwdAccel) {
      const d = (MOVEMENT_CONFIG.jetForceDir / mass) * t2 / hv;
      ex += lastSent.vx * d;
      ez += lastSent.vz * d;
    }
  }
  const dx = p.position.x - ex;
  const dy = p.position.y - ey;
  const dz = p.position.z - ez;
  const predErrSq = dx * dx + dy * dy + dz * dz;
  // Yaw wraps -- a raw |a-b| reads a 6.27→0.01 crossing as a huge turn and
  // permanently defeats suppression for spinners. Compare the shortest arc.
  const yawDiff = Math.abs(((p.rotation.yaw - lastSent.yaw + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
  const pitchDiff = Math.abs(p.rotation.pitch - lastSent.pitch);
  // State fields (health/death/ski/status) must never be eaten by the
  // position check -- a flag change forces the record even when the
  // player hasn't moved.
  // wireStatus is the record's status byte -- client bits with REGEN/DD/
  // CHARGED OR'd in -- so comparing it whole ships each buff transition
  // as exactly one record (up AND down), instead of either re-defeating
  // suppression for the buff's life or eating its expiry for good.
  const stateChanged = p.health !== lastSent.hp || p.isDead !== lastSent.dead || p.skiing !== lastSent.ski || p.jetting !== lastSent.jet || wireStatus !== lastSent.status
    // Sheep isn't a player field -- it lives on the bot driver -- so the
    // suppression check reads it off the record args (0 for humans).
    || sheep !== lastSent.sheep;
  // Idle players still heartbeat at 4Hz -- a >300ms silence would trigger
  // client-side dead reckoning on a stationary player.
  return !stateChanged && predErrSq < 0.09 && yawDiff < 0.02 && pitchDiff < 0.03 && now - lastSent.t < 250;
}

/** One encoded position update waiting for fanout -- data is pre-encoded
 *  once so per-recipient sends are buffer concatenation, not re-serialization. */
export interface TickRecord {
  playerId: string;
  data: Uint8Array;
  pos: { x: number; y: number; z: number };
  force: boolean;
  /** Per-recipient full copy -- encoded only while room.introPlayers has
   *  pending joiners; sent to those recipients instead of `data` (their
   *   decode baseline for this wireId is still zero). */
  full?: Uint8Array;
  /** Far-tier sparse copy -- VEL|ROT stripped; >600m recipients
   *  dead-reckon the retained values instead (never on force sends --
   *  knockback extrapolation needs them). */
  sparse?: Uint8Array;
  /** sparse validity key -- rec.data re-encodes every tick, so a cached
   *  sparse is only good for the tick it was cut on. */
  sparseTick?: number;
  /** Precomputed |vel| -- fanout bumps fast movers off the sparse far
   *  tier so their DR seed and interp tangents stay honest. */
  spd?: number;
  /** Numeric key for the per-recipient tier map -- Map<number> hashes
   *  ~3x cheaper than pid strings on the hot scan (2M+ lookups/s at
   *  ~370 seats). A recycled wireId may inherit a stale tier for one
   *  eval, bounded because fresh mints are forced anyway. */
  wireId?: number;
  /** Wire-invisible cloak: emit skips this record for any recipient the
   *  target counts as an enemy (a visual-only hide still ships position). */
  hidden?: boolean;
}
