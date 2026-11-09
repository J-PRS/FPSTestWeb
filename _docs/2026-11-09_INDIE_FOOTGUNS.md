# Indie Footguns — Features That Feel Compelled But Only Make It Worse

Date: 2026-11-09. Sources: GameDeveloper postmortems (Wayline "Kill Your
Darlings", Pixonic feature graveyard, "When Design Iteration Goes Wrong"),
GameDev.net scope essays, Bugnet/GameDeveloper options-menu checklists,
PC Gamer's motion-blur teardown, CanIPlayThat accessibility guidance.

The shared shape: each item *feels like quality* when you add it — and
the cost lands somewhere you weren't measuring (integration surface,
readability, support, motivation).

## The classic traps

**1. More mechanics instead of better interactions.**
The dominant failure mode in the postmortems: systems that spawn four
sub-features, UI rework, and balance debt while touching nothing the
player notices. Wayline's crafting system was the canonical one — weeks
of work, players actively avoided it. The heuristic that survived
contact: *game complexity should arise from interactions, not
mechanics.* If a feature doesn't multiply with an existing one, it's
probably a cost center.

**2. Post-processing "cinematic" defaults.**
Motion blur is the most-disabled setting in games — players rip it out
at first launch because it destroys the very information they're trying
to perceive (tracking enemies while turning). Same family: depth of
field, heavy chromatic aberration, screen shake without a toggle. The
default IS the game for most players — if the dev-taste default is one
most players disable, it was never art direction, it was noise.
(Notable: our vignette is static/subtle, not camera-coupled — that's
the safe version of the family.)

**3. Options bloat as a substitute for decisions.**
Every toggle is a QA surface, a settings-menu page, and an admission
that a default couldn't be chosen. Bugnet's floor: presets first
(Low/Med/High), individual overrides second — never a wall of
peer-level toggles with no preset story. Also every option you *don't*
offer is a support question you don't get.

**4. Onboarding/tutorial machinery.**
Walls-of-text tutorials are the feature everyone adds and players
skip. Consensus fix: teach in context or not at all — and anything you
build must be skippable without penalty. (We already have this decision
on record: no onboarding, ever — Krunker-parity zero friction.)

**5. Saving the feature because you built it.**
Sunk-cost retention is the meta-footgun behind most others: the
mechanic stays because removing it admits the work was wasted. The
documented counter-pattern is a "graveyard" review — periodically list
every feature and ask whether a fresh build would include it.

**6. Fixing the wrong layer.**
The iteration trap: playtesters unhappy → tune the mechanic → still
unhappy → the real problem was *comprehension* (nobody could tell the
cannon was on cooldown). Rule: if players don't understand what's
happening, it's a communication bug — feedback/UI fixes it for cheap.
If they understand it and still hate it, the mechanic dies. Tune only
after those two are separated.

**7. Features that fight the core engine.**
A mechanic that slows or gates the thing the game IS (traffic jam in a
game about driving freely; building placement uncertainty in a game
about precision) can never be polished into working. For us that reads
as: anything that nerfs speed/momentum in a skiing game fails the
first-principles test before it's evaluated on anything else.

**8. Fake-AI/progression padding.**
Progression systems, unlock trees, daily-reward loops added because
"retention needs systems." Browser-FPS reality: Krunker/Narrow One
retention is friction-zero rejoin, not bars filling. A progression
layer is also the classic sub-feature bomb (UI + economy + persistence
+ balance) for a genre that doesn't need it.

## Where we stand (honest self-check)

Already avoiding:
- No onboarding system — locked on record
- Minimal-default settings with collapsible sections (not a wall)
- Post-fx are emitter-gated + shed at deep tier, not always-on garnish
- Cheap-fx additions constrained to the fused pass — the "one more
  EffectPass" version of the trap is ruled out by architecture

Watch-items we're flirting with:
- **Settings depth creep** — our menu is genuinely good and that's the
  temptation: every new toggle feels earned. The preset story (a
  Low/Med/High that moves several knobs at once) is the guardrail.
- **HUD readout creep** — reticle column + vitals + feed + hints is
  already the dense end of the genre; each new readout needs the
  10-second-miss test, not just a free slot in the region stack.
- **Dev-surface leaks** — debug panels and dev toggles are properly
  gated now; keep the border hard or the player surface accretes
  maintenance UI.
- **Feature-scope on bots/content** — the temptation shape here is
  "one more system bots should use" after parity is already real. The
  soak-attribution infrastructure exists precisely to adjudicate these
  instead of vibes.

## The one-line version

Most indie footguns are **additions that can't multiply with the core
loop** — they add weight, not leverage. The cheap-check before
anything ships: does it interact with what's already fun, is the
default the right default, and would a fresh build include it?
