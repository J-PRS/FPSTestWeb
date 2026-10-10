/** Per-bot skill matrix — rolled once at spawn, drifts slightly across a
 *  match. Axes are independent draws: a bot can be a snap phenom AND a
 *  mortar artist, or hopeless at both, like a real lobby. Each aim axis
 *  splits vs-moving (lead/prediction) from vs-stationary (placement) —
 *  a mortar-vs-stand phenom can be terrible at leading a skier.
 *
 *  Rolls run on a PRIVATE PRNG seeded from the spawn point — never
 *  botRand. Deterministic harnesses mock botRand's stream and pin exact
 *  duel outcomes; drawing skill numbers off that stream would silently
 *  re-sequence every behavior roll downstream. Same spawn → same
 *  matrix, which also keeps a bot's personality consistent across
 *  respawns like a real player's. */
import { WeaponType } from './weapons.ts';
import type { BotVec } from './botVec.ts';

export type AimAxis = 'snap' | 'track' | 'arcLead' | 'arcJudge';

export interface AxisPair { moving: number; still: number }

/** Named difficulty band — one object scales every skill draw and
 *  reaction constant, so a lobby knob (easy→impossible) moves the
 *  whole distribution instead of one constant at a time. Team variance
 *  stays: the band shifts the distribution's center, each bot still
 *  rolls its own spread around it. */
export type BotTier = 'easy' | 'medium' | 'hard' | 'impossible';
export interface BotTierMods {
  /** Multiplies every aim-axis draw. */
  aim: number;
  /** Multiplies the movement (ski/jet competence) draw. */
  move: number;
  /** Reaction-delay multiplier — lower reacts sooner. */
  react: number;
  /** Aim-error multiplier — lower lands steadier shots. */
  jitter: number;
  /** Volley-cadence multiplier — higher fires faster. */
  temper: number;
}
export const BOT_TIERS: Record<BotTier, BotTierMods> = {
  // A new player wins duels by accident: sees late, sprays wide, slow volleys.
  easy: { aim: 0.55, move: 0.7, react: 2.2, jitter: 1.8, temper: 0.8 },
  medium: { aim: 1, move: 1, react: 1, jitter: 1, temper: 1 },
  hard: { aim: 1.25, move: 1.15, react: 0.7, jitter: 0.7, temper: 1.15 },
  // Ceiling-ish, not superhuman — axes still cap at 1.5 like any phenom.
  impossible: { aim: 1.45, move: 1.3, react: 0.45, jitter: 0.5, temper: 1.3 },
};

/** Per-axis mix — each field names the band to borrow that axis from,
 *  so a team can be {aim:'impossible', move:'easy'} (stormtrooper
 *  skiers) vs the inverse. Missing axes default to medium. */
export type BotSkillMix = Partial<Record<keyof BotTierMods, BotTier>>;
export type BotSkillSpec = BotTier | BotSkillMix;

/** Resolve a tier name or per-axis mix into one mods row. */
export function skillMods(spec: BotSkillSpec | undefined): BotTierMods {
  if (!spec || spec === 'medium') return BOT_TIERS.medium;
  if (typeof spec === 'string') return BOT_TIERS[spec];
  const m = BOT_TIERS.medium;
  const out = { ...m } as BotTierMods;
  for (const k of ['aim', 'move', 'react', 'jitter', 'temper'] as const) {
    const t = spec[k];
    if (t) out[k] = BOT_TIERS[t][k];
  }
  return out;
}

