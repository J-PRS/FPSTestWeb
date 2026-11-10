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
import { WEAPONS } from './weaponRows.ts';
import type { BotVec } from './botVec.ts';

const clamp = (v: number): number => Math.min(1.5, Math.max(0.45, v));


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
  if (!spec || spec === 'medium') {return BOT_TIERS.medium;}
  if (typeof spec === 'string') {return BOT_TIERS[spec];}
  const m = BOT_TIERS.medium;
  const out = (((Object.assign({}, m)))) as BotTierMods;
  for (const k of ['aim', 'move', 'react', 'jitter', 'temper'] as const) {
    const t = spec[k];
    if (t) {out[k] = BOT_TIERS[t][k];}
  }
  return out;
}

export interface BotSkill {
  axes: Record<AimAxis, AxisPair>;
  /** Pre-resolve snapshot - applyResolve lerps axes/mods/movement from
   *  these toward impossible; the roll values are never touched. */
  baseAxes: Record<AimAxis, AxisPair>;
  baseMove: number;
  baseMods: BotTierMods;
  /** Hero mode resolve 0-1+ - sustained escalation from team deficit,
   *  menace pressure, and personal performance. Distinct from the
   *  brain's heroT last-stand roll: this one changes WHO the bot is,
   *  not how loud it fights. >1 = results overdrive. */
  resolve: number;
  /** Menace HP at the last think - the damage ledger overdrive reads. */
  prevMenaceHp: number;
  /** Damage bought breathing room: hurting the menace pauses overdrive
   *  for odHold seconds - a one-tick snap would re-arm instantly. */
  odHold: number;
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
  /** Energy thrift 0..1 - share of WASTEFUL grounded burns (flat
   *  boost/hop/runIn: friction-eaten forward thrust) the bot refuses.
   *  Efficient airborne spends (tap/skyBank/tail/apex) and mission
   *  burns (climb/mount/prey/escape) are exempt - conserving the tank
   *  is the point, not never spending. Personality draw like courage.
   *  The evo hook for "preserve kinetic+potential energy". */
  thrift: number;
  /** Air affinity 0..1 - how much the bot *wants* altitude: scales
   *  recon-climb frequency, burn length, and the self-imposed ceiling.
   *  The chill-at-50%HA playstyle as a personality draw: buys height,
   *  cruises the hangtime, survives by being unsplashable. */
  airLove: number;
  /** The spec this roll was drawn from - hunt/brain reads the resolved
   *  mods for reaction delay, jitter and cadence. */
  readonly spec: BotSkillSpec;
  readonly mods: BotTierMods;
  /** Private stream — form drift consumes it, not the shared botRand. */
  rng: () => number;
}

/** mulberry32 — tiny deterministic stream for skill rolls. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6D_2B_79_F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function rollSkill(spawn: BotVec, spec: BotSkillSpec = 'medium'): BotSkill {
  const seed = Math.imul(Math.trunc(spawn.x), 73_856_093) ^ Math.imul(Math.trunc(spawn.z), 19_349_663) ^ Math.imul(Math.trunc(spawn.y), 83_492_791);
  const rng = prng(seed || 1);
  const mods = skillMods(spec);
  const axis = (): AxisPair => {
    const base = (0.55 + rng() * 0.9) * mods.aim;
    const spread = 0.3;
    return {
      moving: clamp(base + (rng() - 0.5) * spread),
      still: clamp(base + (rng() - 0.5) * spread),
    };
  };
  const axes = { snap: axis(), track: axis(), arcLead: axis(), arcJudge: axis() };
  const movement = clamp((0.7 + rng() * 0.8) * mods.move);
  return {
    axes: { snap: Object.assign({}, axes.snap), track: Object.assign({}, axes.track), arcLead: Object.assign({}, axes.arcLead), arcJudge: Object.assign({}, axes.arcJudge) },
    baseAxes: axes,
    baseMove: movement,
    baseMods: mods,
    resolve: 0,
    prevMenaceHp: -1,
    odHold: 0,
    movement,
    form: 1,
    beltPull: rng() < 0.45,
    courage: rng(),
    thrift: rng(),
    // Air-loving skews upper-half: the altitude-seeking style is what
    // good players do, so the lobby draws from the better tail of it.
    airLove: 0.5 + rng() * 0.5,
    spec,
    mods: Object.assign({}, mods),
    rng,
  };
}

/** HERO MODE - config toggle. With it on, a losing side's resolve rises
 *  toward the impossible tier: performance-seeded (the bots already
 *  doing well escalate first) plus a slow random walk so any nobody can
 *  spike. All escalation is legal - it only moves the skill dials a
 *  roll could have drawn. */
export const HERO_ON = true;
const IMPOSSIBLE = BOT_TIERS.impossible;

/** Per-think resolve update. pressure = host-computed inputs:
 *  deficit 0..1 (how badly the bot's side is losing),
 *  ownPerf 0..1 (this bot's personal form vs the lobby - the hero seed),
 *  menace 0..1 (a dominant enemy exists - their pull on this bot). */
