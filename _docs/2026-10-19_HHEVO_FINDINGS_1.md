# hhEvo Findings #1 — Kills Are Net-Negative in Headhunt

*Experiment: skill-tier ladder with identical kits (`--pairs` mode,
seeded, side-swapped, 5 sim-min × 4 matches per pairing, 6v6 flat
arena). Tooling: `_tools/sweeps/hhEvo.ts` (`--pairs`, grab ledger,
behavior descriptors).*

---

## The result

Same kit (`Shotgun+Disc+Mortar/Grenade/regenerator`), only the five
skill axes vary:

| Pairing | margin | winner's K/D | notes |
|---|---|---|---|
| hhhhh vs eeeee | **+7** (2/4) | ~2:1 | hard bots barely edge easy |
| hhhhh vs mmmmm | **−5** (2/4) | ~1:1 | hard ≈ medium, coin flip |
| mmmmm vs eeeee | **−4** and **−50** (seeds 1/7) | ~0.5 | **easy team sweeps medium** |

Read that third row again. The *easy* bots — who lose nearly every
duel (K/D ~0.4) — beat the medium bots **four matches out of four** on
seed 7, by a combined −50 margin. Execution tier barely moves the
score, and below-medium execution may actively help.

## The mechanism — it's in the mode rules, not the bots

`roomScore.ts` headhunt rules:

- **Score = live held tokens.** Nothing is banked; the scoreboard IS
  the sum of what everyone's carrying right now.
- **Death scatters ALL held +1 bounty at the corpse spot** —
  `decomposeTokens(corpse.heldTokens + 1)` spawns the pile where the
  victim died.
- **Anybody can grab the scatter** — including the victim's teammates.

Now add the token-economy ledger (positive `heldTokens` deltas = grabs):

| match | score | grabs | verdict |
|---|---|---|---|
| h 12–23 e | 32/72 | grabs win |
| h 31–18 e | 117/30 | grabs win |
| m 20–23 e | 43/96 | grabs win |
| m 10–25 e | 24/59 | grabs win |
| m 27–9 e | 78/14 | grabs win |

**Grabs predict the winner; K/D predicts the loser.**

The recycling loop this creates: a weak team dies *at home* → its hoard
scatters *at home* → respawning teammates walk over the pile → the
positive delta counts as a grab → the hoard reconsolidates. The strong
team kills them over and over and every kill just **redeposits the
tokens deeper in the victim's territory**. Kills literally feed the
enemy economy — exactly what the evolution research doc predicted as
the mode's theoretical tension, except the sims show it's not a
tension: it's a full inversion.

The gen-0 champion (`ihmhh` plasma, K/D 3.45, margin −147) and the
regen champion (`immhh`, margin +227) both fit the pattern: the plasma
build killed everything in enemy territory and donated every pile it
made; the regenerator build won by *not dying* — a hoard that never
scatters is a hoard that never leaves your hands.

## What this means

**For evolution:** the objective-margin fitness is validated —
kill-fitness would have crowned the −147 plasma team. The grab ledger
belongs on the tournament board too (it's already in `--pairs` output;
wiring it into the gen board is trivial).

**For the mode design — this may be an actual defect, not a curiosity:**
if real humans play headhunt, the optimal strategy is *don't fight
away from home*. The kills-feed-enemy loop makes TDM instincts
actively harmful. Two candidate fixes, in order of invasiveness:

1. **Bank tokens** (carry to your base/stand → permanent score) —
   kills then only matter in transit; the classic headhunt rule.
   Bigger change, removes the live-swing drama the mode was built for.
2. **Corpse scatter despawn/exclusion** — scatter tokens decay in N
   seconds, or can't be regrabbed by the victim's own team for M
   seconds. Cheap, keeps live scoring, breaks the recycling loop.

Option 2 is one line of pickup-spawn logic and a scenario test; worth
simulating before deciding — hhEvo can A/B the rule change directly
(fork `onKill` scatter, rerun the ladder, see if K/D starts
correlating again).

**For bot behavior:** the bots discovered "stay home and hoard"
without being told — the `life` descriptor on champions (98–115s
median lifespan vs ~52s on the plasma build) shows selection already
rewards it. If the mode rule changes, the evolved meta should shift
with it — that's the harness paying for itself.

## Follow-up: katabatic weakens but doesn't kill the inversion

Same mmmmm-vs-eeeee pairing on `--map katabatic` (real terrain,
real spawn layout):

| match | score | grabs |
|---|---|---|
| 29–22 | 49/96 — *winner grabbed less* |
| 10–47 | 136/50 — grabs win |
| 25–25 | 68/81 |
| 28–14 | 62/76 — *winner grabbed less* |

Margin **−16** (2/4 split) vs **−50** on flat. Terrain changes the
picture in two ways:

- The inversion survives — the medium team still won the K/D war ~2:1
  and still went net-negative on score.
- But a second win path appears: matches where the winner grabbed
  *fewer* tokens. On real terrain, winning the fight AT the scatter
  (then holding position over the pile) converts kills into score —
  "scatter control" is a skill execution can actually buy. On flat the
  recycling loop dominated; on katabatic it's contested.

So: the mode defect is real but terrain-sensitive. Bots on real maps
need *both* skills — the duel execution AND the field-positioning to
convert corpses into grabs — which is arguably a richer objective
landscape than either extreme.

## The fix works — regrab-lock A/B

`FPS_HH_REGRAB_LOCK_S=10`: the victim's own team cannot collect its
corpse scatter for 10 sim-seconds (`RoomPickups.spawn` gains
`lockTeam`/`lockUntil`; scatter spawns tag the victim's team). Same
pairing, same seed, same everything:

| | lock OFF | lock 10s |
|---|---|---|
| margin | **−50** (0/4) | **+8** (3/4) |
| K/D correlates with winner | 1/4 matches | **3/4** matches |
| total grabs/match | ~56 | **~23** |

The lock flips the matchup: medium execution now beats easy the way a
deathmatch instinct says it should. And the grab-collapse is the
shocking number — **~60% of all token grabs were corpse-scatter
recycles.** The "economy" the weak teams were winning was mostly their
own hoard bouncing back home off their corpses.

Verdict: the recycling loop is a real mode defect and the 10s own-team
lock is a surgical fix — one field on the pickup record, env-gated,
defaults off. Whether 10s ships as the production rule is a feel call
(try 5–15s), but the mechanism is proven.

## Caveats
- 2–4 matches per pairing — margins under ~15 are noise; the −50
  medium-vs-easy result is NOT noise.
- `life` on easy teams is short (they die constantly), consistent with
  the die-at-home-recycle story, not the stay-alive story — two
  different hoard strategies that both beat fighting.

## Next experiments queued

- [x] Same ladder on `--map katabatic` — inversion weakens (−50→−16),
      a "scatter control" win path opens, doesn't close
- [x] A/B the regrab lock — `FPS_HH_REGRAB_LOCK_S=10` flips the
      pairing (−50→+8), K/D re-correlates 1/4→3/4, grabs collapse ~60%
      (most of the "economy" was recycled corpses)
- [ ] Grab-rate onto the gen board + as a QD descriptor axis
- [ ] Duel probe: does `move` axis matter at all on flat (all teams
      converged mob≈17 — the axis may be dead weight in this arena)?
- [ ] Evo run on katabatic — does the map shift which genome wins?
      (flat champion was a hoard/regen build; terrain may crown a
      scatter-control build instead)
