# Replay & demo systems across shipped games — field research (2026-10-22)

Question that prompted this: *our server-side demo records authoritative
state, but players shoot at what they saw (~viewLag ms stale + interp
delay). Will a server demo look "off"?* Answer: yes — every shooter
that records server truth has this artifact, and the industry has
converged on three ways to live with it. This report surveys what
shipped games actually do, what each choice costs, and where our
architecture sits.

## The two truths, briefly

In a snapshot-interpolation client the rendered world is a splice of two
time streams (SnapNet's framing): local player predicted *ahead* of the
server, remote entities interpolated *behind* it. A server-side recording
contains a third truth — what the server believed — which matches
neither. So in a server demo, lag-compensated hits land "on air" and
shots visibly trail the target by `speed × (viewLag + ping-ish)`. At
Tribes speeds (40 m/s skiing, ~150 ms of combined view lag) that gap is
**~6 m** — not a subtle artifact. CS players named this phenomenon
"getting CSGOed."

## The taxonomy — what actually shipped

### A. Deterministic input replay — StarCraft II, Halo 3/Reach

Record initial state + RNG seed + every input event; playback re-runs
the sim. **No state is stored at all.**

- **SC2**: `.SC2Replay` = initData + game.events (only player actions —
  the AI is deterministic so it records nothing) + optional
  tracker.events for community analytics. `replayCompatibilityHash` in
  the header gates playback to the same build.
- **Halo 3 "Saved Films"**: Bungie's Max Dyckhoff confirms it's the
  Marathon model — button inputs + seed re-fed to the engine; "not just
  every enemy, but every projectile, physics object, sound played."
  This is why campaign co-op and films are the same feature: both
  require a deterministic sim. Halo's networked actions are
  host-timestamped and delayed *for the other players*, so the sim is
  honest about latency rather than predicting it.

Strengths: tiny files, perfect fidelity, free camera, frame-exact.
Costs: **requires total determinism** (shared threads, FP behavior,
init order all count — Dyckhoff: "it is easy to make things
non-deterministic") and **version lock** — every patch that changes
sim behavior silently corrupts old replays. Halo couldn't even rewind
campaign films because checkpoint streaming is one-directional.

### B. Client-stream recording — Tribes .rec, QuakeWorld QWD, Fortnite, Rocket League, PUBG, CS:GO POV demos

Record the **inbound network stream as the client received it** (+ own
input). Playback feeds the same packets through the same client code —
prediction, interpolation, packet loss artifacts and all. The replay is
not a recording of *what happened*; it's a recording of *what your
client was told*.

- **Tribes 2 `.rec`** — confirmed by community + Torque source: "a
  recording of all data sent to you from the server" + own inputs,
  played back by executing the data through the normal engine path.
  `GameConnection.playDemo()` literally constructs a fake
  ServerConnection and prepends recorded traffic. **Tribes 2 demos are
  client-view recordings** — the exact thing we were worried about
  not having. Old `.rec` files grayed out after patches (same
  version-lock problem, via protocol drift rather than determinism).
- **QuakeWorld `.qwd`** — literally timestamped network packets in both
  directions; playback re-parses them through the live message path.
- **Fortnite local replays** — UE4 `DemoNetDriver` taps the replication
  layer: "recording all of the network traffic going out to and coming
  in from the server... you see exactly what you saw when you played."
  ~10 MB/match. Bounded by the **"Replay Region"** — relevance-based
  net culling means actors outside your interest radius simply aren't
  in the file, and the replay viewer draws the region boundary to own
  that limitation. Expires every content patch.
- **Rocket League `.replay` / PUBG** — same UE net-stream capture
  client-side. PUBG stores events within ~1 km of the recorder;
  sparse events (shots) are *reconstructed by guesswork* at playback,
  which is why PUBG killcams famously show inhuman recoil and generate
  false cheat reports.
- **CS:GO POV demo** — client-side recording; faithful for the
  recorder's view only.

Strengths: **shows exactly what the player saw** — the artifact we're
missing. Modest size. Zero determinism needed — the packets are the
source of truth.
Costs: one perspective only; bounded by what the server chose to send
you (relevance culling = blind spots); version-locked to protocol;
loss/jitter baked in as visible artifacts.

### C. Server-side recording — GOTV/MVD demos, MVDSV, Fortnite server replays, Valorant, our RoomDemo

The server records its authoritative stream — one file covers every
player's POV and the whole map.

- **QuakeWorld MVD** — the gold standard since ~1998: MVDSV ("MultiView
  Demo SerVer") records a single stream containing all POVs, used for
  QTV broadcast relays, spectator autotrack, and league anti-cheat
  review. Quake II/III/IV followed suit (Q2PRO `.mvd2` dummy-observer
  trick, CPMA multiview).
- **CS:GO GOTV demos** — server truth; the reason "CSGOed" clips exist.
  Shots visibly off-target that the server credited as hits.
- **Fortnite server replays** — used for FNCS broadcasts; whole island,
  no replay-region culling.
- **Valorant (2025, Patch 11.06)** — took Riot ~5 years. UE gives the
  replay plumbing "for free," but every gameplay asset must be made
  *replay-ready*: paused time, seeking, ability/visual state that
  doesn't survive re-serialization. Their own examples: doors floating
  mid-air, Brimstone smokes broken on rewatch. Lesson: **replay is a
  per-feature tax, not a feature you bolt on.**

Strengths: complete truth, any POV, anti-cheat admissible, broadcast.
Costs: the "looks off" artifact (this whole report); server must record
for everyone.

### D. Reconstruction — CS2 TrueView, HLAE mirv_pov, Overwatch killcam

The newest pattern: keep the server recording, but **re-run the
client-side prediction pipeline at playback** to reconstruct what the
observed player saw.

- **CS2 TrueView (Nov 2025)** — Valve's fix for the GOTV artifact:
  "Previously demo playback showed the server's view of the world,
  without accounting for network latency. This could be confusing
  because shots would hit that didn't look like they should have."
  TrueView re-executes the observed player's client-side prediction +
  smoothing during playback, and honors damage-prediction state. Their
  caveats are the honest ones: not frame-exact (GPU pipeline offsets
  FX by a frame or two), and **disabled when the playback build ≠
  recording build** — the reconstructed view is only as valid as the
  prediction code being the same.
- **HLAE `mirv_pov`** — community tool reconstructing POV demos from
  GOTV files, proving the approach works without server cooperation:
  server demo + known prediction math ≈ client's view.
- **Overwatch killcam** — the hybrid in the wild: the *client* keeps a
  snapshot-history ring ("reels"); on death the killer's buffered
  recent history is sent to the victim under a hard respawn deadline
  and rendered through the normal client path. That's why killcams
  show the killer's *approximate* view (they can be off — wall-clip
  deaths look wrong) but approximately track what the killer saw.
  Blizzard's framing: "develop a replay system in parallel with your
  network model." Full-match Overwatch replays (2019) are server-side
  and suffer the usual truth-vs-view gap.

### E. Just don't ship one — Tribes Ascend, Valorant pre-2025, PUBG launch

Worth noting as a market signal: Hi-Rez teased demos for T:A, then
cancelled them in 2012 — the competitive community response was
incandescent ("demos... make cheating very easy to prove [without
them]" — anticheat review is a first-class use case). UE3's `demorec`
existed in the leaked dev build, proving the plumbing was already
there; the cost was productizing it. Valorant waited five years for
the same reason. Replay systems are *never free* — the wire format,
the sim, and every visual asset all have to agree to be recorded.

## Cross-cutting lessons

1. **Everyone converged on "record the wire, replay the pipeline."**
   Tribes `.rec`, QuakeWorld `.qwd`, UE DemoNetDriver, QWD→MVD — the
   recording is a captured network stream, not a video of state. The
   cheapest correct demo is one whose format *is* your wire protocol.
   We already have this: the server demo is essentially a journaled
   broadcast stream.

2. **Two truths need two artifacts or one reconstruction.**
   You either (a) record each client's inbound stream (Tribes,
   Fortnite local) to preserve "what they saw," or (b) record server
   truth + re-run prediction at playback (TrueView, mirv_pov). Pure
   server truth alone always looks off and *always* generates "that
   didn't hit" confusion — CS lived with it for 20+ years before
   fixing it.

3. **Killcams ≠ replays.** Overwatch's ring-buffer-of-snapshots is a
   different feature: seconds of recent client history, per-client,
   shipped to the victim. It's cheap *because* it's bounded and
   approximate. (We now do the corpse-hold→killer blend; the data
   source question is next.)

4. **Version lock is universal.** SC2 `replayCompatibilityHash`,
   Fortnite replays dying per patch, T2 graying out old .recs, TrueView
   gating on build match, TrueView's `cl_demo_predict 2` override.
   Every shipped system either enforces it or silently corrupts. Our
   `PROTOCOL_VERSION` stale-bundle reload is already half of this.

5. **Relevance culling bounds client recordings.** Fortnite literally
   draws the Replay Region in the replay UI to explain missing
   actors. Server-side demos are immune — another argument for
   server-recording as the canonical artifact.

6. **Approximation breeds false reports.** PUBG deathcams inventing
   recoil patterns → false cheat reports; Overwatch killcams showing
   through-wall deaths → netcode complaints. If the demo is a tool for
   auditing netcode and bots, fidelity claims need labeling: "this is
   server truth" vs "this is what X saw."

7. **Replay-readiness is a per-feature tax** (Valorant). Anything that
   doesn't round-trip through the wire format — pooled FX, visual-only
   state, camera rigs — is broken or missing in playback. The earlier
   FX/backlog instrumentation work pays off here: things driven by
   wire events replay for free; things driven by local prediction
   don't.

## A nuance: remote-vs-remote fights look *most* truthful in server demos

Counterpoint to "server demos look off": when remote A shoots remote B,
the observer renders **both** at ~`interpDelay` behind server time —
positions in the same frame belong to approximately the same server
tick, so the geometry is self-consistent. A's disc leaves A's rendered
gun, flies, and lands on B's rendered position; since the server sims
shells against the same authoritative positions the observer sees
delayed, projectile trajectories and impacts read honestly.

What still diverges, narrowly:

- **Adjudication epoch ≠ observer epoch.** The server credited A's
  shot against A's lag-compensated view of B (A's ping + view lag), not
  the observer's. Credited hitscan "hits" can still show as near-misses,
  but the gap is `A's staleness − observer's staleness` — tens of ms,
  not the ~6 m swing a local shooter's fast target can produce.
