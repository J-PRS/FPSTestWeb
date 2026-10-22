# Industry Lessons for a Web FPS Stack

**Date:** 2026-09-26
**Scope:** What shipped web games and the current ecosystem teach us about our stack choices (Three.js client, Bun server, WebSocket transport, client-authoritative netcode). Companion to `2026-09-26_BACKENDS.md`.

---

## 1. Three.js is the pragmatic answer to "code-first 3D"

**Consensus from ecosystem research:** Three.js is a rendering library, not a game engine — the official docs say so explicitly. The gap (physics, input, ECS, no editor) is either freedom or yak-shaving depending on the team. For us it's freedom: every mechanic is readable TS, nothing hidden behind an engine, and the whole project is AI-editable plain files.

**Why there's no real desktop equivalent:** not because web is better, but because web was *worse* — no editor ecosystem existed, so the library form had to carry everything and the community poured decades into one library instead of fragmenting. Desktop coalesced around editors (Unity/Unreal/Godot) because that's what shipped-game teams needed.

**Alternatives surveyed:**
- **Godot** — `.tscn`/`.gd` are plain text, most AI-editable of the big engines, but the workflow still assumes the editor.
- **Bevy** — fully code-first, but inherits Rust's bill: borrow-checker friction in the worst domain for ownership rules, 10–60s compile times vs our ms hot-reload. The perf headroom it buys is unused at indie scale.
- **Heaps.io (Haxe)** — real shipped pedigree but *narrow*: Dead Cells (Motion Twin) and Northgard (Shiro) are essentially one extended family around Haxe/HashLink creator Nicolas Cannasse. Proves it works for insiders; docs/community thin for outsiders.
- **LÖVE + 3DreamEngine / raylib** — file-based, instant reload, but community-grade 3D.
- **AI-native engines** (nAIVE, droids, SpawnForge) — interesting but early; all YAML/MCP demos, nothing shipped. Watch, don't adopt.

**Verdict:** our stack (Vite + TS + three + postprocessing) is the mainstream optimum for an AI-driven, file-based, iterate-screenshot loop.

---

## 2. Desktop games DO ship on Three.js — via wrappers

Real Steam releases on the exact one-codebase → Electron pattern:

| Game | Notes |
|---|---|
| Savanna Sam | Solo dev, Electron → Steam, runs on Steam Deck |
| Task Unit | Multiplayer tactical shooter; Three.js + Rapier + Socket.IO, Electron → Steam Early Access; **built solo by directing AI agents** |
| Might is Right | 4-year turn-based strategy, Steam + online demo |
| Starshot Genesis | Space arcade shooter, Steam 2026 |
| Terminus Breach | Three.js WebGPU; Electron (macOS) + Capacitor (Android) |

Nobody rewrites for native. The browser build IS the product; desktop is an Electron wrapper. Electron is "stupid" (~150MB Chromium for a canvas) but it's what shipped — and for a game whose home is a URL anyway, correct.

---

## 3. Krunker's architecture was a business decision

Sidney de Vries's stack (WebSocket/TCP, ~10Hz tick, client-authoritative) was chosen for cost and operability, not technical superiority:

- **10Hz tick = 2–4x more rooms per VPS.** Server CPU is the scarce resource; tick rate is the multiplier.
- **Client-authoritative + no server physics = the server is a relay.** A relay is ~10x cheaper per player than a simulating authoritative server — simulation cost is outsourced to players' machines.
- **At launch (2018–19) TCP was the only sane option** — server-side WebRTC was a nightmare, WebTransport didn't exist in browsers until Chrome 97 (2022).
- **Client-side tricks cover the weakness**: prediction + attacker-side hits mean most players never notice. Lossy-connection HOL stalls hit a minority.

The trap to remember: **unit economics** — cheap-per-player × thousands of concurrent = real monthly bill, and free web games return near-zero ARPU. Keep per-player cost near zero as a design constraint (cheap tick, relay server, client does work). That's what we built; it's priced correctly.

---

## 4. Narrow One (Pelican Party) — the playbook to copy

Two devs, 200M+ lifetime players:

- **Client:** Three.js (Jesper: "a lot like Unity except for the editor parts... the thing you're developing in is already the web"). Now building own engine (Renda) *after* proving the game.
- **Servers:** $4/mo DigitalOcean droplets, ~200 players/box, ~$36/mo for 1,000 concurrent. Autoscaling = a small monitor app calling DO's API (boot at 200, kill at 100) — a shell script, not Kubernetes.
- **Edge:** Cloudflare free tier CDN/proxy/DDoS + a second domain (`narrow-one.io`) so school/work filters don't block everything.
- **Matchmaking as netcode:** scored server pick by geo-proximity, Elo skill, and map-already-downloaded. Region-pinning saves more ms than any transport trick.
- **Distribution:** exclusive Poki partnership — clean SDK, they drive traffic, even host game servers.
- **Load-time engineering > netcode engineering:** tiny map first, stream real map in background, defer skin downloads. "Player doesn't bounce" beats "packet arrives sooner."
- **Game design covers the netcode:** slow arcing projectiles + prediction + small 5v5 rooms = WebSocket is fine.

