# KRIBES — Full Overview & Roadmap

*Snapshot of the codebase post tech-debt passes 1–15 (state as of 2026-09-26).*

## What the game is

Browser multiplayer FPS: Tribes movement (ski + jetpack + diskjump-style knockback surfing) × Krunker instant-join. Three.js client, Bun WebSocket server, custom everything — terrain shader with height fog, atmospheric sky, binary wire protocol, demo recording with auto "cool shots" clips.

## What it has now (the actual inventory)

**Combat**
- 7+ projectile weapons (rocket, disc, grenade, mortar, GL, plasma, flak, chaingun) — each a small config file; shared stats table in `shared/weapons.ts` is the single source of truth client+server
- Two-tier hit detection: core hitbox + expanding "wake" proxy (0→8m over 2s) — the noob-friendly mechanic; server validates hit claims against tracked projectile trajectories
- AOE blasts (validated, bound to projectiles), slam skill, disc pull-impulse, knockback with client prediction + server correction
- Skills: dash, slam, bounce — impulse-based, all routed through the movement controller

**Enemies (PvE layer)** — a genuinely good roster, each teaches one skill:
Crawler (punish ground/backpedal), Seeker (punish straight-line flight), Rakk (flock + attack token), Totem (strafe check / sniper), Turretter (airshot skill check), Miner+Mine (area denial, priority targeting), elite balls (kill-close = two babies). WaveDirector with credit pool + minute-gated unlocks + scripted beats.

**Multiplayer**
- 20Hz binary tick frames (~39B/player), delta suppression via dead-reckoning tolerance, distance interest tiers (150m/400m/∞), idle reap + stale heartbeat
- Client: snapshot-buffer interpolation with adaptive jitter delay, Hermite smoothing, dead reckoning at ~2 missed packets
- Session tokens + F5 grace reconnect, protocol version gating with force-reload
- Anti-cheat: trajectory-validated hit claims, spawn sanity, velocity caps, rate limiting

**Meta systems**
- Demo recording: binary format, circular buffer, keyframe events
- Cool shots: auto-clip on hit (5s before/5s after), chain-combo merging, server upload/list/download
- Nugget pickups, scoreboard, frag messages, health bars, damage numbers

**Remaining rough edges (known)**
- RemotePlayer green debug ring + collider gizmo render in normal play
- Enemies are per-mesh — swarm perf will hit a draw-call wall before AI cost
- Client tests exist (20 vitest) but thin; gameplay code mostly untested
- Hit validation is trajectory-legal but bounce-shots (GL/mortar) still exploitably loose
- ~110 uncommitted WIP files need a commit-or-discard pass

## What to change

1. **Commit or prune the WIP tree** — biggest hygiene risk left; ~110 files sit uncommitted (Turretter, waveDirector, viewmodel, effects). Harder to sweep safely every pass.
2. **Gate debug visuals** — gizmo ring, collider boxes behind `?debug`.
3. **Enemy instancing** — one InstancedMesh per species; unlocks 10x swarm counts. This is the single biggest perf/feature unlock available.
4. **Wake-hit damage falloff** — wake hits currently full damage; 50–70% keeps the skill gradient without removing the forgiveness.
5. **Enemy targeting beyond "the player"** — enemies target a single player reference; real multiplayer needs nearest-player or threat-based selection, else PvPvE breaks.
6. **Bounce-claim validation** — GL/mortar hits on ricochet pass the airtime check; needs a bounce-aware reach model or per-bounce events.

## What to add (roughly ordered by leverage)

1. **Cold-start bots** — the #1 killer of browser FPS is empty servers. Reuse the existing enemy AI as "player-ish" bots; even dumb skiing bots make a 1-player server feel alive.
2. **Match/round structure** — FFA-with-score is fine for testing but retention needs a loop: waves-complete, KOTH hill, or CTF flag (Tribes = CTF, and you already have flag-shaped systems: nuggets = pickups).
3. **CTF** — the authentic Tribes mode and the biggest differentiator vs Krunker/Narrow.One clones. Flag = a Targetable with carry/cap rules; skiing + flag-running is THE fantasy.
4. **Name + loadout selection on join** — needed before real players; also closes the playerId-charset innerHTML fragility for free.
5. **The Skier enemy** (from our brainstorm) — an enemy that out-skis you downhill and must be chased at speed; weaponizes your movement as counterplay.
6. **Clip sharing** — you already have server-side demo upload; a `?clip=xxx` join link that auto-plays a cool shot is cheap now and is organic marketing.
7. **SteamDeck/mobile controller layer** — optional, later.

## Path options

- **Community game track** (cheapest): fix WIP+debug visuals → instancing → bots → CTF → ship on itch + your own URL. Post cool-shot clips to Tribes/ shooters communities.
- **Portal track**: polish single-player wave mode hard (it's already the fun loop) → Poki/CrazyGames exclusive → their UA does the marketing.
- **Commercial track**: not yet — needs retention loop + cosmetics economy first.

My honest recommendation: do the bot pass and CTF next. Bots make every empty server playable; CTF makes it *yours* instead of "another Krunker clone". Both reuse systems you already have.
