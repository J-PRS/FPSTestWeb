/**
 * L2 invariant probes — property checks that must hold EVERY tick, not
 * just at an assert site. The detTrace lockstep proves equality; these
 * prove legality: an engine can be perfectly deterministic and still
 * drift into impossible states (NaN velocity, dead-but-moving, energy
 * out of bounds, flag carried by a corpse). Called on a schedule inside
 * scenario/soak runs — returns violation strings so the caller decides
 * how to report.
 */

import type { Room } from '../../src/Room.ts';
import { ENERGY } from '../../../shared/movement.ts';

// Generous speed cap — terminal is 100 and knockback spikes legitimately
// exceed it momentarily; only a broken integrator produces ~500+.
const MAX_SPEED = 500;

export function checkRoom(room: Room, tag = ''): string[] {
  const out: string[] = [];
  const say = (s: string) => out.push(`${tag ? tag + ': ' : ''}${s}`);

  for (const p of room.players.getAllPlayers().values()) {
    const v = p.velocity;
    if (!Number.isFinite(p.position.x + p.position.y + p.position.z)) {
      say(`${p.id}: non-finite position ${JSON.stringify(p.position)}`);
    }
    if (!Number.isFinite(v.x + v.y + v.z)) {
      say(`${p.id}: non-finite velocity ${JSON.stringify(v)}`);
    } else {
      const speed = Math.hypot(v.x, v.y, v.z);
      if (speed > MAX_SPEED) say(`${p.id}: speed ${speed.toFixed(0)} > ${MAX_SPEED}`);
    }
    if (!Number.isFinite(p.health) || p.health < -0.001) {
      say(`${p.id}: health ${p.health} out of bounds`);
    }
    if (Number.isFinite(p.maxHealth) && p.health > p.maxHealth + 0.001) {
      say(`${p.id}: health ${p.health.toFixed(1)} > max ${p.maxHealth}`);
    }
    // Life/health agreement — a dead flag with positive health (or a live
    // flag at zero) is a resurrection-ledger bug, not a damage number.
    if (p.isDead && p.health > 0.001) say(`${p.id}: isDead but health ${p.health}`);
    if (!p.isDead && p.health <= 0) say(`${p.id}: alive but health ${p.health}`);

    const e = room.moveSim.energyOf(p.id);
    if (e !== null && (!Number.isFinite(e) || e < -0.001 || e > ENERGY.max * 4 + 0.001)) {
      say(`${p.id}: energy ${e} out of bounds`);
    }
  }

  // Flag authority: a carrier must be a living player on the opposing
  // team — a corpse or teammate holding it is a flag-ledger split-brain.
  if (room.flags) {
    for (const f of room.flags.flags.values()) {
      if (f.carrier === null) continue;
      const c = room.players.getPlayer(f.carrier);
      if (!c) { say(`flag ${f.team} carried by ghost ${f.carrier}`); continue; }
      if (c.isDead) say(`flag ${f.team} carried by corpse ${f.carrier}`);
      if (c.team === f.team) say(`flag ${f.team} carried by own-team ${f.carrier}`);
    }
  }
  return out;
}

/** Run a room for `seconds` and probe every `everyTicks`; returns all
 *  violations with their tick stamped by the caller's tag. */
export function probeRun(room: Room, stepFn: (ticks: number) => void, seconds: number, everyTicks = 20): string[] {
  const ticks = Math.round(seconds / 0.05);
  const out: string[] = [];
  for (let t = 0; t < ticks; t += everyTicks) {
    stepFn(everyTicks);
    out.push(...checkRoom(room, `t${(t * 0.05).toFixed(1)}`));
  }
  return out;
}
