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
- `tribesxt/` — Altimor's TribesXT netXT plugin (netcode-improvement DLL for
  Tribes 1, github.com/AltimorTASDK/TribesXT). Server-side rewind done at
  *client-declared* shot time: the client stamps each firing move with its
  synced-clock time minus the interp offset (timeNudge) at subtick precision;
  the server rewinds every other player to interpolated snapshots at that
  instant during the projectile's spawn eval, then restores. Other constants:
  ghostTimeout=250ms extrapolation cap, maxLagCompensation=250ms rewind
  ceiling, clientClockCorrection=8ms drift tolerance.
