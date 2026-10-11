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
