/**
 * botMoves — movement-hint intent for BotBrain: ski/jet/jump as the same
 * buttons a human presses. Committed jet windows (a player holds a burn,
 * not per-frame feathering), the Tribes hop read off the terrain probe,
 * and the anti-sheep momentum boost. Kept apart from destination logic
 * so "where to go" and "how to get there" each read on their own.
 */
import { botRand } from './botRand.ts';
import type { BotVec, BrainCtx, BrainOut } from './botBrain.ts';

export interface MovesHost {
  /** Escape burst arming — a stuck bot thrusts up and over the pocket. */
  escapeJetT(): number;
  /** Active hunt target, for the airborne-prey jet read. */
  huntPos(): BotVec | null;
}

export class BotMoves {
  constructor(private host: MovesHost) {}

  /** Committed jet window — a player holds RMB for a real burn
   *  (~0.5-1s), not per-frame feathering. Without the latch the slope
   *  probes flicker mid-climb and the jet strobes on/off, which reads
   *  as buzzing instead of thrusting. */
  private jetHold = 0;
  /** Last gate that armed a burn — harness telemetry reads this to tell
   *  climbs apart from boosts without parsing behavior logs. */
  jetWhy = '-';
  /** Last computed jet bit — what actually reached the input layer. */
  jetOut = false;
  holdFor(): number { return this.jetHold; }

  hints(dt: number, ctx: BrainCtx, pos: BotVec, dest: BotVec): BrainOut['move'] {
    const dx = dest.x - pos.x, dz = dest.z - pos.z;
    const gd = Math.hypot(dx, dz);
    if (gd < 0.5) return { ski: false, jet: false, jump: false };
    const nx = dx / gd, nz = dz / gd;
    const g0 = ctx.groundY(pos.x, pos.z);
    const rise = ctx.groundY(pos.x + nx * 6, pos.z + nz * 6) - g0;
    const speed = ctx.vel ? Math.hypot(ctx.vel.x, ctx.vel.z) : 0;
    const airborne = pos.y - g0 > 2;
    // Jet when the way ahead climbs faster than running covers — or the
    // hunt target is clearly airborne and pursuit needs altitude.
    const uphill = rise > 2;
    // Jet respects the tank — below the reserve the bot saves energy for
    // skills rather than hovering dry at the wall.
    const tanked = ctx.energy === undefined || ctx.energy > 15;
    this.jetHold = Math.max(0, this.jetHold - dt);
    // Re-arm while the reason holds (a long climb = one long burn),
    // plus a minimum pulse so a gate flicker can't chop the burn.
    if (this.wantJet(ctx, pos, dest, rise, speed, gd, airborne) && tanked) {
      this.jetHold = Math.max(this.jetHold, 0.45 + botRand() * 0.4);
    }
    // The dive: a destination at or below the bot within graze range
    // wants gravity, not thrust — a capper jets to the stand's zip code,
    // then lets momentum carry the touch. Without this the boost read
    // (speed < 12) kept orbiting bodies airborne above the very stand
    // they were told to land on.
    const diveRun = gd < 45 && dest.y < pos.y + 4;
    if (diveRun) this.jetHold = 0;
    const jet = !diveRun && (this.jetHold > 0 || this.host.escapeJetT() > 0) && tanked;
    this.jetOut = jet;
    return {
      // Tribes default: ski is held whenever the bot has somewhere to
      // be. Momentum is life — a bot that only skis downhill reads as a
      // pedestrian, which is exactly the sheep behavior the watchdog
      // now flags. Friction/jets sort out the uphill cost.
      ski: true,
      jet,
      // Uphill + near-stationary = hop it; autohop chains the rest.
      jump: uphill && speed < 3 && !airborne,
    };
  }

  /** Whether the situation calls for a burn: genuine climbs, airborne
   *  prey, a high destination — or discretionary speed plays when the
   *  tank is comfortable. */
  private wantJet(ctx: BrainCtx, pos: BotVec, dest: BotVec, rise: number, speed: number, gd: number, airborne: boolean): boolean {
    const targetHigh = (this.host.huntPos()?.y ?? -Infinity) - pos.y > 6;
    const destHigh = dest.y - pos.y > 3;
    // Hard ceiling: past ~30m AGL a held burn is ballooning, not skiing —
    // featherjets turned a shallow hop chain into a 250m balloon ride.
    // High prey still earns altitude; everything else glides back down.
    if (!targetHigh && pos.y - ctx.groundY(pos.x, pos.z) > 30) return false;
    // Discretionary spending asks for a healthier tank — boosting to
    // speed is nice-to-have, climbing out of a hole is not.
    const comfy = ctx.energy === undefined || ctx.energy > 30;
    // The Tribes hop: on gentle rises, ski through the approach and jet-
    // assist over the lip — the up-over-down rhythm that converts energy
    // into speed. A bot that only jets on cliffs never gets dynamic.
    const hop = rise > 0.5 && rise <= 3;
    // The anti-sheep move: a bot at walking pace with ground to cover
    // jets to build momentum — but only flat-or-downhill from the
    // deck. Burn while facing uphill buys altitude, not speed (the
    // cap run showed a featherjets bot jetting 200m up on spawn);
    // burn already fast in the air just empties the tank.
    const boost = speed < 12 && gd > 15 && comfy && rise <= 1.5 && !airborne;
    this.jetWhy = rise > 2 ? 'climb' : targetHigh ? 'prey' : destHigh ? 'destHigh' : hop ? 'hop' : boost ? 'boost' : '-';
    return this.jetWhy !== '-';
  }
}
