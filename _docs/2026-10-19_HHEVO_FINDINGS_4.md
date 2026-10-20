# hhEvo Findings #4 — Arsenal Audit + First Full-Space Run

*Two parts: (a) an audit of how much of the arsenal the evo actually
explored — answer: ~40%, and one gene was silently dead; (b) the first
matrix run on the full gene space.*

---

## A. The audit — the evo was exploring a subset

`DIMS` was hand-listed and had drifted from the codebase's own tables:

| Slot | Old pool | Real pool (`WILDCARD_SLOTS`) | Problem |
|---|---|---|---|
| near | CG/SG/Flak/LG | SG/Flak | CG/LG are **mid-band** per the measured band table — mis-slotted |
| mid | 6 | 10 | Bombard, RocketLauncher, CG, Lightning unreachable |
| far | 6 | 5 | MRVLauncher unreachable; PlasmaCannon/RL mis-slotted |
| belt | 5 | 8 | RemoteRailgun, DiscPull, MRV unreachable |
| side | fixed Pistol | Pistol+Revolver | **not a gene at all** |
| perk | 7 | **14** | lifesteal/sharpshooter/bombardier/scavenger/lightfoot/airtank/reach/featherfall absent |

Plus a silent bug: **`'vitality'` isn't a `PerkId`** — `perkMods`
resolves unknown ids to none, so every vitality genome ran perkless and
nobody noticed. Bun doesn't typecheck `_tools`, so the literal
compiled-and-ran clean.

**Fix:** DIMS now sources `WILDCARD_SLOTS` + `PERK_ORDER` directly —
the gene space tracks the arsenal instead of a snapshot of it. Legal
kit space went ~5k → ~22k (before class-gate pruning), plus a real
`side` gene. `parseGname` accepts both old 4-weapon and new 5-weapon
gname formats.

## B. First full-space run (flat+katabatic matrix, 4 gens, seed 3)

Final pool: all six genomes share the **Shotgun-near /
Chaingun-or-GrenadeLauncher mid / Mortar far / Grenade belt / Revolver
side** shell — brawler + siege anchors built for scatter control.

| margin | genome | note |
|---|---|---|
| +92 | iheih CG+Mortar/none | **gen-2's exploiter became gen-3's leader** |
| +81 | hemmm GL+Mortar/plated | nash 22% — the live counterpick |
| +56 | imhih CG+Mortar/none | |
| +50 | hmmmm GL+Mortar/plated | |
| +24 | immhi CG+Mortar/none | |
| −18 | immih CG+Mortar/none | |

### What the expansion changed

1. **The Javelin/overcharge meta is dead under matrix fitness.** It was
   a katabatic specialist — gen-2 board shows both Javelin builds at
   margin ≤0/−70 when flat results count too. The matrix doing
   exactly its job: killing map-specialist genomes.
2. **`Revolver` spread to 5/6 genomes from nothing.** A gene that
   didn't exist yesterday immediately earned pool share — the sidearm
   genuinely matters in pile-fights (a real weapon drawn where the
   pistol whiffed).
3. **`MRVLauncher` surfaced mid-pool** (`immii`, +74 gen-2) — first
   run where that weapon was reachable.
4. **`plated` is a real meta branch** (Nash 22%), not noise — armor
   anchors buy hoard-survival; the split `plated`/`none` is the
   interesting counter axis, not a dominant answer.
5. **Exploiter→champion pipeline worked end to end:** `iheih` (+28 vs
   champ) got its seat and became next gen's margin leader. League
   structure doing what it's designed to do.

### The honest caveat

4 gens × pop 6 samples a 22k-kit space thinly — Bombard, the
bombardier/sharpshooter perks, and the utility perks
(scavenger/lightfoot/airtank/reach) haven't had selection pressure
time to surface. What converged fast (Shotgun+Mortar shell) is real;
what *hasn't* appeared yet proves nothing. The overnight run
(`--pop 8 --gens 10 --matches 2`) is the sample size that says whether
utility perks are dead genes or undiscovered niches.

## Next experiments queued

- [ ] Long run: `--pop 8 --gens 10` on the matrix — do utility perks
      (scavenger = belt economy, reach = pickup radius) find their
      niche, or are they dominated genes?
- [ ] Per-map descriptor splits — the Shotgun+Mortar shell is probably
      "brawler on flat, siege on kat" wearing one genome
- [ ] Third map into the matrix
- [ ] Holdout-map validation of the final pool (hofSweep pattern)
