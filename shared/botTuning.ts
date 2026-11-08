/**
 * BOT_TUNING — every bot-movement/route constant as one mutable table.
 * Defaults are exactly the tuned values; _tools/sweeps perturbs them per
 * genome to hunt cap-time/speed/energy optima (random sweep now, CMA-ES
 * later). Server-only reads — never crosses the wire.
 */
export const BOT_TUNING = {
  // botMoves — jet/ski/jump intent
  moves: {
    jetHoldBase: 1.6,   // s — minimum committed burn on arm (multi-map lap evolution: longer holds beat feather-tapping)
    jetHoldRand: 0.8,   // s — extra randomized burn window
    breathArm: 12,       // energy below which a dry climber perches
    breathHold: 38,      // energy needed to step off the perch
    breathRise: 3,       // m rise ahead that qualifies as "on the face"
    tankedMin: 2.4,      // energy reserve jets won't dip below (evolution: holding a large reserve strangles transit)
    tapEnergyMin: 24,    // runner airborne-tap floor (featherjet on flats — evolution raised it: taps below ~24 energy cost more climb than they save)
    runwayBase: 35,      // m — dive-runway base before arrival (evolved: shorter runways, later commit)
    runwayDropK: 2,      // runway growth per m of altitude to shed
    runwaySpeedK: 0.5,   // runway growth per m/s of approach speed
    flatRunDrop: 6,      // m — below this drop a runner keeps burning
    diveArriveMargin: 4, // m — target must sit this far below to dive
    diveAglMin: 8,       // m AGL — below this over flat ground there is no dive to give
    parkRingFast: 12,    // m — brake ring cap at speed
    parkRingSlow: 2,     // m — brake ring cap when slow
    parkSpeedSplit: 6,   // m/s — fast/slow ring switch
    skiVetoRise: 2.7,    // m — steep-climb grade that releases ski
    skiVetoSpeed: 10,    // m/s — below this on a steep grade, don't ski (energy sweep: 7→10 flips capper from slow grabV=10.2 to fast grabV=17.6; cliff is exactly 10)
    ceilingAgl: 35,      // m AGL — held burn above this is ballooning, unless fast: a runner at bankSpeed+ trades zero forward thrust for pure altitude (jets can't push past jetMaxFwdAccel=50 anyway — the TAS bank is the climb)
    bankSpeed: 45,       // m/s — fast enough that jetting up spends nothing horizontal; altitude banks for the next descent
    bankOdMin: 150,      // m — banking needs runway to convert back to speed; inside this the burn is run-in instead
    comfyEnergy: 35,     // energy floor for discretionary burns
    boostSpeedMax: 12,   // m/s — anti-sheep boost only when slower
    cruiseSpeed: 45,     // m/s — grounded cruise burn cap for runners/wave (jets can't push
                         // past jetMaxFwdAccel=50 anyway; grounded-only so it can't balloon)
    boostGdMin: 15,      // m — boost only with ground to cover
    boostEnergyMin: 34,  // energy — boost spends only above this (climb reserve)
    boostRise: 1.5,      // m — boost only on flat/downhill ahead
    // transitGd REVERTED: feather-taps for any long-leg body dropped
    // kills ~30% and cost seed-1 its grab — transit burns arrive dry at
    // the wall that needs the tank. Walkers walking is honest; the
    // sheep-max cases were wall-pocket stalls (cover channel), not
    // speed.
    runInGdMin: 12,      // m — runner run-in burn inner window
    runInGdMax: 70,      // m — runner run-in burn outer window (sweep: past ~70m the hop chain owns the approach)
    strikeGd: 140,       // m — strike-dive window: inside this a runner drops the comfy gate and
                         // burns to the tap floor — 8v8 soaks showed cappers crossing the defended
                         // 70-150m band at 15-25m/s on dry tanks and dying before the ring
    strikeBankGd: 320,   // m — bank leg just outside the strike window: EVERY discretionary burn
                         // (boost/tap/hop/destHigh) vetoes so regen refills the dive; only a real
                         // climb or a live prey chase is exempt. Measured: 5 seeds × 3 maps, grabV
                         // 19.1→22.4, grabT 52.4→44.3, carries improved too. The old 200 window that
                         // let hop/destHigh fire refilled at the same ~8/s the hop chain spent, so
                         // the strike leg opened at E≈2-13 and the run-in died on the mountE floor.
    strikeTapMin: 2,     // energy — tap floor inside the strike window (commit everything)
    runInRise: 4,        // m — run-in only when objective near-level
    runInSpeed: 52,      // m/s — run-in stops boosting past this; jet forward accel dies at 50 anyway (jetMaxFwdAccel), so the cap only cheapens the burn off the last meters
    tailTapSpeed: 80,    // m/s — descent tap caps here for runners. Past jetMaxFwdAccel the up-share still stretches the arc for the NEXT descent — that's how 80-100 runs chain; plateau reasoning was about forward accel only
    tailTapSkill: 1.1,   // skill.movement floor — JP's trick is timing: skilled bots ride the hop descent, low-skill ones pay the flat burn
    pursuitR: 90,        // m — REVERTED carrier-shield experiment's ring, kept for reference
    shieldReserve: 36,   // energy — REVERTED: pressured carriers banking for SHIELD slowed them into the kill (med hold 8.1->5.0s, caps flat)
    hopRiseLo: 0.5,      // m — jet-assist hop rise lower bound
    hopRiseHi: 4,        // m — jet-assist hop rise upper bound; the 3-4m band
                         // is the face-plant dead zone (too tall for jump apex
                         // ~0.87, below climbRise): dunes bleed autopsy showed
                         // -200..-1100E into +2..3m lips the hop couldn't see
    climbRise: 4,        // m rise ahead that counts as a climb (sweep: small rises ski through, jetting them is the waste)
    sustainedProbe: 18,  // m — REVERTED sustained-climb experiment, kept for reference
    sustainedGrade: 0.3, // rise/m — REVERTED: deep-probe climbs lost E to the face
    sustainedSpeed: 12,  // m/s — REVERTED: paired with sustainedGrade
    stepRise: 0.4,       // m — sub-climb face ahead that walls a stalled push (dais lip ~0.85m, skirt 2.2m)
    stepJetRise: 0.7,    // m — lips this tall need a jet tap: jump apex is ~0.87 (7^2/2g) so anything past ~0.7 hops back down the face
    mountE: 15,          // E — the mount-wait refill target: a dais lip tap costs ~0.5-1s of burn, so parking until tankedMin (2.4) released the shove on a 0.16s sliver — the sputter floor it was meant to fix
    jumpUphillSpeed: 3,  // m/s — uphill hop when slower than this
    hopSpeed: 6.4,       // m/s — momentum hop only above this
    hopGdFar: 60,        // m — far goal hop gate
    hopRiseFar: 4,       // m — far hops skip steep rises; 3-4m faces are the
                         // bleed band — hop+jets over the lip beats the plant
    hopDescRise: 0.12,   // rise/m — a descent past this stays glued:
                         // grounded contact is what pumps gravity into speed
    runnerHopGd: 28,     // m — hop chains die at the orbit-watch ring: a hop landing on the 9m deck sails over the pole at 10-15m/s; inside this ring the runner touches down and the brake/crawl own the approach
    blockSelfD: 30,      // m — bodyblock hop read radius on post
    blockOd: 80,         // m — bodyblock enemy window
    blockClosing: 8,     // m/s — closing speed that counts as a flyer
    blockEta: 1.2,       // s — time-to-arrive budget for the pop
    preyRise: 6,         // m — prey this far overhead earns a burn
    destHighRise: 3,     // m — destination rise that arms 'destHigh'
    destHighNear: 60,    // m — objective only counts in the climb deficit inside this ring
    grabOrbitGd: 14,     // m — runner orbit-brake ring around the objective (covers the ~2.2m touch + overshoot lap)
    reconPeriod: 10,     // s - mean gap between discretionary altitude buys (jittered ×0.6-1.4)
    reconBurn: 4.5,      // s - committed burn per recon climb (chaos
                         // _chaos3: 5s burns top ridges the 2.8s ones
                         // can't - altitude is what the glide spends)
    reconAglMax: 18,     // m AGL - skip the burn when already high
    reconMinE: 16,       // energy - client tanks live at 2-21E (jetprobe:
                         // 100% of samples <35), so comfyEnergy would
                         // gate the climb off entirely; ~16E buys the
                         // ~1.2s burn that actually clears 5m AGL
    glideTime: 3,        // s - enforced no-discretionary-jet window after
                         // a committed burn ends (chaos soak _chaos3:
                         // pulse-burn/glide beat scattered taps - the
                         // descent converts altitude to speed for free)
    climbTapMinE: 22,    // energy - the small-rise tap had NO floor and
                         // spent every regen trickle to the 2.4E sputter
                         // floor (jetprobe: enAvg 4-9 across the roster),
                         // which is also why recon climbs never had fuel
    grabWatchGd: 30,     // m — the wider orbit-detection ring: a lazy lap swinging 15-25m out never arms the 14m brake
    grabOrbitS: 1,     // s — closure-rate window inside the ring
    grabOrbitMinGain: 3, // m/window — closure slower than this = orbit lap, brake it
    crawlHopGd: 5,       // m — inside this of the objective a crawler walks (hops overshoot the 9m deck)
  },
  // botLines — meso-scale line picking
  lines: {
    rays: 7,             // candidate directions in the fan
    cone: 1.4,           // rad — fan half-angle
    pts: 4,              // probes per ray
    reach: 65,           // m — farthest landing probe (multi-map evolution: mid-horizon beats both tight 25m and lazy 80m)
    near: 15,            // m — nearest landing probe
    commitS: 2,        // s — hold a line before re-planning (evolved: re-plan a bit sooner so corners stay fresh)
    arrive: 6,           // m — waypoint reached radius
    minGd: 34,           // m — closer than this, steerer owns it
    runnerDirectGd: 48,  // m — runner close-out: pockets near the stand only feed the
                         // orbit, so the last leg aims at the pole itself
    redest: 22,          // m — goal drift forcing a re-roll
    staleLimit: 3,       // dead rolls before the give-up path
    runnerStale: 10,     // thinks of zero net gd progress before a runner abandons
                         // its flood hop to the fan/orbit machinery — corridor legs
                         // legitimately run lateral for seconds, so the walker limit
                         // would fire mid-detour; the kata trap sat flat ~128s
    faceProbeMin: 40,    // m — legs shorter than this skip the early face probe
    faceRise: 0.8,       // rise/m — goal-line slope that counts as a face,
                         // engaging traverse before E bleeds into it
    faceCrest: 20,       // m — REVERTED hill-vs-wall crest read: climbing ~20m hills blindly lost caps to the faces it couldn't pay
    runnerReachK: 2.2,   // runner reach multiplier
    farReachGd: 300,     // m — legs longer than this get far eyes
    farReachK: 0.45,     // far-eye reach as a share of remaining leg
    runnerConeK: 2.6,    // runner fan widening (evolved: wider route fan — corners are won by line, not by straightness)
    runnerDropW: 2,    // downhill pull for runners
    dropW: 1.4,          // downhill pull for everyone else
    runnerStraightW: 3.2,// straightness tax for runners (evolved: momentum through the turn beats the straight line)
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
    earlyClimbW: 11,     // first-stretch climb penalty weight (evolved: bank altitude early — the climb pays off down the lap)
    longCommitBonus: 3,  // tiebreak for committing long
    progressW: 0.85,     // goal-progress weight
    eScoreW: 0.2,        // banked-energy weight (runners)
  },
  // flagGoals hofGoal + serverSenses posted leash — the heavy-on-flag's
  // anchor law. Swept by hofSweep: what actually stops a capper.
  hof: {
    // Evolved defaults (hofSweep: 60+ evals, 2 maps, holdout check on a 3rd):
    // staying planted beat every lean amount — leanK≈0 won; tight home leash
    // + a real carried roam beat the old 3/20 pair.
    threatR: 60,     // m — an enemy this close to home arms the interpose lean
    dropR: 28,       // m — a dropped flag inside this ring is worth leaving the post
    leanK: 0.03,     // lean growth per m of threat distance
    leanMax: 2,      // m — hard cap on the interpose (evolution slid ≤2m)
    postHome: 2,     // m — posted leash while the flag is home (duty-scaled)
    postCarried: 25, // m — leash once our flag is gone: roam the counter-attack
  },
  // botGraph — leg-scale flow-field routing (flood per goal, shared)
  graph: {
    extent: 1500,        // m — grid span (heightfield world scale)
    cell: 15,            // m — grid resolution
    minGd: 140,          // m — legs shorter than this stay on the local fan
    ahead: 34,           // m — waypoint lookahead along the flow. The corridor
                         // bends every 2-3 cells; an 80m hop aimed across the
                         // bowl and the bot beelined straight into walls it
                         // couldn't pay (hs=1.5 circuit: basin-locked 300s).
                         // Bend-detection alternative REVERTED — shortened wps
                         // on kata's apron re-armed the orbit latch every
                         // ~15m and doubled the grab time.
    aheadSpeedFree: 15,  // m/s — below this the route lookahead stays corridor-scale
    aheadSpeedK: 1.2,    // m of lookahead per m/s above the free band (40m/s → ~64m)
    climbTax: 0.09,      // cost k per meter of rise — a 30m climb ~3x flat
    diveCredit: 0.04,    // cost k per meter of drop — downhill is cheap (sustained falls only)
                         // 0.08 REVERTED (2nd time): even chain-guarded, strong dive
                         // credit lures the route into dead basins — kata 0 caps.
    dipTax: 0.06,        // cost k per meter of non-sustained drop — a lone dip is a trap, not a discount
    wallSlope: 0.9,      // rise/run steeper than this needs jets to cross
    wallTax: 10,         // extra cost k per slope past wallSlope — a wall a
                         // bot can't climb should lose to a traverse it
                         // can walk, but not to a map-length detour it
                         // could jet over
    solidTax: 30,        // extra cost k when a leg crosses a structure at
                         // body height — ~300m of free walking per wall,
                         // so routes thread gate lanes and door gaps;
                         // still priced (not forbidden) so a sealed
                         // pocket yields SOME route for the climb layer
    fieldCache: 24,      // live goal floods kept at once (~80KB each; goal
                         // bucketing means squads converge on few buckets,
                         // but wander rolls still scatter the space)
    dangerTax: 0.5,      // cost-m per influence-unit per cell — the walk deflects
                         // around cells where this bot's team keeps dying; a hot
                         // kill zone (~5-10 scent) prices like a ~40-75m detour
  },
  // botBrain — think cadence + disposition rolls
  brain: {
    thinkS: 0.3,       // s — think tick period (0.5 broke beast-awareness and replay determinism)
    fearHp: 0.15,      // healthFrac that breaks contact
    heroChance: 0.3,   // per hurt episode, hero-mode roll
    heroS: 6,          // s — hero window length
    heroThinkK: 0.45,  // think-period multiplier while heroing
    wanderBase: 0.7,   // wanderlust roll base
    wanderRand: 0.6,   // wanderlust roll spread
    wanderLegMin: 50,  // m - leg floor (was 25: short legs let every roll terminate in the next hollow - the bowl-lock)
    wanderLegSpan: 110,// m - leg roll on top of the floor
    wanderDownP: 0.3,  // share of rolls still preferring downhill (ski flavor)
    wanderClimbP: 0.45,// share preferring climbs (jet/HA fuel); the rest take max |elevation change|
    dutyBase: 0.5,     // duty roll base (1.1 broke replay determinism — cadence shift desyncs same-seed rooms)
    dutyRand: 0.9,     // duty roll spread
  },
  // botSteer — context steering slots
  steer: {
    slots: 16,           // directions sampled around the circle
    probeA: 4,           // m — near slope probe (floor of the speed-scaled reach)
    probeB: 9,           // m — far probe catches ridgelines (floor)
    probeNearK: 0.5,     // s — near probe reach = speed*this (reaction distance)
    probeFarK: 0.8,      // s — far probe reach = speed*this
    probeAMax: 40,       // m — cap on speed-scaled near reach
    probeBMax: 70,       // m — cap on speed-scaled far reach
    step: 9.7,           // m — steering lookahead (evolved: wider carving over twitchy flicks)
    sepRange: 7,         // m — personal space
    memMs: 4000,         // ms — memory trail lifetime
    memRange: 12,        // m — memory trail radius
    turnRate: 2.4,       // rad/s — heading turn cap (evolved: smooth wide arcs — the cap is not the bottleneck when routes are planned wide)
    slopeThresh: 0.82,   // rise/run that starts scoring as dangerous (evolved: don't dodge gentle rises — the climb is part of the route)
    slopeW: 2,           // slope danger weight
    mountRise: 4,        // m — a bounded rise within hop+jet reach is a step, not a slope (matches pickFightPos' standable band)
    mountCrest: 1,       // m — far probe may only keep rising this much past the lip for the face to count as a step
    sheerDrop: -12,      // m — probe drop that reads as a sheer
    sheerDanger: 0.5,    // danger a sheer adds
    landW: 0.2,          // airborne-falling attraction to the grazing-landing slot
  },
};

export type BotTuning = typeof BOT_TUNING;
