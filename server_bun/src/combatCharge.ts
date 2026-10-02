import type { PlayerState } from './types.ts';
import { lgChargeAt, lgTickDamage, LG_TICK_BASE, LG_RAMP_WINDOW_S, LG_POP_CHARGE_MULT } from '../../shared/combat.ts';
import { simNow } from './simClock.ts';

/** The LG charge economy: beam ticks bank withheld damage onto the victim
 *  as a walking bomb; any later hit — or death — detonates the bank as a
 *  real blast credited to the detonating shooter. State lives on the
 *  player (`charge`/`chargeT`, epoch-s timebase); the per-shooter ramp
 *  map lives here. The detonation itself stays in CombatHandler (it's a
 *  processAOE blast) — this class just decides WHEN it goes off and how
 *  much of the bank it spends. */
export class ChargeBank {
  /** Consecutive beam ticks on one victim ramp the tick down — the
   *  withheld share is what banks. A target switch or a lull resets. */
  private ramp = new Map<string, { targetId: string | null; t: number; n: number }>();

  constructor(private pop: (ownerId: string, target: PlayerState, amount: number) => void) {}

  step(shooterId: string, targetId: string | null): number {
    const now = simNow() / 1000;
    const st = this.ramp.get(shooterId);
    const n = st && st.targetId === targetId && now - st.t <= LG_RAMP_WINDOW_S ? st.n + 1 : 1;
    this.ramp.set(shooterId, { targetId, t: now, n });
    return n;
  }

  /** Bank withheld beam damage onto the victim — the walking bomb.
   *  The bank drains lazily at 5× fill rate once the beam leaves them,
   *  matching the client's shroud shrink exactly. */
  bank(target: PlayerState, withheld: number): void {
    const now = simNow() / 1000;
    target.charge = lgChargeAt(target.charge, target.chargeT, now) + withheld * LG_POP_CHARGE_MULT;
    target.chargeT = now;
  }

  of(target: PlayerState): number {
    return lgChargeAt(target.charge, target.chargeT, simNow() / 1000);
  }

  /** Detonate `amount` worth of a victim's banked charge as a real
   *  blast — the remainder keeps smoldering. Credit goes to the
   *  detonating shooter through the pop callback. */
  discharge(ownerId: string, target: PlayerState, amount: number): void {
    const now = simNow() / 1000;
    target.charge = lgChargeAt(target.charge, target.chargeT, now) - amount;
    target.chargeT = now;
    this.pop(ownerId, target, amount);
  }

  /** Death-burst: a killed victim pops for everything still banked. */
  corpse(shooterId: string, target: PlayerState): void {
    const acc = this.of(target);
    if (acc <= 0) return;
    target.charge = 0; // zero before the blast — a chain kill can't double-pop the same bank
    this.pop(shooterId, target, acc);
  }

  /** Withheld share a beam tick banks on the victim — the ramp's gap
   *  between the full base tick and the stepped tick actually taken. */
  withheldFor(n: number): number {
    return LG_TICK_BASE - lgTickDamage(n);
  }

  delete(shooterId: string): void { this.ramp.delete(shooterId); }
}
