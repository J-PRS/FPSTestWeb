// Projectile trail emission lead — see _reference/projectile-trail-lead.md.
//
// quarks deposits every distance-emission particle AT the emitter's current
// matrixWorld (ParticleSystem.emit → spawn), and the trail driver ticks the
// emitter with the shell's freshly-drawn position BEFORE batcher.update in
// the same frame. So the deposit already lands on the drawn shell and needs
// NO lead to reach it.
//
// The one real gap is the 30Hz batcher: it only sims/deposits every OTHER
// render frame (vfxRuntime simParity), so between deposits the newest clump
// sits a frame behind a mesh that keeps moving. Leading by HALF an
// inter-deposit interval centres that error at ±½ frame instead of always
// trailing (lead 0) or — as the old fixed ×2 did, measured from the
// renderOffset-inflated drawn position — always overshooting by up to two
// frames, which is what put a puff in front of fast shells.
//
// The lead is measured from SIM truth (travelPos), never the drawn
// position, so a netcode correction blend (renderOffset) can't masquerade
// as travel and inflate it. A hard cap keeps a hitch/teleport frame from
// cashing as a sky-length lead (the jump-cut in QuarksTrail.emitSegment is
// the second line of defence).

/** Lead in render frames of travel. Zero: smoke/droplet puffs read wrong
 *  AHEAD of the shell (any positive lead deposits them in front of the
 *  mesh on sparse trails); trailing ≤1 frame is the physical direction.
 *  The old 0.5 minimax centred the ±1-frame deposit alternation but put
 *  visible puffs ahead of slow shells. */
export const TRAIL_LEAD_FRAMES = 0;

/**
 * Emitter lead for one emission tick, as a world-space delta to add to the
 * emitter's drawn position. `dx/dy/dz` is the true per-frame travel
 * (travelPos delta), `spd` the speed, `dt` the tick. Returns `[0,0,0]` when
 * there is no measured travel (first frame, teleport resync) so a
 * degenerate frame never invents motion.
 */
export function trailEmitLead(
  dx: number, dy: number, dz: number, spd: number, dt: number,
): [number, number, number] {
  const len2 = dx * dx + dy * dy + dz * dz;
  if (!Number.isFinite(len2) || len2 <= 1e-12) {return [0, 0, 0];}
  const cap = spd * dt * 4 + 3;
  const k = Math.min(1, cap / Math.sqrt(len2)) * TRAIL_LEAD_FRAMES;
  return [dx * k, dy * k, dz * k];
}