- **The victim's screen is a third truth** the demo can't show — remote
  B was somewhere else when they got tagged (favor-the-shooter).

Divergence hierarchy, worst→best: (1) **local player's hitscan** — view
lag vs server truth, the big one; (2) **remotes shooting you** —
killer's view vs your corpse position, killcam territory; (3)
**remote-vs-remote** — usually within a tick or two of drift; truth
view reads basically fine.

**Consequence for the roadmap below:** if demo playback is mainly for
watching remote fights (bot auditing, team review, broadcast), server
truth alone is already ~fine — ghost-epoch annotation just labels the
credited-hit cases. Expensive TrueView-style reconstruction only buys
real fidelity for the *local shooter's* POV — the same case killcam
cares about. Remote-vs-remote is the argument for "server demo is good
enough for spectators; invest in the victim/killer-view lane instead."

## Where our architecture lands

We're already closer to the good end of this than most:

- **`shared/` deterministic sims** — the Halo/SC2 requirement is
  partially met: movement and projectiles are deterministic *given the
  same wire stream*. Full-input-replay determinism is a bigger claim
  we haven't earned (JS float behavior is consistent enough, but every
  system would need audit).
- **Server-side demo exists** — RoomDemo ≈ GOTV/MVD: authoritative,
  multi-POV, anticheat-usable. The missing half is the *view*.