### Actionable for us
- Our architecture already matches: client prediction, relay-ish server, small rooms, slow projectiles.
- `?server=` / `server.json` endpoint discovery → point at nearest droplet later.
- Chaingun is our outlier: fast small projectiles are where TCP HOL hurts most — watch it, or prefer projectile-based weapons by design.
- First infra code worth writing past dev: the boot/shutdown droplet monitor.

---

## 5. Transport reality check (the actual FPS bottleneck)

Browsers give three options:

| Transport | Server CPU | Under packet loss | Support | Verdict |
|---|---|---|---|---|
| WebSocket (TCP) | cheapest | bad (head-of-line blocking) | universal | what we have — fine at our scale |
| WebRTC DataChannels | heaviest (ICE/DTLS/SRTP server-side) | good | universal | geckos.io exists; clunky server-side |
| WebTransport | middle | good | Chrome/FF/new Safari | the "right" answer, young servers |

- "UDP is more expensive" is mostly myth — raw UDP is *cheaper* than TCP (no ACK/retransmission state). The cost truth for browsers is that UDP-semantics means WebRTC/WebTransport, which add handshake+encryption CPU per connection. At our scale (16 players × 20Hz) all differences are noise; egress billing is per-GB either way.
- NSDI 2025 evaluation confirms WebTransport/WebRTC datagrams handle loss far better than WebSocket for twitch games — but our dead-reckoning (extrapolation ≤200ms + physics sim after 300ms + blend-on-recovery) already covers stalls plausibly.
- Upgrade path is contained: `INetworkAdapter` abstracts transport; prediction/reconciliation is transport-agnostic.

| If the problem is... | Move to |
|---|---|
| TCP head-of-line latency | geckos.io (WebRTC) or WebTransport server |
| Bun runtime bugs/scale | Node + uWebSockets.js (uWS upstream claims ~80% faster than Bun; small port) |
| Matchmaking/social/economy | Nakama (Go backend, TS scripting runtime) |
| Global fleet hosting | Hathora (runs your own server binary) |

---

## 6. Bun server verdict

- WS layer is uWebSockets under the hood: ~700k msg/s vs ~100k Node+ws in Bun's bench; community benchmarks ~6–8x `ws`. Node+uWS still wins at extreme scale (~1.9x).
- Built-in pub/sub topics, `ws.data` zero-alloc per-conn state, native TS, single binary — cleanest same-language story that exists for an authoritative TS server.
- Caveats: single-threaded event loop (fine — process-per-instance is the normal game-server model), maturity complaints (patch regressions, some long-standing memory leaks). **Pin the Bun version, watch memory.** Port to Node+uWS is a small diff if it ever bites.

---

## References

- Three.js "Making a Game" (not a game engine): https://threejs.org/manual/en/game.html
- Narrow One server/matchmaking devlog: https://pelicanparty.itch.io/narrow-one/devlog/536795/spilling-our-trade-secrets-narrow-one-updates-
- Pelican Party / Poki dev story (Three.js quote): https://poki.com/blog/pelican-party-creators-of-narrow-one
- Narrow One showcase (Renda engine): https://www.webgpu.com/showcase/narrow-one-multiplayer-archery-webgl/
- Bun WebSocket docs + benchmark: https://bun.com/docs/runtime/http/websockets
- uWS-vs-Bun bench discussion: https://github.com/oven-sh/bun/issues/9551
- Socket.IO server benchmark (node-uws wins): https://dev.to/sahaj-b/benchmarking-socketio-servers-4n9k
- Bun WS gameserver reference impl: https://github.com/mavisakalyan/bun-ws-gameserver
- NSDI 2025 browser netcode eval (WS vs WebRTC vs WebTransport): https://aaron.gember-jacobson.com/docs/nsdi2025browser-networking.pdf
- Godot WebTransport proposal (good transport overview): https://github.com/godotengine/godot-proposals/issues/3899
- Elura (Rust, WebTransport + lag-comp primitives): https://github.com/Arion-Dsh/elura
- Nakama authoritative backend: https://heroiclabs.com/nakama/
- Steam Three.js examples: Savanna Sam dev post https://discourse.threejs.org/t/3d-action-browser-game-made-with-three-js-savanna-sam/81902 ; Task Unit https://threejsresources.com/tool/task-unit ; Starshot Genesis https://store.steampowered.com/app/4425750/Starshot_Genesis/
- Related internal docs: `2026-06-11_NETWORKING.md`, `2026-06-21_CLIENT_AUTHORITATIVE_NETWORKING.md`, `GAMES/narrow-one-infrastructure-report.md`, `2026-09-26_BACKENDS.md`
