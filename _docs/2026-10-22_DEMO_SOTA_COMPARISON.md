# State-of-the-art demo/replay systems vs ours (2026-10-22)

Companion to `2026-10-22_REPLAY_DEMO_SYSTEMS.md` (which covered *what gets
recorded* — the two-truth problem). This report goes deeper: the most
advanced replay systems ever shipped, what makes them robust, and where
the `.demo` system stands against each capability axis.

## The top tier, and what each is best-in-class at

### 1. Dota 2 `.dem.bz2` — the analytics ecosystem king

Every match is recorded **server-side** by Valve and downloadable by
anyone (replay salt + cluster → `replay.valve.net`). Protobuf stream of
entity deltas plus: all player *and caster* camera positions and UI
clicks, fog-of-war state at every tick, item builds, server-computed
stat timelines, caster audio tracks, chat, and — the important part —
**periodic full-state snapshots** that power "replay takeover": load a
snapshot and the demo becomes seekable/inspectable from any point.

The robustness lesson isn't the format, it's the *ecosystem*: OpenDota
built an industrial parsing pipeline (clarity) that turns every pub
match into queryable data — replays became the game's measurement
substrate, not just its VCR. ~20-40MB per match.

### 2. StarCraft II — replays as save-states

Input-event replay (initial state + every player action, nothing else —
AI is deterministic so it records zero). Heart of the Swarm turned the
replay into a **session object**:

- **Take Command** — jump to any timestamp and take over as any player.
- **Recover Game** — tournament-legal resume after a disconnect/crash;
  replays literally function as match save-states. Used live in pro
  tournaments (Shoutcraft's qxc lag-out).
- **Watch with Others** — shared replay lobby; host scrubs timeline,
  everyone watches in sync.

Nothing else shipped "resume the match from the recording." It works
because the sim is deterministic *and* the engine can materialize a
full loadable state at an arbitrary game-loop — the same trick our
seek-checkpoint + `runSeed` machinery gestures at.

### 3. Trackmania — replays as anti-cheat evidence (20+ years)

The most instructive model for "demo = fraud evidence":

- Replay files **embed the exact inputs**; the game's Validate function
  re-simulates them and confirms the recorded time. TMX leaderboards
  have required replay submission — no video needed — since 2003.
- When trust degraded (TAS tools appeared), the community built
  **TMInterface** (deterministic input playback + save states +
  bruteforce), a Competition Patch that verifies inputs come from real
  hardware, and **Revalidate** — a web service that runs validation on
  dedicated servers in Docker containers, returning verdicts per file.

The pattern: *the replay IS the proof-of-run*, and the community
wrapped verification infrastructure around it when the stakes rose.
Our `runSeed` + `ResultToken` + `verify.ts` is the germ of exactly this.

### 4. QuakeWorld MVD + QTV — the broadcast king (1998!)

MVDSV records one server-side multi-POV stream; **QTV proxies chain it
to thousands of spectators** with a ~10s delay (anti-stream-snipe by
construction). A 1998 design that solved: multi-POV recording, live
relay trees, delayed broadcast, autotrack camera, downloadable demos —
everything OBS-era broadcasters still want. Our `SPECTATE_RELAY` doc is
the same architecture, 28 years later.

### 5. CS2 TrueView (Nov 2025) — the truth-reconstruction king

Server demos + client-side prediction **re-run at playback** to
reconstruct the observed player's experience (damage prediction
included). Honest about limits: not frame-exact (pipeline offsets),
disabled on build mismatch — version-lock enforced rather than
silently wrong. Preceded by community `mirv_pov` proving server demos +
known prediction math ≈ client view.

### 6. Overwatch — the unified-platform model

One replay substrate serves killcam (client snapshot-history "reels"
transferred under a hard respawn deadline), POTG, highlights, *and*
internal bug-repro — Blizzard's explicit guidance: "develop a replay
system in parallel with your network model." The reel-transfer trick is
the cleverest shipped thing: the killer's own recorded buffer is what
the victim watches, so killcam shows (an approximation of) what the
killer actually saw.

