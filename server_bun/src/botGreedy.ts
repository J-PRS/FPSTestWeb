/**
 * botGreedy — path-free local driver: every decide window (~4Hz) it
 * rolls ~14 candidate inputs ~0.9s forward through the REAL MoveSim
 * and commits the argmax (progress toward tgt + terminal speed, hard
 * penalty for wall-pinned ticks). Nothing is stored between decides —
 * the stuck-on-track freeze class (a replayed plan reading on-line
 * while pinned) cannot exist because there is no track.
 *
 * Same drive(id, tgt): boolean contract as botMpc — ServerBots swaps
 * the driver behind the arm via FPS_GREEDY, keeping driveMove as the
 * fallback whenever a decide can't run.
 */
import { MoveSim, type MoveSurface, type MoveState } from '../../shared/movement.ts';
import type { Heightfield } from '../../shared/heightfield.ts';
import type { RoomMoveSim } from './RoomMoveSim.ts';
import type { BotVec } from '../../shared/botVec.ts';

/** Candidate yaw offsets (rad) around current heading — the ±90° pair
 *  is what a wall-pinned bot needs to find a new line. */
const DYAWS = [-1.4, -0.9, -0.45, 0, 0.45, 0.9, 1.4];
/** Rollout horizon in sim ticks — ~0.9s at 60Hz. Long enough to read a
 *  face's descent line, short enough that a bad pick costs <1s. */
const ROLL_TICKS = 54;
/** Ticks between decides — 4Hz. Reactive enough that a stale pick ages
 *  out in a quarter second; cheap enough to run per armed bot inline. */
const DECIDE_TICKS = 15;
/** Live speed below this while driving forward counts as pinned —
 *  forces an early re-decide instead of riding the held input. */
const PINNED_SPEED2 = 1;
const PINNED_TICKS = 10;

interface Held { yaw: number; jet: boolean; ticks: number; slow: number }

export class BotGreedy {
  private scratch: MoveSim | null = null;
  private readonly held = new Map<string, Held>();

  constructor(
    private readonly moveSim: RoomMoveSim,
    private readonly field: Heightfield | null,
    private readonly botInput?: (id: string, i: { forward: number; right: number; jump: number; ski: number; jet: number }, status: number) => void,
  ) {}

  release(id: string): void { this.held.delete(id); }

  drive(id: string, tgt: BotVec): boolean {
    if (!this.field) {return false;}
    const sim = this.moveSim.simOf(id);
    const econ = this.moveSim.econOf(id);
    if (!sim || !econ) {return false;}

    let h: Held | null | undefined = this.held.get(id);
    const pinned = sim.state.vel.x * sim.state.vel.x + sim.state.vel.z * sim.state.vel.z < PINNED_SPEED2;
    if (h && pinned) {h.slow += 1;}
    if (!h || h.ticks <= 0 || (h.slow >= PINNED_TICKS)) {
      h = this.decide(id, sim, econ.energy, tgt);
      if (!h) {return false;}
    }
    h.ticks -= 1;
    this.moveSim.faceYaw(id, h.yaw);
    this.moveSim.setInput(id, { forward: 1, right: 0, jumpPressed: false, jumpHeld: false, skiHeld: true, jetHeld: h.jet });
    this.botInput?.(id, { forward: 1, right: 0, jump: 0, ski: 1, jet: h.jet ? 1 : 0 }, 0);
    return true;
  }

  /** Score each candidate by a private rollout — restore the bot's live
   *  snapshot into the scratch sim, drive the candidate, read where it
   *  lands. The snapshot/restore machinery is the same one the MPC
   *  beam uses, so the rollout IS the bot's physics. */
  private decide(id: string, sim: MoveSim, energy: number, tgt: BotVec): Held | null {
    if (!this.scratch) {
      this.scratch = new MoveSim((sim as unknown as { surface: MoveSurface }).surface,
        { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, onGround: false } as MoveState);
    }
    const sc = this.scratch;
    sc.mass = sim.mass; sc.eyeHeight = sim.eyeHeight; sc.bodyRadius = sim.bodyRadius;
    sc.speedScale = sim.speedScale; sc.waterLevel = sim.waterLevel;
    const snap = sim.snapshot();
    const st = sim.state;
    const d0 = Math.hypot(tgt.x - st.pos.x, tgt.z - st.pos.z);
    const baseYaw = st.yaw;
    const jetOk = energy > 15;

    // Total mechanical energy the bot STARTS with (KE + PE, g=28 —
    // shared/movement GRAVITY). The best rollout is the one that BANKS
    // it: descent → speed, no wall bleed. Reference cancels so ΔE is
    // the only term that matters.
    const v02 = st.vel.x * st.vel.x + st.vel.y * st.vel.y + st.vel.z * st.vel.z;
    const e0 = v02 / 2 + 28 * st.pos.y;
    let best: Held | null = null;
    let bestScore = -Infinity;
    for (const dyaw of DYAWS) {
      for (const jet of [false, true]) {
        if (jet && !jetOk) {continue;}
        this.cold(sc, snap);
        sc.state.yaw = baseYaw + dyaw;
        sc.setInput({ forward: 1, right: 0, jumpPressed: false, jumpHeld: false, skiHeld: true, jetHeld: jet });
        let pinnedTicks = 0;
        for (let t = 0; t < ROLL_TICKS; t += 1) {
          sc.update(1 / 60);
          const v = sc.state.vel;
          if (v.x * v.x + v.z * v.z < PINNED_SPEED2) {pinnedTicks += 1;}
        }
        const s = sc.state;
        const d1 = Math.hypot(tgt.x - s.pos.x, tgt.z - s.pos.z);
        const v12 = s.vel.x * s.vel.x + s.vel.y * s.vel.y + s.vel.z * s.vel.z;
        const dE = (v12 / 2 + 28 * s.pos.y) - e0;
        // progress + banked energy − wall bleed. 0.06·dE: a +30 m/s
        // gain is worth ~27m of line; a 30m dead climb costs ~50.
        const score = (d0 - d1) + 0.06 * dE - 4 * pinnedTicks + (d1 < 8 ? 40 : 0);
        if (score > bestScore) {bestScore = score; best = { yaw: baseYaw + dyaw, jet, ticks: DECIDE_TICKS, slow: 0 };}
      }
    }
    if (!best) {return null;}
    this.held.set(id, best);
    return best;
  }

  /** Same cold-start the beam uses — warm ground bookkeeping carries a
   *  phantom touchdown into every rollout and poisons descent lines. */
  private cold(sc: MoveSim, snap: ReturnType<MoveSim['snapshot']>): void {
    sc.restore(snap);
    const x = sc as unknown as { wishJump: boolean; allowNextJump: boolean; groundedBuffered: boolean; groundGraceT: number; acc: number; bandDist: number; impulseT: number; lastJumpableNormal: { x: number; y: number; z: number } };
    x.wishJump = false; x.allowNextJump = false; x.groundedBuffered = false;
    x.groundGraceT = 0; x.acc = 0; x.bandDist = Infinity; x.impulseT = 0;
    x.lastJumpableNormal.x = 0; x.lastJumpableNormal.y = 1; x.lastJumpableNormal.z = 0;
  }
}
