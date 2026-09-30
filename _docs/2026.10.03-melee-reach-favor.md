# Melee reach audit — "favor the player" pass

2026-10-03

## The rule

Enemy attack reach should land at *slightly less* than what the model
appears to reach. A hit that connects at the edge of the creature's
apparent silhouette reads as unfair ("I dodged that"); a whiff at the same
spot reads as a skillful escape. The dodge-feel lives in that gap. This
is standard practice — player hitboxes get generous interpretation,
enemy reach gets strict interpretation.

The catch: the ratio only means anything if the trigger distance is
actually tied to model size. A flat shrink on a hand-tuned constant still
produces whatever reach the constant happened to be. So the audit below
compares every trigger to *true visual contact*: `creature radius +
PLAYER_RADIUS (0.8)` center-distance.

## What was wrong

Contact triggers were constants in `config.ts`, eyeballed to roughly
`radius + player + margin`. The margin — 0.2 to 0.7m depending on
species — was the cheat-feel. The reach *audit* in `speciesKit.bite()`
(`radius + gap`) existed to catch phantom hits, not to tune feel, so it
never flagged these.

## What changed

One shared constant, applied at every contact trigger:

```ts
export const MELEE_FAVOR = 0.85;
```

Visuals, windup telegraphs, aggro/dart ranges, and the reach audit are
unchanged — only the moment damage lands moved inward.

## The audit: trigger vs true contact

`touch ≈ creature radius + 0.8` (player capsule). "New" = old × 0.85
(crawler pounce gaps scaled directly).

| Creature | radius | touch ≈ r+0.8 | old trigger | new trigger | result |
|---|---|---|---|---|---|
| Scarab nibble | 0.55 | 1.35 | 1.40 | **1.19** | requires visible overlap now |
| Grub bite | 0.70 | 1.50 | 1.50 | **1.28** | requires visible overlap now |
| Gnat nip (uber ×2.2 also) | 0.30 | 1.10 | 1.30 | **1.11** | nip = actual contact |
| Seeker sting | 0.60 | 1.40 | 1.80 | **1.53** | lance keeps ~0.15 margin |
| Rakk claw | 1.10 | 1.90 | 2.20 | **1.87** | flyby ≈ contact |
| Snake bite | 0.50 | 1.30 | 2.40 | **2.04** | still >body — lunging head strike, legitimate reach |
| Roller contact | 1.60 | 2.40 | 2.60 | **2.25** | run-over, not graze |
| Crawler pounce | 0.90 | 1.70 | 2.50 / 2.0 | **2.13 / 1.70** | mid-air lunge keeps ~0.4 grace |
| Strifer bolt | 0.90 | — | wake check | **×0.85** | only contact-damaging creature projectile |

Every trigger now lands inside the silhouette (scarab/grub/gnat) or at
the edge of a real lunge (snake, crawler, seeker, rakk). The constants
had drifted toward honesty; the favor factor removes the remaining
grace margin — which is where "that clearly missed me" lived.

## Deliberately untouched

- **Initiation triggers** — `SNAKE_STRIKE_DIST`, `CRAWLER_POUNCE_DIST`,
  aggro/orbit/dart ranges. Shrinking those delays the telegraph, not the
  hit; it would just make attacks less frequent, not more dodgeable.
- **Proximity fuses** — `BANELING_FUSE_DIST`, Mine trigger. The damage
  window is the blast radius with falloff, not a strike reach.
- **The reach audit itself** — `speciesKit.bite()` keeps `radius + gap`;
  it warns on genuinely impossible hits and shouldn't shrink.

## Knobs and regression risks

- If anything feels *harmless* now (watch gnat — 1.11m is exact model
  contact), the single knob is `MELEE_FAVOR`; 0.9 restores dart-type
  attackers without touching melee reads.
- Turret bolts (`Turretter`) were left alone — friendly deployable,
  different trust contract.
- Strifer bolt got the favor because it's the only creature projectile
  that damages on contact rather than blast falloff — same "dodge a
  bolt" feel applies.

## Possible follow-up

The audit args in `speciesKit.bite()` are hand-set `gap` numbers per
call site. Deriving the warn threshold from `radius + PLAYER_RADIUS`
instead would make "trigger exceeds true visual reach" a logged bug —
structurally preventing this whole class of drift.