### 7. Fortnite / UE DemoNetDriver — the architectural king

Replay is a **second network driver** (`DemoNetDriver`) fed by the same
replication layer that feeds real clients — recording is free for any
replicated property, no per-feature plumbing. Streamers decide
destination (local file, server, broadcast). Checkpoints give seeking;
"Replay Region" honestly renders interest-culling boundaries. The cost
side is Valorant: five years because thousands of assets each had to be
made replay-ready (paused time, seek correctness, FX state).

### 8. Halo Saved Films — console-grade determinism

Input+seed re-simulation (Marathon lineage): "every enemy, every
projectile, physics object, sound." Free camera, clips, screenshots —
all from a file that stores no state at all. The constraint it exposes:
campaign films couldn't rewind because streaming was one-directional.
**Playback seek requires materializable state**, not just inputs.

## Capability matrix vs `.demo`

| Capability | Dota2 | SC2 | TM | MVD/QTV | CS2 | OW | Fortnite | **Ours** |
|---|---|---|---|---|---|---|---|---|
| Server full-match recording | ✔ | ✔(inputs) | n/a | ✔ | ✔ | ✔ | ✔ | ✔ demorec |
| Client-view recording | — | — | ✔ | ✔(QWD) | ✔(POV) | ✔(reels) | ✔ | **✔** |
| What-the-player-saw fidelity | ✔(takeover) | ✔ | ✔ | partial | ✔ | ~ | ~ | **partial** |
| Deterministic re-sim in file | — | ✔ | ✔ | — | — | — | — | runSeed |
| Fraud/integrity evidence | partial | ✔ | **✔✔** | ✔ | ✔ | — | — | **✔** (token+seed+CRC) |
| Seek without full replay | ✔(snapshots) | ✔ | ✔(savestate) | — | partial | — | ✔(ckpts) | **✔** (30s ckpts) |
| Multi-POV / follow | ✔ | ✔ | — | **✔✔** | ✔ | ✔ | ✔ | partial |
| Live spectator relay | ✔ | — | — | **✔✔** | ✔ | — | ✔ | doc only |
| Resume/takeover | ✔ | **✔✔** | ~ | — | — | — | — | ✘ |
| Analytics extraction | **✔✔** | ✔ | ✔ | — | ✔ | — | ✔ | partial (tools) |
| Re-implementation spec | protobuf | ✔ | partial | ✔ | ✔ | — | — | **✔ FORMAT.md** |
| Format survives missing map | — | — | — | — | — | — | — | **✔ HMAP** |
| Version-lock honesty | expire | ✔ | ✔ | grayed | **✔ gated** | — | expire | partial |

## FPS-specific SOTA — the closer peer group

The general ranking above understates how strong the *FPS* lane is —
several of these are directly relevant to a Tribes-like:

### Unreal Tournament (UT99) — the first true server demo

`admin demorec` recorded **server-side demos of the whole match**: all
players' positions and moves, wherever they were — explicitly contrasted
with client demos limited to "the scope of a player." The documented
caveat is our exact two-truth problem, discovered in 1999: *"the aim and
positions aren't as precise as on a client-side demo"* — competitive
sites like ClanBase preferred client POV demos for aim review. Plus the
same version-lock (4.51 demos only play on 4.51 clients). Community
`udemo` added seeking, speed control, free-cam, POV-follow — features
Epic never shipped. **A server demo records everyone but at wire
fidelity; a client demo records one player at full fidelity.** That
tradeoff is 26 years old and unchanged.

### Call of Duty (id-tech lineage → Theater)

`.dm_1`/`.dm_2` files are Quake-tech descendants: "a recording of network
state: snapshots, entities, player states, config strings, and the
recording client's camera movement" — client-stream recording again.
Modern Theater (BO6) is the polished consumer version: recent-match
browser, eliminations/deaths jump-points, fly-cam, 7-day expiry,
dies every patch. Community tooling (cod4-dm1-tools) parses the format
into top-down tactical replays — the analytics lane again.

