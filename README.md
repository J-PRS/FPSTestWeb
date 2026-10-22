# KRIBES

Browser multiplayer FPS: **Tribes gameplay, Krunker performance and
accessibility.** Skiing, jetpacks, spinfusor combat, base assets — in a
browser tab, fast enough for any laptop. Three.js client, Bun server
(WS/WebTransport/RTC), shared deterministic sims.

## Start here

- **Agents / contributors:** read [`AGENTS.md`](AGENTS.md) first — commands,
  layout, rules of the road, and the definition of done.
- **Living manifesto:** [`ROADMAP.md`](ROADMAP.md) — read first, keep current.
- **Changelog:** [`changelog.txt`](changelog.txt) — prepend
  `YYYY-MM-DD - <summary>` ASCII per settled topic.
- **Doc catalog:** [`_docs/INDEX.md`](_docs/INDEX.md) — map of the 140+ docs
  (living vs. archived). Read it before hunting in `_docs/`.
- **Agent memory:** `.agents/memory/corrections.md` (gotchas) and
  `decisions.md` (choices + rationale) — append-only, one line each.

## Commands

```bash
cd server_bun && bun test                        # server tests — must stay green
cd server_bun && bun test tests/scenarios/       # gameplay scenario tests
cd client && ./node_modules/.bin/tsc --noEmit    # client typecheck
cd client && ./node_modules/.bin/vitest run      # client tests
cd client && npx -y oxlint src                   # lint
bash _tools/check.sh                             # DEFINITION OF DONE
```

## Ports

- Game client (Vite): **:5400**
- Game server (Bun): **:8000**
- `:5173` is a different project — not the game.

## Layout

- `shared/` — sims + protocol used by both ends (deterministic).
- `server_bun/src/` — authority (Room, CombatHandler, CreatureSim, ServerBots).
- `client/src/` — render, prediction, HUD/menus, netHandlers.
- `maps/` — spec JSONs.
- `_tools/` — soaks + headless capture + sweeps.
- `_docs/` — research archive + living references (see INDEX.md).
- `_zzz/` — archived reference projects (not part of the game).

See `AGENTS.md` for filename conventions, rules, and the full guide.