export interface BotSkill {
  axes: Record<AimAxis, AxisPair>;
  /** Ski/jet competence — how well it holds speed and picks lines. */
  movement: number;
  /** Form multiplier: >1 in the zone, <1 tilted. Random-walked each
   *  think; hits knock it down. */
  form: number;
  /** Preferred launch tool: pull-disc surfers lob the implosion ahead
   *  (no heel-shot turnaround); others ride the classic push blast. A
   *  personality draw, not a skill — both styles top out the same. */
  beltPull: boolean;
  /** Low-HP close-combat nerve: high-courage bots keep firing explosives
   *  point-blank and take the occasional self-frag with the enemy;
   *  cautious ones swap to a safe slot before the splash does them in.
   *  Personality draw like beltPull, so duels end differently per bot. */
  courage: number;
  /** The spec this roll was drawn from — hunt/brain reads the resolved
   *  mods for reaction delay, jitter and cadence. */
  readonly spec: BotSkillSpec;
  readonly mods: BotTierMods;
  /** Private stream — form drift consumes it, not the shared botRand. */
  rng: () => number;
}

/** mulberry32 — tiny deterministic stream for skill rolls. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rollSkill(spawn: BotVec, spec: BotSkillSpec = 'medium'): BotSkill {
  const seed = Math.imul(spawn.x | 0, 73856093) ^ Math.imul(spawn.z | 0, 19349663) ^ Math.imul(spawn.y | 0, 83492791);
  const rng = prng(seed || 1);
  const mods = skillMods(spec);
  const clamp = (v: number) => Math.min(1.5, Math.max(0.45, v));
  const axis = (): AxisPair => {
    const base = (0.55 + rng() * 0.9) * mods.aim;
    const spread = 0.3;
    return {
      moving: clamp(base + (rng() - 0.5) * spread),
      still: clamp(base + (rng() - 0.5) * spread),
    };
  };
  return {
    axes: { snap: axis(), track: axis(), arcLead: axis(), arcJudge: axis() },
    movement: clamp((0.7 + rng() * 0.8) * mods.move),
    form: 1,
    beltPull: rng() < 0.45,
    courage: rng(),
    spec,
    mods,
    rng,
  };
}

/** Weapon → the axis its shots actually exercise. Thrown/no-skill
 *  types return null and always shoot at 1×. */
export function weaponAxis(w: number): AimAxis | null {
  switch (w as WeaponType) {
    case WeaponType.Railgun:
    case WeaponType.RemoteRailgun:
    case WeaponType.Pistol:
    case WeaponType.Revolver:
    case WeaponType.Javelin:
      return 'snap';
    case WeaponType.Chaingun:
    case WeaponType.Lightning:
    case WeaponType.Shotgun:
    case WeaponType.PlasmaGun:
    case WeaponType.PlasmaCannon:
    case WeaponType.Sprinkler:
      return 'track';
    case WeaponType.Disc:
    case WeaponType.DiscPull:
    case WeaponType.RocketLauncher:
    case WeaponType.Flak:
    case WeaponType.Cannon:
    case WeaponType.Bombard:
    case WeaponType.GrenadeLauncher:
    case WeaponType.ImpactGrenade:
    case WeaponType.MRVLauncher:
      return 'arcLead';
    case WeaponType.BoltLauncher:
    case WeaponType.Mortar:
    case WeaponType.Grenade:
    case WeaponType.Sticky:
    case WeaponType.ClusterBomb:
      return 'arcJudge';
    default:
      return null;
  }
}

/** Effective multiplier for one shot: blends the axis' moving/still
 *  pair by how fast the target is actually going (a stand-still flag
 *  stand under mortar fire is pure `still`), then applies form. */
export function aimSkillFor(s: BotSkill, weapon: number, targetSpeed: number): number {
  const ax = weaponAxis(weapon);
  if (!ax) return 1;
  const p = s.axes[ax];
  const w = Math.min(1, targetSpeed / 20);
  return (p.still * (1 - w) + p.moving * w) * s.form;
}

/** Form drift: slow random walk toward ±15%, so a bot warms up and
 *  cools off through a match rather than playing identically all game. */
export function driftForm(s: BotSkill, dt: number): void {
  s.form += (s.rng() - 0.5) * 0.02 * dt;
  s.form = Math.min(1.15, Math.max(0.85, s.form));
}
