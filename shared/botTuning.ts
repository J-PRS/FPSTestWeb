/**
 * BOT_TUNING — every bot-movement/route constant as one mutable table.
 * Defaults are exactly the tuned values; _tools/sweeps perturbs them per
 * genome to hunt cap-time/speed/energy optima (random sweep now, CMA-ES
 * later). Server-only reads — never crosses the wire.
 */
export const BOT_TUNING = {
  // botMoves — jet/ski/jump intent
  moves: {
    jetHoldBase: 0.7,    // s — minimum committed burn on arm (sweep: longer holds beat feather-tapping)
    jetHoldRand: 0.3,    // s — extra randomized burn window
    breathArm: 12,       // energy below which a dry climber perches
    breathHold: 38,      // energy needed to step off the perch
    breathRise: 3,       // m rise ahead that qualifies as "on the face"
    tankedMin: 8,        // energy reserve jets won't dip below (sweep: holding a large reserve strangles transit)
    tapEnergyMin: 4,     // runner airborne-tap floor (featherjet on flats)
    runwayBase: 45,      // m — dive-runway base before arrival
    runwayDropK: 2,      // runway growth per m of altitude to shed
    runwaySpeedK: 0.5,   // runway growth per m/s of approach speed
    flatRunDrop: 6,      // m — below this drop a runner keeps burning
    diveArriveMargin: 4, // m — target must sit this far below to dive
    diveAglMin: 8,       // m AGL — below this over flat ground there is no dive to give
    parkRingFast: 12,    // m — brake ring cap at speed
    parkRingSlow: 2,     // m — brake ring cap when slow
    parkSpeedSplit: 6,   // m/s — fast/slow ring switch
    skiVetoRise: 3,      // m — steep-climb grade that releases ski
    skiVetoSpeed: 8,     // m/s — below this on a steep grade, don't ski
    ceilingAgl: 18,      // m AGL — held burn above this is ballooning (sweep winner: early brake saves tank for transitions)
    comfyEnergy: 24,     // energy floor for discretionary burns
    boostSpeedMax: 12,   // m/s — anti-sheep boost only when slower
    boostGdMin: 15,      // m — boost only with ground to cover
    boostEnergyMin: 34,  // energy — boost spends only above this (climb reserve)
    boostRise: 1.5,      // m — boost only on flat/downhill ahead
    runInGdMin: 12,      // m — runner run-in burn inner window
    runInGdMax: 70,      // m — runner run-in burn outer window (sweep: past ~70m the hop chain owns the approach)
    strikeGd: 140,       // m — strike-dive window: inside this a runner drops the comfy gate and
                         // burns to the tap floor — 8v8 soaks showed cappers crossing the defended
                         // 70-150m band at 15-25m/s on dry tanks and dying before the ring
    strikeBankGd: 200,   // m — bank leg just outside the strike window: discretionary flat-burns
                         // (boost/tap) veto so regen refills the dive; climb/hop still fire
    strikeTapMin: 2,     // energy — tap floor inside the strike window (commit everything)
    runInRise: 4,        // m — run-in only when objective near-level
    runInSpeed: 40,      // m/s — run-in stops boosting past this (grab passes read ~34m/s peak = half a real capper's 55-80m/s entry)
    hopRiseLo: 0.5,      // m — jet-assist hop rise lower bound
    hopRiseHi: 3,        // m — jet-assist hop rise upper bound
    climbRise: 4,        // m rise ahead that counts as a climb (sweep: small rises ski through, jetting them is the waste)
    stepRise: 0.4,       // m — sub-climb face ahead that walls a stalled push (dais lip ~0.85m, skirt 2.2m)
    stepJetRise: 1.2,    // m — rise past jump apex that pays a tap alongside the hop
    jumpUphillSpeed: 3,  // m/s — uphill hop when slower than this
    hopSpeed: 6,         // m/s — momentum hop only above this
    hopGdFar: 60,        // m — far goal hop gate
    hopRiseFar: 3,       // m — far hops skip steep rises
    runnerHopGd: 28,     // m — hop chains die at the orbit-watch ring: a hop landing on the 9m deck sails over the pole at 10-15m/s; inside this ring the runner touches down and the brake/crawl own the approach
    blockSelfD: 30,      // m — bodyblock hop read radius on post
    blockOd: 80,         // m — bodyblock enemy window
    blockClosing: 8,     // m/s — closing speed that counts as a flyer
    blockEta: 1.2,       // s — time-to-arrive budget for the pop
    preyRise: 6,         // m — prey this far overhead earns a burn
    destHighRise: 3,     // m — destination rise that arms 'destHigh'
    destHighNear: 60,    // m — objective only counts in the climb deficit inside this ring
    grabOrbitGd: 14,     // m — runner orbit-brake ring around the objective (covers the ~2.2m touch + overshoot lap)
    grabWatchGd: 30,     // m — the wider orbit-detection ring: a lazy lap swinging 15-25m out never arms the 14m brake
    grabOrbitS: 1.0,     // s — closure-rate window inside the ring
    grabOrbitMinGain: 3, // m/window — closure slower than this = orbit lap, brake it
    crawlHopGd: 5,       // m — inside this of the objective a crawler walks (hops overshoot the 9m deck)
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
    runnerDirectGd: 48,  // m — runner close-out: pockets near the stand only feed the
                         // orbit, so the last leg aims at the pole itself
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
    apexW: 0.8,          // apex bonus weight — high-arc lines are how a bowl rim (katabatic) gets crested; zeroing it stranded the kata route
    climbTaxRise: 4,     // m — landings above this get taxed
    climbTaxW: 1.8,      // climb tax weight
    earlyClimbW: 26,     // first-stretch climb penalty weight
    longCommitBonus: 3,  // tiebreak for committing long
    progressW: 0.9,      // goal-progress weight
    eScoreW: 0.2,        // banked-energy weight (runners)
  },
  // botGraph — leg-scale flow-field routing (flood per goal, shared)
  graph: {
    extent: 1500,        // m — grid span (heightfield world scale)
    cell: 15,            // m — grid resolution
    minGd: 140,          // m — legs shorter than this stay on the local fan
    ahead: 80,           // m — waypoint lookahead along the flow
    climbTax: 0.09,      // cost k per meter of rise — a 30m climb ~3x flat
    diveCredit: 0.04,    // cost k per meter of drop — downhill is cheap (sustained falls only)
    dipTax: 0.06,        // cost k per meter of non-sustained drop — a lone dip is a trap, not a discount
    wallSlope: 0.9,      // rise/run steeper than this needs jets to cross
    wallTax: 10,         // extra cost k per slope past wallSlope — a wall a
                         // bot can't climb should lose to a traverse it
                         // can walk, but not to a map-length detour it
                         // could jet over
    fieldCache: 8,       // live goal floods kept at once
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
