# Premium tickrate — "subscribers upgrade the room"

Written 2026-10-25. Concept exploration: monetize broadcast rate, not
cosmetics. Sources for figures: `_docs/2026-10-24_CCU_RESOURCE_BREAKDOWN.md`
(egress baseline), `_docs/2026-10-25_TICKRATE_REFERENCE.md` (measured
game rates + CS2 subtick), Respawn's Apex dev post, Valve's Source
networking doc.

## The idea

A monthly sub (~$10) buys real send-rate: rooms the subscriber funds run
64Hz (or 128Hz) broadcast instead of the stock 20Hz. Not cosmetics, not
p2w stats — measurably crisper remote motion for everyone in that room.

## What it actually is technically

- Our sim already runs **60Hz** (`MoveSim.STEP = 1/60`). The 20Hz is
  only the *broadcast cadence* — a fanout knob, not a physics knob.
- So "premium tickrate" = **send-rate upgrade on a 60Hz sim** — per-room
  fanout at 64/128Hz shrinks the interp gap from 50ms to ~15.6/7.8ms.
- True 128Hz *sim* is off the table: `MoveSim.STEP` is deterministic and
  everything (traction, energy, projectile fuses) is tuned to it.
- We already ship the honest half of CS2's "subtick": shot claims carry
  `fireAt`, the server back-dates shells by measured uplink (`lagS`),
  hits resolve on rewind ghosts. Premium send rate is the *other* half —
  and unlike CS2's marketing, ours would be a real rate bump.

### Precedents

- **Source engine (2004):** `cl_updaterate` — per-client negotiated
  snapshot rate, independent of server tick. Per-recipient rate is a
  proven, boring knob.
- **CS2 subtick (2023):** 64Hz sim + timestamped action ordering, sold
  as premium-feel resolution. Same "rate + timestamps" shape.
- **Apex:** 20Hz *everything* — we already beat their headline.

## Model evolution (why we landed on room-sponsorship)

1. **Per-player lane** — sub's own sends at 64/128. Rejected: p2w
   asymmetry — you're buying a crisper view of enemies than they get of
   you.
2. **Presence boost** — any room containing a sub runs fast. Rejected:
   AFK-mule exploit (park the whale's client, lobby farms the boost),
   plus "who deserves it" ambiguity.
3. **Room sponsorship (chosen)** — sub flags ONE room premium for the
   sub's duration. Bounded cost, no exploit surface, "PRO" badge on the
   server row sells itself.
4. **Own room (variant)** — sub's $10 = their own named room (map/mode/
   bots/public-or-private) at 64Hz — i.e. classic server rental
   (BF/MC/Rust proved it). Friends playing there while the sub sleeps is
   retention, not abuse.

**Recommended shape:** $10/mo = one boosted room — yours (private admin)
or a community one you sponsor. The perks compound: named room + 64Hz +
admin = a coherent product, not a stat.

## Cost math (Hetzner)

Baseline: ~0.4 Mbps/player at 20Hz → ~13Mbps, ~4TB/mo for a 16v16 room.

| Tier | Rate | Egress/room | Traffic/mo | Marginal cost |
|---|---|---|---|---|
| Stock | 20Hz | ~13 Mbps | ~4TB | — |
| Premium | 64Hz | ~42 Mbps | ~13TB | ~€0–13 (cap headroom or overage) |
| Premium+ | 128Hz | ~85 Mbps | ~27TB | ~€0–27 |

Hetzner CX cloud: 20TB included, €1.19/TB overage; dedicated 1Gbps
unmetered ~€34-40 flat. Per-sub worst case ~€25/mo at 128 → at $10 a
sponsored room needs ~2.5 subs of occupancy value to break even — fine,
because the perk is communal (one funded room serves a whole lobby).

**Real binding constraint isn't money, it's CPU** — 6.4× snapshot
serialization/delta-encode per premium room. Profile before selling;
bandwidth is the cheap part.

## Risks

- **"20Hz = peasant tier"** — the biggest design risk. If premium rooms
  feel visibly better, stock rooms read as broken. Mitigate by keeping
  stock at 20Hz + edges (which is genuinely good — Apex tier) and
  framing premium as enthusiast-tier, not fix-tier.
- **Uplink reality** — premium room benefits only materialize for
  players whose own connection handles 128Hz of snapshots; Wi-Fi players
  may not feel it. Fine — it's a feature for those who can use it.
- **CPU serialization** — see above; the real scaling wall.
- **Chargeback/lifetime abuse** — standard sub mechanics; room flag
  lapses with the sub.

## Implementation sketch (small)

- `PlayerState.premium` / account flag (payments TBD — Stripe sub).
- `Room.premiumUntil` — sponsor action sets it; tick fanout reads it:
  `SEND_HZ = room.premium ? 64 : 20`.
- Server-list row carries `premium` → the "PRO" chip in `lb-room` meta.
- Sponsor action = one server API call (`POST /rooms/:name/boost`).
- No sim, wire-schema, or deterministic-math changes needed — the
  broadcast cadence is already a per-room number.

## Open questions

- 64 as the premium tier only? (128 doubles cost for fidelity most
  players can't feel — Kinsi's blind test suggests 64 is the sellable
  number.)
- Does a free player's *own* send cap rise in a premium room? (Their
  input claims stay 60Hz either way — the benefit is inbound fidelity.)
- Stripe vs. platform payments; EU VAT handling; whether "boost a room"
  is transferable monthly.
