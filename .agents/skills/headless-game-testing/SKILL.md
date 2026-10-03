---
name: headless-game-testing
description: How to E2E-test the FPSWebTest Three.js game headlessly (locked/unavailable desktop) using puppeteer-core + installed Chrome, including pointer-lock stub, window.__test hook pattern, and slow game-time caveats.
---

# Headless E2E testing of FPSWebTest (Three.js FPS)

Use when the Windows desktop is locked/unusable or you need scripted gameplay.

## Dev server

`cd client && npm run dev` — vite, default port 5400 but it auto-increments
(5400/5401 may be taken by other sessions; read the actual port from vite output).

## Browser

- Use `puppeteer-core` (install in a scratch dir, NOT the repo) with the system
  Chrome: `C:\Program Files\Google\Chrome\Application\chrome.exe`.
- Args: `--headless=new` is default `headless:true`; WebGL needs
  `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --mute-audio --no-sandbox`.

## Pointer lock stub (required)

Headless Chrome has no real pointer lock. Inject via `page.evaluateOnNewDocument`
BEFORE `goto` (store the element requestPointerLock was called on — the game
compares `pointerLockElement === rendererCanvas`, so returning the wrong element
makes it think it's never locked and the ESC menu never opens):

```js
window.__lockedEl = null;
Object.defineProperty(Document.prototype, 'pointerLockElement', {
  get() { return window.__lockedEl; }, configurable: true });
Element.prototype.requestPointerLock = function () {
  window.__lockedEl = this;
  queueMicrotask(() => document.dispatchEvent(new Event('pointerlockchange')));
  return Promise.resolve(); };
document.exitPointerLock = function () {
  window.__lockedEl = null;
  queueMicrotask(() => document.dispatchEvent(new Event('pointerlockchange'))); };
```

## Reaching game internals

Game objects are module-scoped. Temporarily add to `client/src/main.ts` after
init (REVERT after testing):
`(window).__test = { demoManager, player, entities, world, rendererCanvas: renderer.domElement };`

## Input

- Fire: `document.dispatchEvent(new MouseEvent('mousedown', {button:0}))` —
  works because input.ts gates on `document.pointerLockElement`, not trusted events.
- Keys: `page.keyboard.press('Escape' | 'ArrowLeft' | 'Space' ...)` — real CDP
  events hit the document keydown/keyup handlers.
- Cool-shot items: `#cool-shots-top .cool-shot-item`, click via DOM dispatch.

## Caveats

- Game time runs ~7x slower than wall clock under SwiftShader — waits tied to
  in-game seconds (e.g. 5s clip-extraction buffer) need ~35-40s wall; poll
  `demoManager.recorder.duration` rather than assuming wall time.
- Landing a real hit: balls spawn 100-200m away moving fast — pin one via
  `setInterval` overriding `ball.pos`/`ball.vel`, aim with
  `player.yaw = atan2(dx,dz)`, `player.pitch = asin(dy/d)` (projectiles spawn at
  `player.pos`, forward = `(cos p·sin y, sin p, cos p·cos y)`).
- `hitBall` (direct contact) is what triggers `autoClipOnHit`; AOE splash kills
  a ball WITHOUT scheduling a clip.
- Logger console threshold is WARN — `logger.info`/`debug` lines (e.g.
  `[CoolShot] hit ball`, `Clip scheduled`) do NOT appear in page console; assert
  via `demoManager.getCoolShots()` / `coolShotMgr.pendingClips` instead.
- Legacy .demo fixtures live in `server_bun/demos/` (format v2); current writes
  are v3 (`DEMO_FORMAT_VERSION` in `client/src/demo/types.ts`).
- Working example scripts: `C:\TEMP\_WEB\headless-test\demo-e2e.js`,
  `probe2.js`, `legacy-play.js`.

## Server-side bots (multiplayer testing)

- Start server: `export PATH="$HOME/.bun/bin:$PATH" && cd server_bun && bun run src/server.ts`
  (port :8000). `curl localhost:8000/metrics` lists rooms/player counts.
  Watch for `EADDRINUSE` — stale sockets from other processes (e.g. wpscloudsvr.exe)
  can hold :8000; check `netstat -ano | grep :8000` and kill the owning PID.
- Join a bot room: `?room=<name>&map=<map>&bots=N` — join handshake forwards
  room/map/bots; `spec.botFill` is TOTAL bodies incl. humans, so bots spawned =
  botFill − humans. Add `networkManager` to the `__test` hook to inspect.
- Server bot ids are `BOT-<roomname><idx>` (NOT `bot:` — that prefix is the
  offline TeamBots namespace). They live in `world.remotePlayers` keyed by id.
- Interpolation check: `rp.position` is the rendered/interpolated pos,
  `rp.targetPosition` is the latest wire snapshot — compare them; snapshot
  arrival means `rp.update()` fires, movement means `rp.tick()` fires
  (instrument by wrapping methods — a frozen `position` with moving
  `targetPosition` indicates a client-side interp/staleness bug).
- Watch out: `remotes.ts` marks remotes inactive when `ping == null`; server
  bots never report ping (GameServer broadcasts `ping` only when `p.ping > 0`),
  so they can be stale-hidden — check `rp.scale`/model visibility, not just
  position.
- In-game spectate is the V key (`spectate` keybind → `#spectate-hint` shows
  "SPECTATING"); there is no `spectate:true` handshake from the client.

## Devin Secrets Needed

- none for offline testing. The game server (:8000) is optional — connect
  failures are warnings only and cool-shot upload/list degrades gracefully.
