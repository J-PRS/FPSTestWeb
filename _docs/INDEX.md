# Documentation index — KRIBES

The project produces a lot of documentation. This file is the map.
**Read this first** before digging in `_docs/` (200+ files).

## Canonical / living (keep current)

| Doc | What it is |
|---|---|
| `AGENTS.md` (root) | Agent guide — commands, layout, rules of the road |
| `client/AGENTS.md` | Client-specific agent guide |
| `server_bun/AGENTS.md` | Server-specific agent guide |
| `ROADMAP.md` | Living manifesto — read first, keep current |
| `changelog.txt` | Prepended `YYYY-MM-DD - <summary>` per settled topic |
| `_docs/TASKS.md` | Project development context |
| `_docs/NOTES.md` | JP's world notes |
| `_docs/2026-11-08_BOT_BRAIN_CODEX.md` | **Bot AI living codex** — philosophy (legal humans, wire-legal senses, dial escalation), architecture map, every dial + reader, hero-mode results loop, tests/telemetry, gaps |
| `_docs/2026-09-28_TEST_PLAN_BOTS.md` / `_docs/2026-09-28_TEST_PLAN_DEMO.md` | Test plans |
| `_docs/2026-10-15_CAPPER_STRIKE.md` | **Living capper reference** — scoreboard, mechanics, physics budget, landmines, measured history |
| `_docs/2026-10-22_CARRIER_GATE.md` | Capper carrier-gate fix — park block, airborneBy leak, tactical ski-release, arrival deceleration abandoned (wrong tool) |
| `_docs/2026-10-22_TRIBES_MOVEMENT.md` | **Full Tribes movement report** — physics, energy management, terrain reading, jet system, tactical decisions, bot AI application, landmines |
| `_docs/2026-10-16_CAPPER_REACTIVE_LIMITS.md` | Capper reactive ceiling + TAS floor |
| `_docs/2026-10-16_TEAMSOAK_WARP.md` | Themed team matchups + warp collapse |
| `_docs/2026-10-17_TERRAIN_COMPILE_STALL.md` | The 40s browser hang |
| `_docs/2026-10-22_FRONTEND_AUDIT.md` | Vanilla DOM layer vs published best practice — near-optimal; residual gaps |
| `_docs/2026-10-28_CLASS_ASSET_DUPLICATION.md` | Live class GLBs embed duplicate 32-clip sets (~722 KB redundant); shared-pack option and prerequisites |
| `_docs/2026-11-07_CLIP_STRIP_MIGRATION.md` | **Post-strip clip wiring** — where each rig's clips come from now (scout pack / kevdev / UAL maps), polyart re-sourced, and the unclosed gap: scifisoldier/vexa/polyart have no non-loco bone map |
| `_docs/2026-10-28_LAG_COMP_WYSIWYG.md` | Lag-comp reference: industry practices, our rewind pipeline, ghostsoak numbers, remaining accuracy work |
| `_docs/2026-10-28_NDC_PROJECTION.md` | Overscan-canvas NDC mapping — why head markers drifted, the ndcScreen contract, what to reuse |
| `_docs/2026-10-23_SERVER_HOTPATH_AUDIT.md` | **Server hot-path footgun audit** — projStep/link allocations, remaining dhypot3 swaps, per-tick grid rebuild, roster builders; ordered by payoff/risk |
| `_docs/2026-10-23_DUEL_CAPACITY.md` | **1v1 capacity report** — measured: duel rooms cost 1.5× more per client than 32-seat rooms (175 vs 266 CCU/core); profile attribution, cost model, L1-L8 levers, industry patterns |
| `_docs/2026-10-28_SERVER_PERF_RESEARCH.md` | **Server perf research** — what's actually left after cpuprof attribution: GC-controller 16ms bug ≈ tickMsMax spikes (Bun upgrade lever), validated architecture, ranked remaining wins |
| `_docs/2026-10-18_ADDING_MODES_AND_PICKUPS.md` | Blast surface for new modes/pickups |
|| `_docs/2026-10-29_JOIN_LATENCY_AUTOPSY.md` | **Join latency autopsy** — /metrics.joinMs phases + introDrain prove the herd's multi-second first-gameState tail is WAN delivery, not compute (work ~0.4ms, ELD healthy while drain hit 245s); herd single-link artifact boundary documented |
| `_docs/2026-10-29_WEAPON_ARCHITECTURE.md` | **Weapon system state** — layer map (wire law → derived sets → authority → prediction → presentation), both ammo economies, the hardcoded-wid bug the audit caught, ranked remaining seams, add-a-weapon checklist |
| `_docs/2026-10-30_WEAPON_REGISTRATION_PLAN.md` | **Weapon registration consolidation plan** — the 14-file blast radius of a new weapon, the marker-field/derived-set fix (beltThrow precedent, generalized), config factories, sfxKey/vm families, migration order, risks |
| `_docs/2026-10-30_BOT_MULTITASK_PLAN.md` | **Bot multitask plan** — hunt-target audit (one `st.hunt` drives aim+feet) and the eyes/feet/hands lane split: objective beacon, corridor loot, attention budget, build order |
| `_docs/2026-10-30_SCATTER_AUDIT.md` | **Whole-repo scatter audit** — every per-kind registration domain ranked by files-per-new-member: species ~10 and deployables ~11 are the worst; bot aim tables silently degrade; perks/maps/keybinds are the model domains |
| `_docs/2026-10-29_EXPLOSION_VFX_BIBLE.md` | **Blast VFX reference** — variant architecture, per-weapon recipes, AOE-accuracy rules, layer-timing beats, shellburst (black-powder) recipe, tuning knobs, sources |
| `_docs/2026-10-29_RENDER_ORDER.md` | **Render-order reference** — three.js opaque/transparent pass mechanics, the tier table (-100 sky → 9999 debug), the depthWrite/depthTest rules, terrain's transparent-pseudo-opaque special case, sim-vs-render gap trap |
| `_docs/2026-10-29_PHONE_PROFILING.md` | **Real-device phone profiling** — adb reverse + CDP attach pipeline, profiler/debug scripts, every setup gotcha (intent-URL escapes, 9222 clash, rAF death on nav, screen-off suspension), and the canvas-oversize black-screen bug it found |
| `_docs/2026-10-29_MOBILE_PERF_BUDGET.md` | **Mobile perf budget** — K70 measured (~16fps, 502 calls, 429k tris) vs published targets (Arm/PlayCanvas/DevForge): 3–5× over on draw calls, ~1.5× on tris; ranked next steps |
| `_docs/2026-10-26_TTS_DTS_REFERENCE.md` | **TTS/DTS reference** - cold-boot time-to-shoot and data-to-shoot profile, phase breakdown, prediction table, improvement levers |
| `_docs/2026-10-30_NATIVE_ACCEL.md` | **Native acceleration analysis** — wasm/bun:ffi candidates ranked (VFX pools, sweeps, wire encode, moveSim batch); boundary-cost + shared-memory rules; why worker offload and threads beat the port |
| `_docs/2026-10-31_CAPACITY_KNEE.md` | **Capacity knee ~350-370 seats/process** — 368-seat profload: fanout is O(N²) in CPU (dSq per seat×record), intro seats bypass the record cap; spatial-index fix order for thousands-per-box; FPS_MAX_PLAYERS/GLOBAL gotcha for fill runs |
| `_docs/2026-10-31_NETCODE_EFFICIENCY_PLAYBOOK.md` | **Netcode efficiency playbook** — prior-art survey (Tribes/Torque ghosts, Halo Reach priority-fill, Fortnite Replication Graph, Apex tickrate math, PlanetSide 2 culling, Gaffer compression) → parity table vs our stack + ranked P0-P4 plan: spatial index (O(N²) kill), priority fill, intro caps, per-conn budget, zoning; what NOT to copy |
| `_docs/2026-10-31_OCI_CAPACITY_INVESTIGATION.md` | **OCI capacity: Caddy TLS is the box's top process** — production herd + threadCpu + box-top attribution: at ~340/worker the main thread is only ~50% busy (not JS, not GC); box demand ~4.1 cores vs ~3.4 usable (Caddy TLS ~0.9, kernel+softirq ~1.3, steal 14.5% free-tier tax); max CCU ~1000 today, Bun-native TLS path est. ~1.3-1.5k; local dense-room netcode work + honest ~5-11% results |
| `_docs/2026-11-01_MP4_RECORDING_SOTA.md` | **MP4 capture vs browser SOTA** — VideoRecorder audit vs WebCodecs best-practice: measured ~0 frame cost (pump 0.13ms + blit 0.05ms, `_tools/e2e/_vidprof.ts`), AV1/L1T3 landed; mediabunny + encoder-worker both tried and reverted with evidence (worker-side encode stalls on canvas-transferred VideoFrames) |
| `_docs/2026-11-01_PATH_FREE_BOT_DRIVING.md` | **Path-free bot drivers vs MPC** — the stuck-on-track freeze class + 5 ranked alternatives (greedy short-horizon rollout over the shared moveSim, context steering, speed-weighted flow fields, pursuit pointing, policy distillation); recommended architecture + flag-room pilot plan |
| `_docs/2026-11-01_BOT_DRIVE_BENCH.md` | **Bot drive speed-vs-cost bench** — measured armed avg/vmax (greedy 41.6–68.4 vs MPC 36.7–41.0 m/s, peaks CTF `_greedyab.ts`), per-tick costs (greedy 0.27ms decide+12µs apply ≈25× cheaper than MPC's ~22ms/solve ×101/120s), freeze-class + horizon tradeoffs, hybrid deep-solve recommendation |
| `_docs/2026-11-01_COMMIT_SCOPE_GATE.md` | **pre-commit scope gate reference** — >12 files across >4 areas trips a forced-read: humans get y/N via /dev/tty, agents get exit-1 + decision menu (split / FPS_SCOPE_OK=1 scoped escape / --no-verify); awk area bucketing, gotchas (sed \1 loss, test-the-gate-not-just-lint) + commit-hygiene rules |
| `_docs/2026-11-02_AMMO_POOL_PILOT.md` | **Per-weapon ammo pool pilot** (PlasmaGun): clip+regen mechanic (20 rounds, 0.2s/round paused while firing, dry trickle at half cadence), rejected alternatives on record, implementation map (shared pool → server gate → yourAmmo echo → HUD), clock-domain edge, tuning knobs |
| `_docs/2026-11-03_SPREAD_AUTHORITY.md` | **Server-authoritative spread** (chaingun bloom + sprinkler base cone): per-player `bloomSeq` counter seed (why `idSeed(shotId)` was the CSGO nospread hole), shared `jitter01`/`coneDir`/`bloomRadius` math, implementation map server→client→HUD arms, audit vs published best practice, rejected-intent drift residual |
| `_docs/2026-11-04_ANNOUNCER_CALLOUTS.md` | **Announcer callout density** — classics survey (Q3 ~8 → UT2004 40+) + our 40-chord generated inventory; recommended ~10 regular + 3 apex set, playback gating rules (serial, priority preempt, per-clip cooldown), generator licensing recap |
| `_docs/2026-10-18_CTF_BOT_BRAIN_PUG_AUDIT.md` | CTF bot brain vs PUG guide audit |
| `_docs/2026-10-18_NETCODE_OVERHAUL.md` | Netcode overhaul (2026-10-18) |
| `_docs/2026-10-21_NETCODE_GAP.md` | Netcode gap analysis vs production shooters |
| `_docs/2026-10-26_TRANSPORT_TIERS.md` | **Transport ladder reference** — WS+WT; why RTC left the auto ladder, what still uses it (pinned/netbots, p2p hosting), Firefox caveat |
| `_docs/2026-10-26_NATIVE_UDP_LANE.md` | **Native shell + raw-UDP lane** — Electrobun spike verified (ws→UDP relay), composite adopt-don't-race tier design, server UDP scope, prior art (NexQuake/Xepsa), LOC estimate |
| `_docs/2026-10-26_NATIVE_SHELL_CAPABILITIES.md` | **Native shell capability inventory** — what the webview wrapper buys beyond fullscreen+UDP: exclusive/GPU control, disk replays, presence/deep-links, PTT, telemetry, attestation; trap cards flagged |
| `_docs/2026-10-26_DESKTOP_ENGINE_STACK.md` | **Pure-desktop engine stack reference** — thin custom verdict: what already ports (MoveSim, shared sims, netcode, instancing), renderer picks (bgfx/wgpu/sokol), Jolt/Rapier physics floor, the "still reasonable" boundary that flips it to Unreal |
| `_docs/2026-10-27_PER_FRAME_INPUT.md` | **Per-frame input streaming for anti-cheat** — bandwidth math (+90% volatile up, still trivial), real costs (server CPU ×7 on hot path, variable cadence), bounded AC value; verdict: journal-on-demand audit beats always-on |
| `_docs/2026-10-25_PROJECTILE_PREDICTION_NETCODE.md` | Projectile prediction research + implementation — fake+real shell model, claim-carried spawn state (pos/dir/vel/fireAt), velocity-scaled reanchor blend, MaxPredictionPing gap |
| `_docs/2026-10-22_GRIND_LEADERBOARD.md` | Grind leaderboard design |
| `_docs/2026-10-22_SPECTATE_RELAY.md` | Spectator relay / OBS-server reference |
| `_docs/2026-10-22_REPLAY_DEMO_SYSTEMS.md` | Replay/demo systems across shipped games — Tribes .rec, TrueView, MVD, input replay; two-truth problem |
| `_docs/2026-10-22_DEMO_SOTA_COMPARISON.md` | SOTA replay systems (Dota2, SC2 takeover, Trackmania anticheat, QTV) vs .demo — capability matrix + pilots |
| `_docs/2026-10-23_OFFLINE_DESKTOP_RENDERER.md` | **Desktop demo→MP4 renderer design** — headless-Chrome CLI tier (mostly built), ffmpeg-pipe upgrade, Electron tier; packaging plan + gotchas |
| `_docs/2026-10-27_CLIP_TRUTH_VS_BEAUTY.md` | **Client vs server clip capture** — Cool Shots are prettier client-side but record player beliefs, not truth; CS:GO POV/GOTV split, OW killcam paradox, hybrid input+snapshot standard |
| `_docs/2026-10-27_WAN_EDGE_FORENSICS.md` | **WAN edge forensics** — 3-gate firewall (NSG→firewalld→socket), the silent-WT-death bug (advertise-port vs client's 443-guard), bare-restart env drop, ISP arbitrary-UDP egress filtering + test matrix, remote netbot battery |
| `_docs/2026-10-27_WAN_STRESS_240.md` | **WAN stress report** — 240 bots × 10 rooms on live OCI, join-pacing under the flood guard, measured CPU/RSS/NIC/socket shape, findings (join-burst > combat, HTTP keepalive lane doubles fds, ~2.4MB/conn) |
| `_docs/2026-10-27_NUCLEUS_NETCODE_REFERENCE.md` | **Nucleus (Fish-Net successor) feature-set reference** — full doc-tree dig: interest/Spawn-vs-Stop, spawn pacing, reconcile+replay, lag-comp view clamp, trust model, Pro/Free split; feature map vs ours + 6 ranked stealable ideas |
| `_docs/2026-10-28_BOOT_WATERFALL.md` | **TTS decode via permanent mark chain** — GLB rigParse ~1.7s is the connect starver (not worker boot or compile), wt cold-dial 2.5-3.2s vs 3s cap bug fixed, bin-drain starvation model, lever ranking |
| `_docs/2026-10-28_DEMO_VALIDATION.md` | **Demo validation oracle** — dual-capture demodiff end-to-end: binary-lane server recording, per-event hit/kill pairing, provable-delivery gating (cliStart/cliEnd/KILL-lane), the 6 real bugs it caught, run commands |
| `_docs/2026-10-28_CHEAT_SURFACE.md` | **Cheat surface audit** — netbot-grade fake clients: what authority blocks (fabricated damage/teleports), what works today (aimbots, distance-only ESP, sub-tolerance wiggle), effort table, the hardening ladder (occlusion culling, aim-anomaly, attestation limits) |
| `_docs/2026-10-27_DEMO_HMAP_DELTA.md` | **Demo heightmap greedy-delta design** — coarse u8 grid + sparse worst-error correction list (Garland-Heckbert without the TIN); preserves peaks exactly, rides inside HMAP |
| `_docs/2026-10-23_SKI_FLAT_OVERSPEED.md` | Ski flat-ground overspeed audit — measured per-class, uncapped accel + unscaled gate root cause, fix sketch |
| `_docs/2026-10-23_LOCAL_SHELL_SPAWN.md` | Local projectile spawn epochs — rewind-mirror tried & reverted (ping-dependent spawn feel); server-claims-muzzle is the correct fix if trajDiv regresses |
| `_docs/2026-10-23_REMOTE_THREE_TRUTHS.md` | Remote pos/ghost/wire-head trio — measured relationships, sim viewLagMs defect + p90 jitter estimator fixes; `_posdump.ts` probe |
| `_docs/2026-10-23_HUMANOID_GENERATION.md` | Agentic humanoid generation survey — primitive-plate generators, Blender-agent loops, parametric bodies (MPFB/SMPL), Dust3D implicit graph, AI text-to-3D, auto-riggers (Pinocchio→Make-It-Animatable); ranked for our rig/style |
| `_docs/2026-10-24_CCU_RESOURCE_BREAKDOWN.md` | Single-process CCU soak ladder (32→1024) + full resource breakdown: CPU, tick, memory, ingress/egress, event-loop delay; egress is the binding constraint |
| `_docs/2026-10-24_MINIMIZING_PER_ROOM_OVERHEAD.md` | Per-room overhead minimization for many small matches: multi-match rooms, sim gating, flattened tick path, hibernation, sharding; ordered by impact |
| `_docs/2026-10-24_GUNMETAL_BODY_BAKE.md` | Weapon wear/grime bake on body rigs — the cm-scale hang, uObjScale fix, clone re-arm, and per-asset tuning knobs |
| `_docs/2026-10-24_MECH_SILHOUETTE_TECHNIQUES.md` | Power-armor silhouette grammar for class-rig builders — construction philosophies, armor hierarchy, landmarks, and the variant row |
| `_docs/2026-10-25_MEDIUM_LINEUP_PROPOSAL.md` | Medium-class lineup proposal — rig constraints (82-bone cm-scale skeleton, joint map), four archetypes, build plan. Proposal only |
| `_docs/2026-10-25_IDLE_SLOPE_CREEP.md` | Idle-on-slope downhill creep — traction ran before gravity each step, one residue escaped; idle-only anticipate-gravity fix + non-regression surface |
| `_docs/2026-10-25_TICKRATE_REFERENCE.md` | Measured server tickrates (CS 64, Apex 20 official, Fortnite 30, BF5 60), why powers of two, Battle(non)sense story, KRIBES 60sim/20broadcast positioning |
| `_docs/2026-10-25_MOUSE_SENS.md` | cm/360 survey — Krunker 8.3 default, AAA defaults 10-21cm, pro medians 30-60cm; why we moved 1.0→0.8 (~12.5cm casual default) |
| `_docs/2026-10-25_PREMIUM_TICKRATE.md` | Monetization concept — $10 sub sponsors a 64/128Hz room; per-player/presence models rejected (p2w, AFK-mule); Hetzner cost math €0-27/room; CPU is the real constraint |
| `_docs/2026-10-25_PHANTOM_MOUSE_DELTA.md` | Chromium pointer-lock delta spikes — why magnitude clamps fail at high DPI, the layered fix (unadjustedMovement + neighbor isolation), edge cases |
| `_docs/2026-10-25_WIREIN_QOS.md` | Frozen-bots join bug — early queue's shared 512 cap dropped must-deliver init edges; per-lane QoS fix (JSON never drops, binary capped) |
| `_docs/2026-10-25_HMR_VS_BUILD.md` | Why build+preview beats HMR for a WebGL game — state can't swap, 0.6s rolldown builds, community consensus (Babylon/Parcel/Remix) |
| `_docs/2026-10-24_CHARACTER_TECHNIQUES_DEEP.md` | Round 2 — PS1/Quake-era tricks + 2025 agentic-3D pipelines, mapped to which techniques our builders already use and what's worth adding |
| `_docs/2026-10-24_PROFILING_HOTSPOTS.md` | 512-player soak CPU profile: phase + function hotspots; send/fanout/encoding dominate; prioritized optimization roadmap |
| `_docs/2026-10-24_CLASS_WEAPON_LOCKS.md` | Class-lock design: the caliber ladder (light=precision, medium=mid ordnance, heavy=siege), per-weapon rationale/pros/cons, exact-class vs floor lock choice |
| `_docs/2026-10-24_UNIVERSAL_WEAPONS.md` | Universal arsenal rundown — every non-class-locked weapon verified against weaponRows: signature trio, sidearm floor, belt-pool throws, placement rules + watch conditions |
| `_docs/2026-10-24_SKILLS_DEPLOYABLES.md` | Q-skill slot (8 skills), perks, and belt-priced deployables rundown — shared energy/belt economies, per-item pros/cons, watch list (turtle loops, cloak+satchel, niche overlaps) |
| `_docs/2026-10-24_DUEL_MODE_IDEAS.md` | Duel-mode design: held-token headhunt scoring tradeoffs + "Retribution" fuse (death-lights-a-comeback-fuse mechanic) |
| `_docs/2026-10-24_NETCODE_HEURISTIC_AUDIT.md` | Netcode heuristic audit — every guess/estimate needs a way to unbrick itself if it guessed wrong; per-mechanism fail-safety review |
| `_docs/2026-10-24_REMOTE_WARP_AUDIT.md` | Remote-player warp audit — where visible jumps originate (snapshot starvation, converge reseating) and the fix plan |
| `_docs/2026-10-24_SPRINKLER_CLASS_GATING.md` | Sprinkler stays universal, not light-only — gating rationale + the mobility-hose watch condition |
| `_docs/traps/2026-10-24_remote-interp-chases-fiction.md` | Trap: converge/DR steering chases the extrapolated (fictional) sample instead of server truth |
| `_docs/traps/2026-10-25_sweepStale-mass-reap-on-stall.md` | Trap: wall-clock staleness sweep mass-reaps live ribbons after a hidden-tab stall → zombie pushes + shared-slot trails |
| `_docs/traps/2026-10-31_audio-stop-pop.md` | Trap: bare `stop()` mid-waveform clicks — global 15ms fade patch in `audio.ts` beats patching every call site |
| `_docs/traps/2026-11-08_quat-runaway-aim-pitch.md` | Trap: non-unit bone quats run away exponentially on extreme aim pitch — procedural pose writes must normalize; repro via `_tools/_stretchprobe.ts` |
| `_docs/2026-11-05_BOT_WEAPON_USE_AUDIT.md` | Bot weapon-use audit — full cycle-table sweep: 16 commits (body-bounce, bodyArmTime gate, far-slot GL/bolt, situational sidearms, hose/disc orbits, flak+splash serves), pinned-bench board, remaining balance items |
| `_docs/2026-11-09_UI_BENCHMARK_AUDIT.md` | **UI benchmark vs browser-FPS greats** (Krunker prime, Narrow One): bones vs skin verdict — we win layout contract/tokens/rebinds, lose type cohesion/icons/restraint/juice; 6-item steal list ordered by impact for the restyle pass |
| `_docs/2026-11-09_CHEAP_GFX_TECHNIQUES.md` | **Aesthetic-per-millisecond GFX survey** — post/material/lighting tricks ranked by cost for our fused-grade WebGL2 pipeline: vignette, rim light, ramp-toon, unlit gradient albedo, analytic occluder AO, cell-noise screen fx, channel packing; plus the SSAO/full-res-bloom/nested-pass traps to avoid |
| `_docs/2026-11-09_ALWAYS_ON_EVOLVING_BOTS.md` | **Always-on + evolving bots plan** — research survey (tiered-sim is the industry pattern; production evolution = stats→smooth→mutate, not RL), inventory of what exists (skill matrix, heroTick, adaptOnRespawn, econOf), 3-phase design: reduced-rate zero-audience standing-room tick → persisted per-callsign ledger (HA%/energy) → clamped mutation of baseAxes/baseMove |
| `_docs/2026-11-09_INDIE_FOOTGUNS.md` | **Indie footgun survey** — compelled-but-harmful features: mechanics-that-don't-multiply, cinematic post defaults (motion blur), options bloat, tutorial machinery, sunk-cost retention, wrong-layer fixes, core-engine conflicts, progression padding; our standing avoids + active watch-items |
| `_docs/2026-11-07_MOAT_AUDIT.md` | Bundle-exposure audit + hardening plan: P2P authority sealed, remaining inventory ranked, import-boundary ratchet + static dev-tool gating as next steps |
| `_docs/2026-11-07_MAPLAB_REGEN_PERF.md` | **maplab regen autopsy** — Alt+Q prof-ring added; 1.9s@449² is all gen.ts math (mesh/shader ~60ms). Python sidecar (`_tools/bench/gen_bench.py`): numba≈WASM≈2–8× only, `prange` 29× on synth; priorityFlood heap-encoding bug found; ranked fixes (separable glacier, cached drainage, worker pool, draft grid) |
| `_docs/2026-11-07_SESSION_LOG.md` | Session log: capper fix, foreign-WIP batches, LAN/P2P exclusion, moat ratchet, offline ctx fills - commits, verified state, open items, lessons |
| `_docs/2026-11-07_MAPSHOT_BLIND_SHOTS.md` | check.sh mapshot step runs without E2E_GPU - captured 4KB black JOINING screens while gate passed; GPU rerun renders fine but logs a persistent 123m SNAP-correction storm (staging warp vs authority shadow, journal=0); fix options + bisect note |
| `_docs/2026-11-04_LAUNCH_AUDIT.md` | Launch re-audit vs `2026-10-08_BETA_AUDIT.md` — most Oct-8 items landed; remaining: one legal item, infra provisioning, live-verification debt, thin moderation |
| `_docs/2026-11-08_TECH_DEBT_AUDIT.md` | Full-tree debt audit via repo tooling (knip etc.) — every number names its command; warnings are candidates, verify before deleting |
| `_docs/2026-11-01_20261101084019_UNWRAP.md` | UV-unwrap SOTA for bake maps — xatlas/xatlas-three, uvunwrap (Rust→wasm, texels-per-unit density), and the in-repo precedent: `vertexAO.ts` wear-mask atlas already does detached per-tri cells |
| `_docs/2026-11-08_AGENT_GATE_SOTA.md` | Agent-gate tooling survey — machine-readable verdicts (verdict.json + hint, strict exit codes), affected-test scoping, latency-layered gate stack vs our check.sh/pre-commit/sweep |
| `_docs/2026-11-08_WEAPON_MODEL_REVIEW.md` | All 27 weapon viewmodels ranked best→worst from gunsheet 4-up sheets — Revolver/Railgun/Chaingun top, Pistol/Mortar/Disc bottom; fast-disc groove+liner fixes, gunlab Implodisc filter, mkWeaponSel `.keys()` bug, rework shortlist |
| `_docs/2026-11-08_VIEWMODEL_AND_MARKER_FIXES.md` | Session changelog for the viewmodel batch + runtime bugs — Blaster/Pistol reworks (pistol_v1 archived), 512² sheets + bounding-box cell fit, IFF marker flicker (duplicate headhuntBadges writer), frozen-corpse `process.env` crash in shared/botGoals |
| `_docs/2026-11-09_BUZZARD.md` | Buzzard port report — ambient decor made a server-owned fly-family creature: `creatures` pops, shared `stepFlyer` both ends, 6s shooter-grudge brain, `attachField` fix that un-dead creature spawns on terrain maps, stat-fidelity audit + gaps |

## Agent memory (append-only, one line each)

- `.agents/memory/corrections.md` — "got this wrong → rule"
- `.agents/memory/decisions.md` — "chose X over Y because Z"

## Concepts (design philosophy — mostly stable)

`concepts/` — 17 files + `README.md`: `movement.md`, `skiing.md`, `bots.md`, `netcode.md`,
`demo-system.md`, `enemies.md`, `feel-vfx.md`, `footprint-conforming.md`,
`projectile-inheritance.md`, `proxy-hitbox.md`, `skills.md`,
`terrain-gen.md`, `turretter.md`, `ballistic-solver.md`, `killcam.md`,
`netcode-remote-render-truth.md`, `anim-rig-conventions.md`.
Mostly 2026-09-27 baseline; `terrain-gen.md` updated 2026-10-16;
`killcam.md`, `netcode-remote-render-truth.md`, `anim-rig-conventions.md`
added 2026-10-22; `netcode.md` rewritten 2026-10-31 (master reference:
tick pipeline, sub-tick claims, shadow sims, rewind, fanout, lanes).

## Traps (gotchas — read before touching the area)

`_docs/traps/` — 13 files: bloom black frames, T2 map porting, updateRanges
first-shot-only, bloom composite is raw, filter-repo eats worktree,
hip-yaw local-vs-world (rotated armature parents break local-quat facing
measures), remote-interp-chases-fiction (converge steering toward the
extrapolated sample = model sprints ahead of wire truth during starves),
quat-runaway-aim-pitch (non-unit bone quats self-amplify into 1e10m
skeleton stretch on near-vertical aim — normalize procedural quat writes).

## Workflows

`_docs/workflows/beta-launch.md`, `_docs/workflows/robustify-round.md`.

## Client design reports

`client/reports/` — 8 files: architecture-review, decoupled-sim-rate,
demo-anti-tampering-design, demo-system-robustness-plan, hybrid-demo-format-design,
lean-anti-tamper-validation, server-side-recording-efficiency. Plus
`client/src/demo/FORMAT.md` (the .demo file format).

## _docs/ research archive (point-in-time, NOT current)

`_docs/` holds ~200 top-level files. **Treat anything dated before the latest
session as historical research, not ground truth** — the living docs above
supersede them. Subdirectories:
- `_docs/GAMES/`, `_docs/OLD/`, `_docs/ROBUSTIFY/`, `_docs/UPHEAVAL/` — archived batches
- `_docs/reports/` — ~20 dated point-in-time reports (June–July: naia, demo
  system, backend evals, multiplayer reviews)
- `_docs/reference/` (incl. `tribesxt/`) — external reference material
- `_docs/2026-06-*.md` … `2026-10-*.md` — dated research reports and session notes

Highlights still worth reading: `NETCODE_DEEP_DIVE_2..9`, `BOT_NAV_ORBITS`,
`BOT_EVOLUTION_RESEARCH`, `JET_ENERGY_ECONOMY`, `TERRAIN_COMPILE_STALL`,
`UNIFY_OFFLINE_NET`. The `SESSION_*.md` and `2026-06-*` files are the
most likely to be stale.

## Reference / external

- `_reference/tribes-physics`, `_docs/reference/tribesxt` — Tribes physics reference
- Tribes installs on disk (see AGENTS.md "Tribes reference installs")

## _tools/

`_tools/README.md` (pipeline vs scratch), `io_dif/README.md`,
`animpacks/README.md`. The rest of `_tools/` is scripts + scratch output
(mostly gitignored: `devin_scratch/`, `sweeps/out/`, `e2e/shots/`, etc.).

## _zzz/

Archived reference projects (babylon, rundot, sprunk, colyseus, fastapi) —
not part of the game.

## Missing / known gaps

- **No master index existed before this file** — that's why it was added.
- `concepts/` and `client/reports/` have no "current vs superseded" markers.
- `docs/SESSION_2026-10-01.md` and `SESSION_2026-10-10.md` are stale
  session notes superseded by the living docs and changelog.
- `_docs/NOTES.md` and `_docs/TASKS.md` are loose scratchpads; prefer ROADMAP.md +
  `_docs/2026-10-15_CAPPER_STRIKE.md` for current state.

## Stale / superseded (review before relying)

- `docs/SESSION_2026-10-01.md`, `docs/SESSION_2026-10-10.md` — **archived** to
  `_docs/OLD/` (session notes superseded by ROADMAP + changelog +
  `_docs/2026-10-15_CAPPER_STRIKE.md`).
- `docs/BOT_AI_REFERENCE.md`, `docs/BOT_SOTA_PLAN.md` (2026-10-02) —
  **archived** to `_docs/OLD/` (point-in-time bot plans).
- `concepts/` — design philosophy, mostly 2026-09-27 baseline; treat
  specifics as stale until re-verified. Now has a `README.md`.
- `client/reports/` — 8 design reports (Oct 16), point-in-time. Now has a
  `README.md`.
- `_docs/` dated research reports (`2026-06-*`, `2026-09-*`,
  `2026-10-0[1-9]`) are historical; prefer the `2026-10-1[5-9]` and
  `2026-10-2[0-2]` entries plus the living docs above.
- `_docs/GAMES/`, `_docs/OLD/`, `_docs/reference/`, `_docs/ROBUSTIFY/`,
  `_docs/UPHEAVAL/` — archived batches; read only for historical context.