export function heroTick(s: BotSkill, pressure: { deficit: number; ownPerf: number; menace: number; menaceHp?: number }, dt: number): void {
  // Resolve target: team deficit is the floor pressure, personal form
  // amplifies it (surprising hero = the seed who's already rolling),
  // a menace adds its own pull, and a slow random walk keeps spikes
  // organic. Weighted so a nobody only spikes on luck, never on deficit.
  // Menace pull is STRONG and barely perf-weighted: a 30/1 player must
  // lift the whole lobby past the overdrive gate, not just the seeds.
  const p = pressure.deficit * (0.4 + 0.6 * pressure.ownPerf)
    + pressure.menace * (0.65 + 0.25 * pressure.ownPerf)
    + (s.rng() - 0.5) * 0.04; // ±0.02/tick organic drift
  const target = Math.max(0, Math.min(1, p));
  // Rise fast under pressure (~4s to full), cool slowly (~20s) - a
  // comeback shouldn't instantly deflate the moment the score evens.
  const rate = target > s.resolve ? 0.25 : 0.05;
  s.resolve = Math.max(0, Math.min(1, s.resolve + (target - s.resolve) * Math.min(1, rate * dt)));
  // RESULTS-based overdrive: a menace the lobby isn't hurting isn't
  // pressure, it's a problem - resolve keeps climbing past 1 on the
  // same legal dials, multiplicative (the rise accelerates). Any damage
  // the menace takes snaps the bot back to the honest tier: the ramp
  // answers survival, not skill.
  s.odHold = Math.max(0, s.odHold - dt);
  if (pressure.menaceHp !== undefined) {
    // A real WOUND snaps him back: chip damage (a plink off a 100k
    // pool, grazing fire) is not "dealing with the threat" - the menace
    // sits at ~full bar taking non-lethal hits and still has to ramp.
    if (s.prevMenaceHp >= 0 && pressure.menaceHp < s.prevMenaceHp * 0.85) {
      s.resolve = Math.min(s.resolve, 1); // bled him - back to legal
      s.odHold = 5;                        // damage buys 5s of honest tier
      s.prevMenaceHp = pressure.menaceHp;  // re-anchor at the wound
    } else {
      if (s.resolve > 0.7 && s.odHold <= 0) {
        // No ceiling: resolve compounds until the menace takes a real
        // wound or dies. Rise to whatever level meets the threat.
        s.resolve *= 1 + 0.12 * dt; // ~12%/s compounding, uncapped
      }
      // Anchor = PEAK hp: a slow chip bleed must drop 15% off his best
      // to count as a wound, not 15% since last think (heals lift it).
      s.prevMenaceHp = Math.max(s.prevMenaceHp, pressure.menaceHp);
    }
  }
  // Apply: every dial a roll could have drawn, lerped toward impossible.
  const r = s.resolve;
  const lerp = (a: number, b: number): number => a + (b - a) * r;
  s.mods.aim = lerp(s.baseMods.aim, IMPOSSIBLE.aim);
  s.mods.move = lerp(s.baseMods.move, IMPOSSIBLE.move);
  s.mods.react = Math.max(0.05, lerp(s.baseMods.react, IMPOSSIBLE.react));
  s.mods.jitter = Math.max(0.05, lerp(s.baseMods.jitter, IMPOSSIBLE.jitter));
  s.mods.temper = lerp(s.baseMods.temper, IMPOSSIBLE.temper);
  // Axis/movement targets scale with the roll, not an absolute - a
  // hard-spec axis drawn at 1.8 lerping toward 1.45 would be resolve
  // as a NERF. impossible/own-tier ratio keeps direction correct for
  // every spec.
  const aimK = IMPOSSIBLE.aim / s.baseMods.aim;
  const moveK = IMPOSSIBLE.move / s.baseMods.move;
  s.movement = lerp(s.baseMove, s.baseMove * moveK);
  for (const ax of ['snap', 'track', 'arcLead', 'arcJudge'] as const) {
    s.axes[ax].moving = lerp(s.baseAxes[ax].moving, s.baseAxes[ax].moving * aimK);
    s.axes[ax].still = lerp(s.baseAxes[ax].still, s.baseAxes[ax].still * aimK);
  }
}

/** Weapon → the axis its shots actually exercise. Reads the `aimAxis`
 *  marker on the stat row; thrown/no-skill types return null = 1x. */
export function weaponAxis(w: number): AimAxis | null {
  return WEAPONS[w]?.aimAxis ?? null;
}

/** Effective multiplier for one shot: blends the axis' moving/still
 *  pair by how fast the target is actually going (a stand-still flag
 *  stand under mortar fire is pure `still`), then applies form. */
export function aimSkillFor(s: BotSkill, weapon: number, targetSpeed: number): number {
  const ax = weaponAxis(weapon);
  if (!ax) {return 1;}
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