- **The client's interp/prediction stack already re-simulates** —
  `remoteInterp`, reconciliation, `viewLagMs`. A TrueView-style mode
  would feed the recorded stream through the normal `wireIn` →
  `world` → `remoteInterp` path rather than a bespoke snapshot player.
  The machinery is the same code path the live game uses — which is
  exactly why it would reconstruct the player's actual view.
- **`viewLagMs` + ghost position already compute the adjudicated
  epoch** — the cheap 80% (record rewind epoch per hit/kill event,
  ghost it in playback) is mostly a demo-format field, not new
  machinery.

### Recommended order (smallest-true-pilot first)

1. **Annotate truth.** Add `viewLagMs`/rewind-age + rewound-victim-pos
   fields to hit/kill demo events. Playback draws the ghost epoch →
   "misses" visibly land. Small diff, makes the existing artifact
   *explainable* instead of just wrong-looking.
2. **Client-side shadow recording (the Tribes .rec move).** Journal
   the inbound wire stream + own inputs client-side (we already
   journal inputs for reconnect replay — same machinery, longer
   window). This is the Tribes 2 / Fortnite-local architecture and it
   directly answers "what did I see" for the local player at least.
3. **TrueView-style playback** — only if 1–2 prove the demo is
   load-bearing: run the recorded server stream through the live
   client interp/prediction path to reconstruct any observed player's
   view. Version-gate it on PROTOCOL_VERSION/build, per every shipped
   precedent.

The trap to avoid is PUBG's: sparse-event reconstruction that
*invents* intermediate state. If we can't show what happened, better
to show the ghost epoch honestly than interpolate a plausible lie.

## Sources

- CS2 TrueView announcement (Valve, Nov 2025) — steamcommunity/PC Gamer/HLTV coverage.
- CS:GO demo taxonomy + `mirv_pov` reconstruction — davidbdurst.com "Emulating CSGO Client-Side Demos With Server-Side Demos."
- Overwatch replay tech — Philip Orwig, GDC 2017 ("Replay Technology in Overwatch: Kill Cam, Gameplay, and Highlights").
- QuakeWorld QWD format spec (demospecs.half-empty.de), MVDSV README, openq4 multiview-demos doc (competitive precedent table).
- Torque Game Engine `recordings.cs` + TribesNEXT threads confirming `.rec` = inbound net stream + inputs.
- T:A demo cancellation fallout — ESR thread, 2012; Tribes Depot wiki on dev-build `demorec`.
- Fortnite replay system FAQ + server replays (fortnite.com); UE4 DemoNetDriver/Streamer docs; FortniteReplayDecompressor format notes.
- Halo Saved Films — Bungie.net how-to + Max Dyckhoff interview (determinism = input + seed).
- SC2 replay internals — Blizzard s2protocol, sc2reader "What is in a Replay?"
- Valorant replay delay + launch — Riot dev updates, playvalorant.com Patch 11.06 notes.
- PUBG replay inaccuracies — community + PUBG-Replay-Manager issue #21 (UE4 net stream, ~1km relevance).
- SnapNet "Netcode Architectures Part 3" — two-time-stream framing.
