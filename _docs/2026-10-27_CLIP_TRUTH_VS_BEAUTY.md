# Client vs server clip capture — truth vs beauty

> Reference for the "Cool Shots / best shots" question: are client-recorded
> clips always prettier than server-derived ones? Yes — and it's worth
> knowing *why*, because the two recordings capture different things.

## The two truths (again)

`_docs/2026-10-22_REPLAY_DEMO_SYSTEMS.md` already covers the two-truth
problem for *demos*; this is the same axis applied to **video clips**:

| | Client clip | Server-side record |
|---|---|---|
| Captures | What was rendered — interpolated positions, camera sway/recoil, viewmodel, particles, tracers, ribbon trails, tuned lighting | Authoritative sim state at tick rate — coarse, unadorned |
| Looks | Smoothest possible — interpolation exists precisely to make sparse sim state look good | Mechanical — tick-stepped unless you build a replay renderer with its own interpolation |
| Truth | The player's *beliefs* — prediction guesses, corrections, rubber-bands baked in as if they happened | What actually happened — but missing everything client-side (camera feel, cosmetics, sub-tick aim) |

So a client clip is a film of the player's beliefs, not of the match.

## Prior art (from research, 2026-10-27)

- **CS:GO demos** are the canonical split: a client-side (POV) demo records
  the client's state and "accurately rerenders one player's perspective";
  a server-side (GOTV) demo records server state and reproduces any POV
  only *less* accurately — so much client-only info is missing that an
  entire tooling ecosystem (HLAE `mirv_pov`) exists to emulate client
  state from server demos.
- **Overwatch killcams** show server truth and routinely "contradict" the
  player's memory — community reports of killcam-vs-gameplay mismatches
  are the prediction gap made visible. Replays are reconstructions, and
  can differ slightly between viewings.
- **CoD killcam** = record everything server-side for N seconds, play back
  to the client — truth-first, cheap, ugly.
- **Production standard = hybrid**: input stream + periodic authoritative
  snapshots as the canonical record, re-rendered at playback. Gives truth
  + beauty + seeking + any-POV, at the cost of a replay renderer.

## Consequences for Cool Shots

- **Client capture is the right default for highlights** — prettier *is*
  the product, and nobody wants an authoritative stutter reel.
- Known artifact class to accept: a visible correction snap, or a hit that
  "wasn't" on the server. Community reads these as normal; flag it only if
  clips get used for disputes.
- If dispute/anti-cheat review ever matters: client pixels are inadmissible
  by construction — that path wants server-authoritative recording
  (edges + snapshots → headless re-render). The offline demo→MP4 renderer
  design in `_docs/2026-10-23_OFFLINE_DESKTOP_RENDERER.md` is that
  re-render half, mostly built.
- The architecture already makes hybrid feasible: deterministic `shared/`
  sims + event-edge wire = the exact inputs a canonical record needs.
  Cheap version if ever wanted: record client input + server snapshots
  alongside the clip, keep the pixels for sharing.