### The FPS capability ladder (what "SOTA" means for our genre)

| | UT99 | QW MVD | CS:GO/CS2 | OW | Valorant | CoD | PUBG | **Ours** |
|---|---|---|---|---|---|---|---|---|
| Server full-match demo | **✔ '99** | ✔ | ✔ | ✔ | ✔ | partial | ✔ | ✔ demorec |
| Client POV demo | ✔ | ✔ | ✔ | ✔(reels) | — | ✔ | ✔ | **✔** |
| Any-POV follow | ✔ | **✔✔** | ✔ | ✔ | ✔ | ✔ | ✔ | partial |
| Seek/scrub | mod | — | ✔ | ✔ | ✔ | ✔ | ✔ | **✔** |
| Truth-vs-view fix | — | — | **✔ TrueView** | ~reels | — | — | — | ✘ planned |
| Anticheat-admissible | ✔ | ✔ | ✔ | — | ✔ | — | — | **✔ signed** |
| Format spec | — | ✔ | partial | — | — | reverse-eng | reverse-eng | **✔ FORMAT.md** |
| Lag-comp epoch in file | — | — | ✔(TrueView) | — | — | — | — | ✘ v8 cand. |

### What the FPS tier teaches specifically

1. **Server demos have *always* been second-class for aim review** —
   UT99's docs say it outright; CS2 only fixed it in 2025 by
   re-simulation. Twenty-six years of "server truth ≠ shooter view"
   means our plan to annotate rather than re-simulate first is the
   right lazy-senior move — nobody else solved it cheaper either.

2. **MVD-style multi-POV is the biggest capability gap.** Every FPS
   peer lets you watch any player's POV in one file. Ours is
   single-POV + remote context frames — fine for clip review, not for
   scouting/anticheat of a specific remote. The follow-roster pilot
   targets this.

3. **Our integrity column is genuinely rare.** Signed `ResultToken` +
   `runSeed` + CRC — among shipped FPS only Trackmania-adjacent systems
   verify this hard. Valorant/OW/CoD demos are trusted-or-nothing.

4. **Nobody else embeds the map.** Every peer demo dies without the
   asset install (UT99 needed matching texture builds!). Our HMAP
   trailer making the file self-sufficient for terrain is a real
   robustness edge — worth protecting.

5. **Playback-through-real-pipeline is the universal answer when
   fidelity matters** — UT demos, QW demos, CS demos, UE demorec all
   replay through the *live* client net path. Our proxy-world playback
   is the outlier; every new entity kind pays the double-maintenance
   tax the FPS giants avoided by construction.

## The Source-era trio — CS:GO, TF2, Overwatch lineage

These three matter because each represents a distinct *mature* answer to
the demo problem, and our system borrows bits of all three.

### CS:GO — the dual-format anticheat standard

Two demo types side by side, still the industry's reference split:

- **POV demos** (`record`) — client-side, the recorder's exact inputs and
  view. Mandatory in pro rulesets: ESL fines players per map for
  *failing to record a POV demo* — the client-view artifact is
  literally contractually required as anticheat evidence.
- **GOTV demos** — server-side, every POV, downloadable post-match from
  the client (Watch tab), ~50-150MB, ~30-day links. This is what HLTV,
  FACEIT downloads, and every analyzer (CS Demo Manager supports ~15
  sources — Valve MM, FACEIT, ESEA, ESL, 5EPlay…) parses.

The durable lesson: **the anticheat ecosystem needs BOTH truths** —
server demos for "what happened," POV demos for "what the suspect saw."
A server demo alone can't adjudicate aim (that's the UT99 caveat made
policy). Our `demorec` + client `.demo` pairing already has the same
shape; what CS adds on top is the *distribution* (click → download in
client) and the parser ecosystem.

### TF2 Replay Update (2011) — demo→movie in-engine, still unique

TF2 shipped the only FPS demo system that ends in **rendered video
files**, not just playback:

