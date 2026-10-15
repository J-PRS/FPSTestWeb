# Decisions — agent memory

Append-only log of "chose X over Y because Z" — calls that aren't obvious
from the code and would get re-litigated without a record. One line each.
If a decision is reversed, strike it and add the new one — don't edit
history in place.

- 2026-10-11 — sky has NO sun disc by design (uniform brightness = no free positional tells); glare sprite stays in code behind `?shafts=on`, off by default
- 2026-10-11 — Mie g=0 + rayleighDirectional=0: directional scatter flattened on purpose; residual asymmetry from optical-depth integration is accepted
- 2026-10-11 — oxlint --fix yes, oxfmt NO: codebase is deliberately compact ({return;} one-liners); a prettier-style formatter is a style rewrite, not a cleanup
- 2026-10-11 — check.sh is the done-gate; pre-commit stays fast (lint+size floor+sentinels), full suites stay out of hooks so nobody reaches for --no-verify
- 2026-10-11 — kill/death counts NOT cleared in remotePlayers onRemove (fires on corpse→respawn swaps; zeroing wiped K/D) — test pins persistence
- 2026-10-11 — x|0 kept with scoped oxlint-disable in hash/hot code; Math.trunc elsewhere
- 2026-10-13 — deep dives get ref docs IMMEDIATELY (user rule): research like nav/orbits, filters, netcode goes into _docs/<date>-<topic>.md before moving on — searchable knowledge, not chat scrollback
- 2026-10-13 — bot orbiting is a model bug, not tuning: runner+routed legs ride the flood carrot (pure pursuit); point-seek latches are escape-only. See _docs/2026-10-13_BOT_NAV_ORBITS.md
- 2026-10-13 — never hard-delete files, even scratch/debug: soft-delete or move to the appropriate folder (_tools/debug/ for probes)
- runner flood cost profile (cheaper climb/wall for runners): sampled 4 configs, response is discontinuous (kata 133↔413s across 0.005 climbTax) — corridor choice flips between basins, no stable optimum; REVERTED, kata wander lives in the staging layer not the flood
- 2026-10-15 - capper arrival speed is terrain/energy-bound, NOT a speed cap: mid-route the capper already reads 40-61 m/s (approachProbe), so the lever is PRESERVING it. Raising moves.runInSpeed 36->52 alone measured WORSE (grabV 19.1->16.1) because the tank was empty at the stand.
- 2026-10-15 - the bank leg is the arrival-speed lever. botMoves.veto now drops EVERY discretionary burn in it (hop/destHigh included, not just boost/tap) and strikeBankGd 200->320: measured 5 seeds x 3 maps, grabV 19.1->22.4, grabT 52.4->44.3, carries improved too. Hop was refilling at the same ~8/s the hop chain spent.
- 2026-10-15 - capper aim is now a LATCH, not a per-think test: the pole <-> 40m-past-the-flag flip on the spd>14/dStand>20 gates was a limit cycle in the last 40m. Commit on the way in, release when speed dies (passCommit in botRouting).
