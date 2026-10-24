# Duel-mode design notes — headhunt duel + "Retribution" (fuse)

Brainstorm from 2026-10-24 — two 1v1 mode sketches and the degenerate
incentive analysis behind each. Nothing implemented yet.

## 1v1 Headhunt — analysis of the existing mode at duel roster

Headhunt rule here: score = tokens *held* (no banking — hold-is-the-score
is the schtick, deliberately not classic cap-and-bank). Kills scatter the
victim's whole hoard + 1 bounty at the corpse; held tokens drip
hp/armor/belt buffs (hoard-drip).

Why 1v1 degenerates hilariously:

- Total token supply is +1 per kill and hoard = score, so **only the
  kill that lands the killer at goal X ever decides anything**. Kills
  1..X-1 are structurally free — they just arm a bigger piñata for the
  next flip.
- A 19-0 lead is 19 tokens on one corpse: one comeback kill flips
  literally the entire match (19-0 → ~0-20).
- Drip buffs mean the holder is tankier — comeback requires beating the
  buffed guy who just beat you.
- Regrab footrace: pile drops at the corpse; the victim respawns knowing
  where his hoard is and can scoop it back first (REGRAB_LOCK_S=0
  default means no protection).
- Feed incentive: the loser is incentivized to *die* — each death grows
  the pile he'll inherit on one flip kill. Rational sandbagging.

Scatter-rule math explored:

- **Full drop**: every kill flips ~2H. Maximum swing, maximum feed.
- **Drop half, victim keeps half**: flip margin collapses to ~1 (killer
  gets ⌈H/2⌉+1 vs kept ⌊H/2⌋) — ping-pong ladder, every kill flips by a
  sliver. BUT keeping half makes feeding *safer* — half your pile
  survives each death. Doesn't fix degeneracy, changes texture to
  permanent knife-edge.
- **Drop half, half voided (scatter tax)**: each flip burns half the
  pile — feeding literally destroys the payout being farmed. This is
  the variant that actually punishes the feed line.
- **Hold-time income / unstealable bounty**: fixes early-game
  meaninglessness (kills 1..X-1 bank something) but KILLS the degen
  fun — the last-second flip win is the point. Rejected: anything that
  makes early score stick weakens the comeback.

Resolution landed on: **it's supposed to be a prank**. 1v1 headhunt is
"arm the piñata" — the match is a build phase where the only goals are
hoard growth and drip buffs, and one fight decides everything. The
scoreboard reading 0-0 for 9 minutes is the mode's poker face, not a
flaw. Keep win = pile ≥ X at flip; optionally scatter-tax to punish
feeding. UI should show the hoard as a fuse/bomb, not a score.

## "Retribution" (working name: fuse) — the anti-headhunt duel

Inverse buffing: **every death lights a fuse on the victim** — respawned
with escalating buffs (damage dealt, AoE, regen). In a duel, stomping
literally powers up the corpse: the leader isn't winning, he's winding
the spring.

Design tension: same feed trap as headhunt — if buffs stack forever,
dying is the optimal strategy (die 5x → respawn as raid boss).

Two fixes, "burn" preferred:

- **Fuse burns out**: buffs escalate for ~10-15s then snuff. Each death
  is a comeback *window*, not a stack — the dead player comes back lit
  and must land the kill inside the fuse. Feeding grants nothing once
  the fuse expires. Narratively great: "the dead player is a bomb with
  a visible timer; kill him again or outlast the burn."
- **Fuse pops on kill**: scoring your kill detonates it — one life,
  one redemption. Kills the multi-death stack path completely but is
  less interesting than the timer.

Duel meta writes itself: kill fast + camp respawns before fuses light,
vs. die deliberately at T-30s to come back lit for the endgame.

Naming candidates: **Retribution** (user's pick — sells the narrative,
reads like a shipped mode), Backdraft (sells the mechanic — feeding air
into a starved fire), Powderkeg, Second Wind, Griefer's Gambit (the
honest one), Corpse Bomb.

## Shared insight

Both modes are the same design object viewed from opposite ends:
headhunt duel = "arm the piñata" (winner accumulates stealable power),
retribution = "arm the bomb" (loser accumulates unstealable power).
In both, the interesting knob is *what survives the flip* — and the
degen constraint is that the comeback must always remain possible.
