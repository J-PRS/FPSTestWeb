import { cloakDrainPerSec, ENERGY } from '../../../shared/movement.js';
import { STATUS, MEND_HP_PER_SEC } from '../../../shared/status.js';
import type { GameBot } from './botBrain.js';

// The bot's honest energy tank: rising-edge activation costs, held
// drains, mend heal + regen trickle, jet fuel. One tank feeds jets AND
// skills — mirrors the server's per-player rule.

export function applyStatus(b: GameBot, claim: number, dt: number): void {
    const want = claim & (STATUS.MEND | STATUS.SHIELD | STATUS.CLOAK);
    // Rising-edge activation cost per bit.
    const rising = want & ~b.status;
    const antes: [number, number][] = [
      [STATUS.MEND, ENERGY.mendCost], [STATUS.SHIELD, ENERGY.shieldCost], [STATUS.CLOAK, ENERGY.cloakCost],
    ];
    for (const [bit, cost] of antes) {
      if (!(rising & bit)) continue;
      if (b.energy >= cost) b.energy -= cost;
      else claim &= ~bit;
    }
    b.status = claim & (STATUS.MEND | STATUS.SHIELD | STATUS.CLOAK);
    // Held drains — the brain re-declares every think, so a bit it
    // can't afford to keep simply drops here.
    const drain = (bit: number, perSec: number) => {
      if (!(b.status & bit)) return;
      b.energy -= perSec * dt;
      if (b.energy <= 0) { b.energy = 0; dropSkill(b, bit); }
    };
    drain(STATUS.MEND, ENERGY.mendDrain);
    drain(STATUS.SHIELD, ENERGY.shieldDrain);
    drain(STATUS.CLOAK, cloakDrainPerSec(Math.hypot(b.velocity.x, b.velocity.z)));
    // Mend channel heals — the wire rate (shared/status.ts).
    if (b.status & STATUS.MEND) b.botHp = Math.min(b.botMaxHp, b.botHp + MEND_HP_PER_SEC * dt);
    // Regenerator — the server's per-player trickle, same rate.
    if (b.mods.regen > 0 && !b.isDead) b.heal(b.mods.regen * dt);
    b.setMending(!!(b.status & STATUS.MEND));
    b.setShielded(!!(b.status & STATUS.SHIELD));
    setCloakVisual(b);
  }

/** Cloak display: a teammate's held cloak is the ghost shimmer, an
 *  enemy's is full invisibility — same split the wire path applies. */
function setCloakVisual(b: GameBot): void {
    const cloaked = !!(b.status & STATUS.CLOAK);
    const friendly = cloaked && b.team === b.localTeam && b.localTeam !== undefined;
    b.setCloakHidden(cloaked && !friendly);
    b.setCloakGhosted(cloaked && friendly);
  }

export function dropSkill(b: GameBot, bit: number): void {
    b.status &= ~bit;
    if (bit === STATUS.MEND) b.setMending(false);
    else if (bit === STATUS.SHIELD) b.setShielded(false);
    else if (bit === STATUS.CLOAK) { b.setCloakHidden(false); b.setCloakGhosted(false); }
  }

  /** One tank feeds jets AND skills — featherjets' fuel regen and
   *  overcharge's pool regen both land here. */
export function fuelTick(b: GameBot, dt: number, jet: boolean): void {
    if (jet) b.energy = Math.max(0, b.energy - ENERGY.jetDrain * b.mods.jetDrain * dt);
    else if (b.moveState.onGround && b.energy < b.energyCap) {
      b.energy = Math.min(b.energyCap, b.energy + ENERGY.jetCharge * b.mods.jetRegen * b.mods.energyRegen * dt);
    }
  }

