# hhEvo Findings #3 — Map-Matrix Fitness: No Free Specialists

*Experiment: `--maps flat,katabatic` — every pairing plays MATCHES
games on EACH map, and the pairing's fitness margin is the WORST map's
total. Implemented per findings-2's "map is part of the genome"
conclusion. 4 gens, pop 6, 5min×2×2maps per pairing, seed 3.*

---

## The mechanism works — specialists got caught immediately

The `map margins` lines tell the story. Pairing after pairing shows
the same genome winning one arena and losing the other:

```
immih Sprinkler vs immih GrenadeLauncher:  flat:-21 katabatic:+66 → worst -21
ihhih GL      vs immih GL:                 flat:-12 katabatic:+45 → worst -12
mhmmm Javelin vs mhemm Javelin:            flat:+15 katabatic:-35 → worst -35
```

Under single-map fitness, each of those was a coin-flip pairing —
whoever ran on the favorable map looked strong. Under worst-map
fitness, **only a margin that survives both arenas counts**.

## What the matrix crowned

Neither single-map champion held up:

- Flat champion (Shotgun/regen hoard build): not in the final pool —
  its strategy was an artifact of the home-recycle loop the flat arena
  amplifies
- Katabatic favorite (Javelin/overcharge): 3 of 6 pool slots, but the
  **margin leader is `imeii` GrenadeLauncher** — the cross-map pick —
  and the **Nash equilibrium lands on `mheem` Javelin/overcharge 54%**
  with two GrenadeLauncher builds splitting the rest (24/21%)

So the matrix meta is a **blend of mobility economy + mid-range
control**: GrenadeLauncher supplies the scatter-control fights that
terrain opened up (findings-1's "second win path"), Javelin/overcharge
supplies the mobility to reach piles first. One genome does each job;
the roster needs both.

## The meta is more honest now — and less settled

- Gen-3 margins are tight (+106 to −62 across 6 genomes vs flat's
  +227 to −147) — worst-map scoring squeezes out fake strength; what's
  left is genuinely contested
- Nash stayed a blend (54/24/21) across gens, never collapsing to a
  monoculture — consistent with PSRO: removing the degenerate arena's
  dominant strategy leaves real counter-play
- `air 6%` splits the difference of flat 2% / kat 10% as expected —
  descriptor means now average over two different games

## Implications for the evo pipeline

1. **`--maps` should be the default admission rule.** Any champion
   crowned on one map is suspect until it survives a second arena.
   Cost is linear in maps — budget by halving MATCHES per map.
2. **Descriptor interpretation needs per-map splits** — current Desc
   means mix flat+katabatic samples into one number. A `desc` keyed
   per map would show "this genome is a skier on kat, a brawler on
   flat" — which is exactly the QD grid's input.
3. **The roster answer is confirmed, again.** Three straight
   experiments (nash blend on kat, nash blend on matrix, margin-vs-nash
   disagreements) keep saying: ship a *pool*, not a champion.

## Next experiments queued

- [ ] Per-map descriptor splits on the board (skier-on-kat vs
      brawler-on-flat genome profiles)
- [ ] Third map into the matrix (coastline? dunes?) — does the meta
      move again, and does a 3-map worst-case further compress margins?
- [ ] Cross-validation gate: take the matrix pool, replay it on a
      HELD-OUT map — true generalization test (hofSweep already does
      train/holdout for HoF; same idea here)
