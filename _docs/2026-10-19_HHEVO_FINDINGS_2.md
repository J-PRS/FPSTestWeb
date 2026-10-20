# hhEvo Findings #2 — Lock Dose-Response + the Katabatic Meta Divergence

*Two experiments: (a) `FPS_HH_REGRAB_LOCK_S` swept 0→20s on the
defect-exposing pairing; (b) a full 4-gen evolution on `--map
katabatic` vs the flat-arena run. Same harness, same pop/gens.*

---

## A. The regrab lock: dose-response

Pairing: `mmmmm` vs `eeeee`, Shotgun+Disc+Mortar/regenerator both
sides, flat, seed 7, 4 matches each point.

| lock | margin | wins |
|---|---|---|
| 0s | −50 | 0/4 |
| 5s | +5 | 3/4 |
| 10s | −3 | 2/4 |
| 15s | +18 | 3/4 |
| 20s | **+21** | **4/4** |

- **Any lock ≥5s breaks the loop** — the recycling needs *immediate*
  regrab (respawners walk the pile within seconds of the death); a 5s
  delay is already long enough for the fight to move on.
- 10s lands inside noise (−3 here vs +8 on the previous seed batch) —
  dose-response at this sample size can't separate 5–15s. If a rule
  ships, it wants a feel test, not a sim number — **5s is the
  mechanism-proven floor; ~15s is the "safe pick" dose.**
- 20s is probably overkill for live play: that's half a respawn walk
  where the pile glows unclaimable in the victim's base.

## B. The katabatic meta is a different game

4 gens, pop 6, 5min×2 — same params as the flat run that crowned
`immhh` Shotgun+Disc+Mortar/regenerator (margin 227, nash 99%).

Gen-3 board:

| margin | worst | kd | genome | style |
|---|---|---|---|---|
| 203 | −39 | 1.13 | immih Chaingun+Disc+Mortar/**Grenade**/none | agg5.8 life100s |
| 167 | −62 | 1.09 | mhmmm Disc/Mortar/**Javelin/overcharge** | agg5.6 |
| 105 | −28 | 1.15 | miemh Javelin/overcharge | agg5.8 |
| 93 | **−1** | 1.06 | mhmem Javelin/overcharge | life114s |
| −19 | −45 | 0.76 | mhmme Javelin/overcharge | |
| −52 | −39 | 1.02 | hiemh Javelin/overcharge | |

nash: **mhmem 51% / mhmmm 40% / miemh 8%** — the equilibrium lives on
the Javelin/overcharge cluster, *not* the margin leader.

### What terrain changed

1. **Mobility economy is the katabatic axis.** 5/6 of the final pool
   converged on `Javelin + overcharge` (belt energy + jet
   regen) — on flat that build was a mid-table curiosity; on terrain
   it's the meta. `air` doubled flat→katabatic (2%→10%) — the map
   exists, the bots use it.
2. **The Nash blend vs flat's monoculture.** Flat converged to one
   dominant hoard build (nash 99%). Katabatic stays a mixed
   equilibrium — the Grenade margin leader and the Javelin pack split
   the equilibrium ~50/50. That's exactly the PSRO prediction: richer
   landscapes keep counter-play alive, degenerate arenas collapse it.
   *The `nash:` line earned its keep — margin alone would've crowned
   the wrong genome.*
3. **Snipers die young everywhere.** Railgun went −264/worst −97,
   life 53s — terrain doesn't save the stand-off build; headhunt's
   scatter economy punishes it (you kill from range, you can't collect
   the pile).
4. **Exploiters fired productively** — gen-1's `mhemm Javelin` (+56 vs
   champ) seeded the Javelin lineage that took over the pool by gen-3.
   The exploiter slot isn't decoration; it found the meta early.

### Cross-map conclusion

There is no single "best bot" — the map is part of the genome's
fitness. For the production roster this means either (a) evolve
per-map genomes, or (b) require pool admission to survive a *map
matrix* (train flat, validate katabatic, score worst-case). Option
(b) is the same worst-pairing logic we already track — one more
column.

## Next experiments queued

- [ ] Map-matrix pool admission: each pairing runs on flat AND
      katabatic, margin = worst-of-two (kills map-specialist genomes)
- [ ] Lock-time feel decision: 5s floor vs 15s safe — needs a human
      playtest, sims can't pick a feel
- [ ] Duel probe: `move` axis on flat still looks dead (mob 17
      everywhere); on katabatic mob 19 — the axis converged instead of
      discriminating. Either the tier deltas are too small or movement
      quality doesn't show up in `mob` — check whether `air`/`life`
      are the real mobility proxies
- [ ] QD grid pass on descriptors — now that descriptors vary
      across maps, the behavior cells have something to hold
