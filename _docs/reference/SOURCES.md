# External netcode references

- `midair-netcode-analysis.html` / `.txt` — karan.codes, "Analysing Midair's
  netcode & lag compensation" (2025-11-08). Verdict: Midair's "custom netcode"
  was stock UE4; its lag comp was UT4's client-side Predict — a kinematic
  offset `pos + vel*OWD` plus fake projectiles. Lesson for us: extrapolated
  ghosts break down exactly where skiing is least predictable (accel); only
  server-side rewind is ping-independent. We do rewind — their mistakes are
  our confirmed anti-patterns.
- `tribes-ascend-lagcomp-readme.md` — karan283861's server-side rewind DLL for
  the TA dedicated server (GitHub). Confirms the same architecture we run:
  per-player circular position buffer, sub-tick interpolation between samples,
  rewind before collision eval, restore after. Details worth noting: ping
  bucket grouping (rewind once per unique ping per tick), 400ms compensation
  ceiling, 4ms minimum threshold, sub-tick lerp between buffer entries.