- **Server-side recording**: replay-enabled servers record every round;
  client downloads the `.dem` on death (F6) — server artifact,
  client pull.
- **Replay Editor**: in/out points → "takes," switchable between
  first-person, third-person, and free-cam *per take* — you assemble a
  multi-angle edit inside the game.
- **In-engine video render**: exports H.264/MJPEG at up to 1080p (or
  .tga+.wav raw), with per-object motion blur — the same tech line as
  Source Filmmaker, then direct YouTube upload. In 2011, in a game
  client.

Nobody has matched the demo→edited-movie pipeline since (everyone else
says "use OBS"). Relevant to us because our playback is already
in-engine with real assets — a `VideoRecorder.ts` exists but the
"cut a take, render it clean" loop TF2 had is a genuinely unclaimed
niche. Also note their honest caveat: `.dem` replays rot on every
game update — Valve warned you to render before exiting.

### Overwatch — the unified-substrate pattern (recap)

Already covered above, but the trio framing matters: OW's one replay
system serves killcam (client "reels," transferred at death under a
respawn deadline — approximately what the killer saw), POTG,
highlights, and internal bug-repro. The transferable idea isn't the
format, it's **designing replay alongside the netcode** so every
consumer (player-facing and dev-facing) rides one substrate. Our
always-on recorder + clipSink + coolShots is the same instinct;
the OW lesson is that the *transfer* story (who records what, who it
gets shipped to, under what deadline) is as much design work as the
recording.

### Where our trio borrows

| Their piece | Ours today | Gap |
|---|---|---|
| CS POV + GOTV dual artifacts | client `.demo` + server `demorec` | server artifact not pull-addressable per player |
| CS download-by-match | demoVault / leaderboardSubmit | no "watch match by ID" client path |
| TF2 takes → video | VideoRecorder.ts | no in/out-point editing or per-take cameras |
| OW reel-under-deadline | killcam hold→blend + battleLog | killcam replays *live* state, not killer's buffer |
| GOTV any-POV | remoteFrames + roster | no follow-roster[N] mode yet |

## The 2020s FPS generation — what shipped recently

The modern cohort shows where the bar moved: **replays are now a launch
feature, not a decade-later add-on** — and server-side shareable
recordings displaced local files.

### Marvel Rivals (2024) — the current consumer bar

Server-side replays from day one: match history → play button → replay
with free cam, POV swap to *any player including enemies*, speed
control, HUD toggle, and — the part everyone else lacks — **shareable
Replay IDs** so you can watch a friend's match by ID, plus
report-a-player directly from replay. Retention is 7 days; version-
locked per patch (universal now). This is the feature set players now
*expect*: our clip-share/cool-shots lane is the closest analogue, and
"replay ID → watchable by anyone" is exactly the demoVault direction.

### Rainbow Six Siege Match Replay (2021) — the local-file approach

Auto-records the last 12 matches to local files; full spectator toolkit
(any player POV, first-person *and* top-down tactical cam, per-round
jump, scrub). Notably: PC-only, dies every patch, no sharing — Ubisoft
explicitly planned server storage/sharing "further down the road" and
Rivals then shipped it. The round-skip and top-down-cam are cheap
wins for our DemoUI — our playback already supports a map-view camera
concept via commandmap.

### THE FINALS Instant Replay (2025) — the hardest version attempted

Embark reconstructs your death moments **inside a fully destructible
world** — physics, crumbling structures, gadget POVs (grenades,
turrets), slow-mo tail. "Prototypes date back to before the game had a
name... a level of data fidelity that's hard to pull off in a Dynamism
Shooter." The lesson: **replay-readiness must be designed in from day
one** (their own words: prototypes during pre-production); destruction
state is the thing that doesn't fit a plain snapshot model — same as
our terrain-deform/pooled-FX problem. Also gated by RAM (<16GB can't
run it) — replay cost is a real hardware budget.

### Escape from Tarkov — the counterexample

