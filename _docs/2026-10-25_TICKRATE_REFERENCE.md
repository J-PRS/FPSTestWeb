# Tickrate reference — measured server rates + where KRIBES sits

Written 2026-10-25. Sources: Respawn's official "What Makes Apex Tick"
dev post (ea.com), Battle(non)sense's Apex netcode video (2019), PC
Gamer coverage of that analysis, APNIC gameplay-flow measurements.

## Measured rates (not marketing claims)

| Game | Tickrate | Notes |
|---|---|---|
| CS:GO official MM | 64 Hz | 2⁶ — power-of-two lineage, pairs with 128 community tier |
| CS:S / TF2 | ~66 Hz | Source engine default |
| Battlefield 5 | 60 Hz | DICE bumped after community pressure |
| Fortnite | ~30 Hz | Comparable-scale BR |
| **Apex Legends** | **20 Hz** | Confirmed by Respawn's own dev blog AND independently measured |
| Overwatch | ~63 Hz | |
| **KRIBES** | **60 Hz sim / 20 Hz broadcast** | sim steps `MoveSim.STEP = 1/60`; tick broadcast is a separate cadence |

## Why 64 and not 60

- 64 = 2⁶. Tick period `1/64 = 15.625ms` is exactly representable in
  binary floating point; interpolation windows, lag-comp rewind slots,
  and timing quantization divide cleanly with bit shifts.
- It pairs with 128 = 2×64 — one code path, one multiplier across the
  casual/competitive tiers.
- 60Hz matches monitor refresh, which buys nothing: tickrate is not
  vsync-locked — clients render at arbitrary fps and interpolate between
  snapshots regardless.

## The Battle(non)sense story

Chris Batt (Battle(non)sense) is the YouTuber who turned "the netcode
feels bad" from forum cope into measurable evidence. Starting ~2016 he
ran instrumented analysis — high-framerate capture + actual packet
measurement — on Overwatch, Battlefield, Fortnite, PUBG, CS.

His 2019 Apex video measured the 20Hz sim AND caught the real symptom:
the send-rate graph spiked wildly, which looked like unstable updates
until he showed the per-tick snapshot was too big for one packet — it
was being split across several. That explained Apex's ~1.1 Mbit/s
downstream (6× Fortnite) and why Wi-Fi/packet-loss players suffered
most.

The pressure his series built is why Respawn's deep-dive exists — an
official admission of 20Hz plus their defense (snapshot fidelity for
global abilities vs. marginal gains most players can't feel). Same arc
with CS2's subtick messaging, which he also dissected.

## Where 20Hz leaves you

Apex's model = sim AND snapshot both at 20Hz. KRIBES is better on
paper: 60Hz sim underneath with the 20Hz only governing broadcast
cadence; events (hits, kills, spawns) fly as edges immediately rather
than waiting on the tick. Rewind/lag-comp handles hit freshness the
same way CS does.

The real cost of a low broadcast rate is remote-player motion
granularity — a 50ms snapshot gap is where interp error lives. If
remotes feel rubbery at LAN ping, 30Hz halves the gap at ~1.5× egress.
For Tribes-speed gameplay (dodging shells, not sub-peek duels) 20 is
defensible; CS's 64/128 is the outlier tuned for esports peeker's
advantage.

## Why Apex burns 6× Fortnite's bandwidth

Not the tick rate — Apex is *slower* (20Hz vs ~30) and still ~6× fatter.
It's per-tick payload size, i.e. the replication MODEL:

- **Apex = snapshot-replication.** Every tick serializes the full
  relevant world state — positions plus ability/passive/ultimate events,
  drops, drone sightings — readable globally. Deliberate: Respawn's
  deep-dive calls it fidelity for gameplay features paid in bytes.
  Snapshots get so large they split across packets (the "fluctuating
  send rate" in the measurement).
- **Fortnite = relevancy-based replication** (Unreal actor replication).
  Per-entity relevancy/dormancy — a far-away static sends nothing, and
  updates delta-compress against what the client already has. The tick
  ships only changes that matter to THIS client.

KRIBES sits on the Fortnite side of the line: non-player objects are
edge-driven (spawn/gone events + committed state, replayed
deterministically at both ends), not per-tick world dumps — the
"cheap is a feature" doctrine. Apex pays 6× to guarantee you never miss
a far-away event; relevancy + edges deliver the same information at a
fraction of the cost.

## If we ever bump it

- Egress is the binding constraint (see
  `_docs/2026-10-24_CCU_RESOURCE_BREAKDOWN.md` — 415 Mbps at 1k CCU
  baseline). Tick rate multiplies it linearly.
- APNIC measured Apex "30–40 packets/sec" — that's packet flow, not
  sim rate (snapshot splitting inflates the count). Don't confuse the
  two when citing.
