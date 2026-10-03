/**
 * BOT_TUNING — every bot-movement/route constant as one mutable table.
 * Defaults are exactly the tuned values; _tools/sweeps perturbs them per
 * genome to hunt cap-time/speed/energy optima (random sweep now, CMA-ES
 * later). Server-only reads — never crosses the wire.
 */
export const BOT_TUNING = {
  // botMoves — jet/ski/jump intent
  moves: {
    jetHoldBase: 0.45,   // s — minimum committed burn on arm
    jetHoldRand: 0.4,    // s — extra randomized burn window
    breathArm: 12,       // energy below which a dry climber perches
    breathHold: 38,      // energy needed to step off the perch
    breathRise: 3,       // m rise ahead that qualifies as "on the face"
    tankedMin: 15,       // energy reserve jets won't dip below
    runwayBase: 45,      // m — dive-runway base before arrival
    runwayDropK: 2,      // runway growth per m of altitude to shed
    runwaySpeedK: 0.5,   // runway growth per m/s of approach speed
    flatRunDrop: 6,      // m — below this drop a runner keeps burning
    diveArriveMargin: 4, // m — target must sit this far below to dive
    parkRingFast: 12,    // m — brake ring cap at speed
    parkRingSlow: 2,     // m — brake ring cap when slow
    parkSpeedSplit: 6,   // m/s — fast/slow ring switch
    skiVetoRise: 3,      // m — steep-climb grade that releases ski
    skiVetoSpeed: 8,     // m/s — below this on a steep grade, don't ski
    ceilingAgl: 30,      // m AGL — held burn above this is ballooning
    comfyEnergy: 30,     // energy floor for discretionary burns
    boostSpeedMax: 12,   // m/s — anti-sheep boost only when slower
    boostGdMin: 15,      // m — boost only with ground to cover
    boostRise: 1.5,      // m — boost only on flat/downhill ahead
    runInGdMin: 12,      // m — runner run-in burn inner window
    runInGdMax: 90,      // m — runner run-in burn outer window
    runInRise: 4,        // m — run-in only when objective near-level
    runInSpeed: 26,      // m/s — run-in stops boosting past this
    hopRiseLo: 0.5,      // m — jet-assist hop rise lower bound
    hopRiseHi: 3,        // m — jet-assist hop rise upper bound
    climbRise: 2,        // m rise ahead that counts as a climb
    jumpUphillSpeed: 3,  // m/s — uphill hop when slower than this
    hopSpeed: 6,         // m/s — momentum hop only above this
    hopGdFar: 60,        // m — far goal hop gate
    hopRiseFar: 3,       // m — far hops skip steep rises
    runnerHopGd: 12,     // m — runner keeps hopping inside this
    blockSelfD: 30,      // m — bodyblock hop read radius on post
    blockOd: 80,         // m — bodyblock enemy window
    blockClosing: 8,     // m/s — closing speed that counts as a flyer
    blockEta: 1.2,       // s — time-to-arrive budget for the pop
    preyRise: 6,         // m — prey this far overhead earns a burn
    destHighRise: 3,     // m — destination rise that arms 'destHigh'
    destHighNear: 60,    // m — objective only counts in the climb deficit inside this ring
  },
  // botLines — meso-scale line picking
  lines: {
    rays: 7,             // candidate directions in the fan
    cone: 1.4,           // rad — fan half-angle
    pts: 4,              // probes per ray
    reach: 58,           // m — farthest landing probe
    near: 15,            // m — nearest landing probe
    commitS: 2.4,        // s — hold a line before re-planning
    arrive: 6,           // m — waypoint reached radius
    minGd: 34,           // m — closer than this, steerer owns it
    redest: 22,          // m — goal drift forcing a re-roll
    staleLimit: 3,       // dead rolls before the give-up path
    runnerReachK: 2.2,   // runner reach multiplier
    farReachGd: 300,     // m — legs longer than this get far eyes
    farReachK: 0.45,     // far-eye reach as a share of remaining leg
    runnerConeK: 2.0,    // runner fan widening
    runnerDropW: 2.0,    // downhill pull for runners
    dropW: 1.4,          // downhill pull for everyone else
    runnerStraightW: 4,  // straightness tax for runners
    straightW: 8,        // straightness tax for everyone else
    sheerVeto: -16,      // m — don't route off a drop sharper than this
    gainedFloor: 0.4,    // fraction of own travel a run must close
    eScoreEscape: 12,    // E-score budget that exempts the floor
    apexGd: 220,         // m — last-leg apex setup radius
    diveAgl: 25,         // m AGL — runner this high aims the descent at the objective
    diveGlideK: 4,       // objective within altitude*this → in glide range
    apexMax: 40,         // m — max banked apex altitude credited
    apexW: 0.8,          // apex bonus weight
    climbTaxRise: 4,     // m — landings above this get taxed
    climbTaxW: 1.8,      // climb tax weight
    earlyClimbW: 26,     // first-stretch climb penalty weight
    longCommitBonus: 3,  // tiebreak for committing long
    progressW: 0.9,      // goal-progress weight
    eScoreW: 0.2,        // banked-energy weight (runners)
  },
  // botBrain — think cadence + disposition rolls
  brain: {
    thinkS: 0.3,       // s — think tick period
    fearHp: 0.15,      // healthFrac that breaks contact
    heroChance: 0.3,   // per hurt episode, hero-mode roll
    heroS: 6,          // s — hero window length
    heroThinkK: 0.45,  // think-period multiplier while heroing
    wanderBase: 0.7,   // wanderlust roll base
    wanderRand: 0.6,   // wanderlust roll spread
    dutyBase: 0.5,     // duty roll base
    dutyRand: 0.9,     // duty roll spread
  },
  // botSteer — context steering slots
  steer: {
    slots: 16,           // directions sampled around the circle
    probeA: 4,           // m — near slope probe
    probeB: 9,           // m — far probe catches ridgelines
    step: 8,             // m — steering lookahead
    sepRange: 7,         // m — personal space
    memMs: 4000,         // ms — memory trail lifetime
    memRange: 12,        // m — memory trail radius
    turnRate: 4.0,       // rad/s — heading turn cap
    slopeThresh: 0.45,   // rise/run that starts scoring as dangerous
    slopeW: 2,           // slope danger weight
    sheerDrop: -12,      // m — probe drop that reads as a sheer
    sheerDanger: 0.5,    // danger a sheer adds
  },
};

export type BotTuning = typeof BOT_TUNING;
