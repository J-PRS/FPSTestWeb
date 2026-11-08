/**
 * BotSlew - human-shaped aiming turns for a bot body, one instance per
 * bot, driven by BOTH hosts (offline GameBot.locomote, server driveMove)
 * so a bot's crosshair behaves identically wherever the sim runs.
 *
 * Humans don't turn at a constant rate: a flick is a ballistic spring -
 * fast mid-arc, decelerating into a small overshoot + settle (Fitts /
 * bang-bang control) - and tracking carries continuous low-frequency
 * motor noise that SHRINKS the longer the bot has been on target (KTX
 * bot_aim's volatility: big error at contact, decaying over ~1.5s of
 * engagement, re-spiking on target switch). A constant rad/s slew reads
 * as an aimbot for exactly the uniformity this removes.
 *
 * All randomness rides skill.rng - the brain's private deterministic
 * stream - so server sims stay replayable. Hosts feed `dt`, never clocks.
 */

import { wrapAngleDelta } from './angles.ts';
import type { BotSkill } from './botSkill.ts';

/** Yaw jump larger than this = target switch → volatility resets. */
const SWITCH_RAD = 0.3;
/** Error below this with low spring velocity = deadzone, no micro-twitch. */
const DEAD_RAD = 0.012;

const axisMid = (p: { moving: number; still: number } | undefined): number =>
  p ? (p.moving + p.still) * 0.5 : 0.6;

export class BotSlew {
  private vy = 0;
  private vp = 0;
  /** Seconds on the current aim - the volatility clock. */
  private settle = 0;
  /** Last want-yaw for switch detection (NaN until first call). */
  private ty = Number.NaN;
  /** OU noise state per axis. */
  private nY = 0;
  private nP = 0;
  /** No-skill fallback stream - LCG keeps even a skill-less bot
   *  deterministic (sims stay replayable; hosts normally pass
   *  skill.rng anyway). */
  private fbSeq = 0x9E_37_79_B9;
  private fbRng(): number {
    this.fbSeq = (this.fbSeq * 1_664_525 + 1_013_904_223) >>> 0;
    return this.fbSeq / 0x1_00_00_00_00;
  }

  private ou(dt: number, n: number, sigma: number, rng: () => number): number {
    // Ornstein-Uhlenbeck: mean-reverting, band-limited - wanders like a
    // hand, never random-walks off. Two uniform draws ≈ gaussian step.
    const g = rng() + rng() - 1;
    return n + (-n * 6 * dt + sigma * g * Math.sqrt(dt));
  }

  private axis(dt: number, cur: number, err: number, v: number, om: number, z: number, pursuit: number): [number, number] {
    if (Math.abs(err) < DEAD_RAD && Math.abs(v) < 0.5) {
      v *= Math.max(0, 1 - 14 * dt); // deadzone: kill residual drift
      return [cur + v * dt, v];
    }
    v += (om * om * err - 2 * z * om * v) * dt;
    v = Math.max(-pursuit, Math.min(pursuit, v));
    return [cur + v * dt, v];
  }

  /** One frame of facing. wantYaw/wantPitch = the heading the host chose
   *  (aim while a shot is live, dest otherwise); returns the new angles.
   *  skill omitted = mid-tier bot. */
  face(dt: number, yaw: number, wantYaw: number, pitch: number, wantPitch: number,
    skill?: BotSkill): { yaw: number; pitch: number } {
    if (dt <= 0) {return { yaw, pitch };}
    const snap = axisMid(skill?.axes.snap);
    const track = axisMid(skill?.axes.track);
    const rng = skill?.rng ?? ((): number => this.fbRng());

    // Volatility: resets on a target switch, decays to a floor over
    // ~1.5-2s of continuous engagement (KTX: contact is sloppy, the
    // bot "gets a read" as the fight continues).
    if (!Number.isFinite(this.ty) || Math.abs(wrapAngleDelta(wantYaw - this.ty)) > SWITCH_RAD) {
      this.settle = 0;
    }
    this.ty = wantYaw;
    this.settle += dt;
    const vol = 0.3 + 0.7 * Math.exp(-this.settle * 2);

    // Spring: snap drives the flick's speed, track drives pursuit cap;
    // worse bots get less damping → bigger overshoot before settling.
    const om = 7 + snap * 7;            // ~8-14 rad/s natural freq
    const z = 0.92 - (1 - track) * 0.3; // ~0.62-0.92 damping
    const pursuit = 3.5 + track * 4.5;  // ~4-8 rad/s sustained cap

    const errY = wrapAngleDelta(wantYaw - yaw);
    const errP = wantPitch - pitch;
    const nSigma = vol * (1.25 - track) * 0.35;
    this.nY = this.ou(dt, this.nY, nSigma, rng);
    this.nP = this.ou(dt, this.nP, nSigma * 0.7, rng);

    const [ny, vy] = this.axis(dt, yaw, errY + this.nY, this.vy, om, z, pursuit);
    const [np, vp] = this.axis(dt, pitch, errP + this.nP, this.vp, om, z, pursuit);
    this.vy = vy; this.vp = vp;
    return { yaw: ny, pitch: np };
  }
}
