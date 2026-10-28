# FPSWebTest — commentary (browser multiplayer FPS)

> Subject: `C:\TEMP\_WEB\FPSWebTest` — browser multiplayer FPS, the web sibling
> of FPS_Test (Unity). three.js/TS client, Bun server, server-authoritative
> rooms-as-matches, binary wire protocol, WebTransport/RTC/WS lanes, lag comp
> with rewind, TOML map specs, autopilot bots, public-beta deploy path via
> Dockerfile+Cloudflare. Has `_docs/` with ~100 reports.
> Hub pointer/summary.

---

## 1. What it is

**FPSWebTest** is a browser-based multiplayer FPS — the web sibling of FPS_Test
(Unity). Same game idea, different platform: three.js/TS client, Bun server,
server-authoritative rooms-as-matches, binary wire protocol, WebTransport/RTC/WS
transport lanes, lag compensation with rewind, TOML map specs, autopilot bots,
and a public-beta deploy path via Dockerfile+Cloudflare.

## 2. Architecture

- **Client**: three.js/TS with prediction, gunlab/maplab tools.
- **Server**: Bun (JavaScript runtime), server-authoritative rooms-as-matches.
- **Wire protocol**: binary (not JSON) for performance.
- **Transport**: WebTransport (preferred), WebRTC, WebSocket fallback — multiple
  lanes for different data types.
- **Lag comp**: server-side rewind for hit registration.
- **Maps**: TOML map specs (declarative level definitions).
- **Bots**: autopilot bots for testing/training.
- **Deploy**: Dockerfile + Cloudflare (public-beta path).

## 3. What's unique / cool

- **Server-authoritative with rewind**: the server owns hit registration and
  rewinds to the shooter's view for lag compensation — a full netcode
  implementation in a browser game.
- **Multi-transport**: WebTransport (preferred) → WebRTC → WebSocket fallback,
  with different lanes for different data types. This is transport-tier
  engineering.
- **Binary wire protocol**: not JSON — a custom binary protocol for
  performance-critical game data.
- **TOML map specs**: declarative level definitions, not hardcoded geometry.
- **Autopilot bots**: AI bots for testing and training, with behavior trees.
- **"Robustify round" dev loop**: a structured development process (documented
  in `_docs/`) where each round robustifies the codebase.
- **100+ research reports**: netcode deep dives (1-9), deploy beta, bots-as-
  players, transport tiers, terrain, animation, profiling, etc. The most
  *researched* project in the portfolio.
- **The through-line**: FPSWebTest is the "web platform" pillar — alongside
  FPS_Test (Unity) and RocketMastery (first game). "Same game, different
  platform, deeper netcode."

## 4. Cross-references

- Location: `C:\TEMP\_WEB\FPSWebTest`.
- Variants: `FPSWebTest-restore`, `_fps_head`, `_tools`, `reference`.
- Unity sibling: `D:\[Projects]\FPS_Test`.
- `C:\TEMP\_BROWSER_EXTENSIONS\UM_Main\docs\projects.md` — portfolio entry.

---

*Hub pointer. The project's own docs are authoritative.*