No replay system in the main game (Arena mode has spectator only). The
community consequence is instructive: an entire cheat-accusation
epistemology built on vibes — "hackusations" with no falsifiable
record, plus a third-party Raid Review mod filling the gap with
heatmaps/timelines/ballistic breakdowns (the analytics lane again —
when the dev doesn't provide it, the community builds it worse).
Same lesson as Tribes Ascend 2012: **a competitive FPS without demos
outsources its anti-cheat to paranoia.**

### Modern pattern: the shared-clip social layer

Rivals' Replay IDs, Siege's abandoned sharing plans, OW highlights,
CoD Theater's clip recording — the replay is now expected to be
*portable and social*, not a local artifact. Server-side recording +
ID-addressable retrieval is the table stakes for 2025; per-file
local recordings (Siege, T2 `.rec`) is the legacy pattern our
client-side `.demo` follows today. Our `demoVault` + server
`DemoStorage`/`leaderboardSubmit` is halfway to the modern shape —
missing piece is the "watch any match by ID" pull path.

## Demo→video export — what we have vs what's possible

`VideoRecorder.ts` is already ShadowPlay-class for **realtime** capture:
WebCodecs `prefer-hardware` (NVENC-class, ~0 fps cost), HEVC→H.264
ladder, fixed-QP mode, staged 1920×1080 blit, 20s ring buffer with
keyframe-aligned `cutWindow`, AAC/opus audio lane, MediaRecorder
fallback. For live clip capture it is genuinely ahead of most shipped
games.

The gap is **offline deterministic render** — the TF2 approach, and the
reason their clips look better than anything recorded live:

| | Realtime capture (today) | Offline render (TF2-style) |
|---|---|---|
| Speed | 1× realtime | 2-5× faster (GPU-bound, not clock-bound) |
| Frame timing | wall-clock — stutters recorded | authored ts = `frame/fps` — perfectly even |
| Source of dropped frames | encoder backpressure, GC, tab throttle | none — frame only commits when encoded |
| Quality | display-rate limited | can render 60fps output on a 30fps machine |
| Extras | — | motion blur via sub-step accumulation, per-take cameras |

### Feasibility: unusually good

The machinery already exists — `DemoPlayer.advanceTo(t)` /
`seek()`/`reconstructToTime` drive playback to arbitrary timestamps
independent of wall clock (`DemoPlayer.ts:147-120`). An offline render
loop is:

```
player.seek(start)
for t = start..end step 1/fps:
  player.advanceTo(t)          // applies events to t
  renderer.render(scene, cam)  // frame
  encoder.encode(new VideoFrame(canvas, {timestamp: (t-start)*1e6/fps}))
mux.finalize() → mp4
```

Same `VideoEncoder`+`mp4-muxer` stack, timestamps authored instead of
wall-stamped, output is frame-perfect even when the machine can't hit
60fps live. This is also the path to **headless clip render** — the E2E
infrastructure already drives headless Chrome+GPU (`E2E_GPU=1`); a
`_tools/renderClip.ts` could load demo playback, step frames, and emit
mp4 server-side without a visible client — which is what "share clip by
ID" needs (render on demand, cache).

### Ranked export improvements

1. **Offline stepped render** (`renderClip(demo, t0, t1, fps)`) — the
   single biggest quality+speed win; all pieces exist. Edge: needs
   `preserveDrawingBuffer` or pump-inside-rAF, and playback SFX don't
   step — render audio via a second `OfflineAudioContext` pass keyed to
   the same event stream, or ship video-only v1.
2. **Takes/in-out points** — `extractClip` already produces sub-demos;
   a DemoUI trim UI + offline render = TF2 takes, minus their editor.
3. **Sub-step motion blur** — render N sub-frames per output frame into
   an accumulation target and blend; the "sexy motion blur" TF2
   advertised. Optional quality toggle in export.
4. **Worker-muxed encode** — Chrome's own guidance: move chunk handling
   + muxing off main thread (frames are transferable). Frees the main
   thread during realtime capture; encode itself is already async/HW.
5. **`captureStream(0)` + `requestFrame()`** — for the realtime path:
   capture exactly presented frames instead of fixed-rate sampling —
   kills duplicate-frame padding when display ≠ output fps.

The realtime path needs none of this for correctness — these are
quality/headroom. Item 1 is the TF2-parity move and the one that
unlocks server-side clip rendering.

## Honest verdict

**We are top-quartile on artifact engineering** — self-describing
versioned format, embedded terrain fallback, signed result tokens,
RNG-seed verification, CRC, seek checkpoints, always-on ring + clip
extraction, a validation toolset. In that column we beat every shipped
system except Trackmania's *verification ecosystem* and SC2's
session-resume.

**We are behind on three axes:**

1. **The stream isn't the wire.** T2 `.rec`, QWD, Fortnite — the
   recording IS the inbound packet stream, so playback rides the real
   client pipeline. Ours is a curated state+event model replayed
   through parallel proxy code (`PlaybackCreature`, beam twins, etc.).
   That's why FORMAT.md's "known limits" exist (remote projectiles
   Fired/Destroyed only, `mouseDelta` dead, remotes 20Hz). It also means
   every new entity/event type must be added to *two* pipelines —
   wire→live and wire→demo→playback-proxy — the Valorant tax.

2. **No truth-vs-view machinery.** CS2 TrueView and Overwatch reels
   both solve "show what the player saw." We record the *rendered* local
   view (good) but playback is a third truth — the playback
   reconstruction, which is neither what the recorder saw frame-exact
   nor the server's view. The `viewLagMs`/ghost-epoch work is the right
   primitive; it isn't in the format yet (v8 candidate).

3. **No ecosystem.** Dota's real advance wasn't the format, it was
   OpenDota — parseable-at-scale data. We have `demodiff`/`demoAudit`/
   `demovalidate` as single-file tools; there's no "parse N demos →
   aggregate" pipeline (e.g., heatmaps of death positions, disc-hit
   rate by distance, lag-comp gap histograms across a corpus). The
   format is *designed* for it (typed records, spec'd, no assets needed)
   — this is cheap upside.

## Smallest-true pilots, ranked

1. **Corpus analyzer** (`_tools/demoCorpus.ts`): parse a directory of
   .demo files → aggregate stats (kill distances, hit-vs-ghost offsets,
   remote interp gaps). Proves the format is analytics-ready; directly
   feeds the "feel metrics" work. ~1 file.
2. **Remote projectile edges** (Fired/Bounce/Hit + victim) — closes the
   most-used documented hole; playback fidelity for remote-vs-remote
   fights.
3. **`viewLag`/rewind-age on kill markers** — v8 trailer field; makes
   every kill event self-explaining in truth view.
4. **Wire `mouseDeltaX/Y`** — field exists, provider never wired;
   unlocks real-aim POV playback.
5. **"Follow roster[N]"** — server demos + existing remote frames get
   multi-POV cheaply; the MVD move.

The big swing — TrueView-style playback through the real `wireIn`/
`remoteInterp` pipeline, or SC2-style resume-from-demo — only after
1–3 prove the demo is load-bearing in the netcode-feel loop.

## Sources

- OpenDota architecture + clarity/skadistats demo compendium (Dota 2
  demo internals: snapshots, takeover, entity deltas).
- Blizzard HotS announcement: Take Command / Recover Game / Watch with
  Others (2013); TL.net tournament usage.
- donadigo.com: TMX Replay Investigation, TMInterface, Competition
  Patch; revalidate.gbx.tools.
- QW-Group/qtv + QuakeForge QTV overview (chained proxies, ~10s delay,
  MVD stream).
- Valve CS2 TrueView notes (Nov 2025); davidbdurst.com POV-vs-GOTV +
  HLAE mirv_pov.
- Overwatch GDC 2017 (Orwig): reels, respawn-deadline transfer, unified
  replay tech.
- Fortnite replay FAQ / DemoNetDriver docs; Valorant Patch 11.06
  replay ship (2025) + the five-year delay explanation.
- Halo Saved Films: Bungie how-to + Dyckhoff determinism interview.
