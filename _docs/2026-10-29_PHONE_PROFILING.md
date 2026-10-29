# Phone profiling — real-device WebGL benchmark over USB

> Status 2026-10-29: pipeline BUILT and verified end-to-end; first real
> numbers still pending post-fix re-run (see "First result found a real
> bug" — the fix is in `core/renderer.ts`, uncommitted at write time).

Profiling the game on a physical phone answers a question desktop can't:
does the GPU driver + thermal envelope survive a real match? The test
device is a **Redmi K70** (`23113RKC6G`, codename `vermeer`): Snapdragon
8 Gen 2, Adreno 740, 12–16 GB, 1440×3200 @120Hz — mid-to-high phone,
roughly Intel-N100-class CPU with a stronger GPU. Adreno is also a real
ANGLE/Vulkan driver path, not desktop GL — it surfaces bugs desktop
hides (the canvas clamp below is exhibit A).

## The pipeline

```
USB cable
  ├─ adb reverse tcp:5400 tcp:5400   phone localhost:5400 → PC vite dev
  ├─ adb reverse tcp:8000 tcp:8000   phone localhost:8000 → PC game server
  └─ adb forward tcp:9333 localabstract:chrome_devtools_remote
                                     PC :9333 → phone Chrome DevTools
```

Then a bun script attaches with **playwright-core**
(`chromium.connectOverCDP('http://localhost:9333')` — playwright-core is
the root dep; puppeteer-core is NOT installed at root). Full CDP on the
real device: `page.evaluate`, `page.goto`, `page.screenshot`,
`Performance.getMetrics`, `Tracing.start`, console/pageerror listeners.

## Scripts (all `_tools/e2e/`)

- `_phoneprof.ts [wallSecs]` — the profiler. Attaches, injects a rAF
  frame-time recorder (self-healing across navigations), waits for
  `__test.playerId`, samples `Performance.getMetrics` + rAF fps + heap +
  `__test` state every 15s, records one 15s `devtools.timeline` trace
  mid-run and prints top functions, screenshots at end.
- `_phonedbg.ts` — attach + page state + GL state (`isContextLost`,
  canvas size, `__renderer.info`) + console error tail.
- `_phonedbg2.ts` — is the render loop alive (rAF count in 3s), canvas
  inventory, overlay/pointer-lock state.
- `_phonedbg3.ts` — DPR / innerWidth / `maxTextureSize` / every canvas's
  size+owner / renderer canvas+pixelRatio.
- `_phonereload.ts` — reload the tab, wait for `__test.playerId`, sample
  a 120-frame burst. The quick post-fix verify.
- `_targets.js` (`_tools/devin_scratch/`) — `bun _targets.js 9333` lists
  every CDP target on the phone (page urls + ws endpoints).

## Launch the game on the phone

```bat
rem 1. stack up (vite :5400 + bun :8000)
devup.bat --no-reap --no-logs

rem 2. tunnels
adb reverse tcp:5400 tcp:5400
adb reverse tcp:8000 tcp:8000

rem 3. open the browser — EITHER launch a URL:
adb shell am start -a android.intent.action.VIEW -d "http://localhost:5400/quickjoin"
rem ...OR (better, avoids cmd-quoting) open anything then let the script
rem navigate: page.goto('http://localhost:5400/quickjoin?server=127.0.0.1:8000&mode=ctf&bots=16')

rem 4. devtools + profile
adb forward tcp:9333 localabstract:chrome_devtools_remote
bun _tools/e2e/_phoneprof.ts 120
```

`/quickjoin` hits the matchmaker (`/join`) and lands the tab on the
canonical `/s/<room>` path — the params it takes are the same `?server=`
`mode=` `bots=` the client's own urlParams understand.

## Gotchas discovered (in order of time wasted)

1. **`am start` URL + `&` params on Windows cmd** — `^&` escapes land
   LITERALLY in the query string (`server=127.0.0.1:8000^&mode=ctf^&bots=16`).
   The page loads but params are garbage. Fix: don't put params in the
   intent; `page.goto()` from the profiler instead.
2. **`:9222` may already be bound** on the PC (not Chrome DevTools — it
   404s `/json/version`). Any free local port works for `adb forward`;
   use 9333.
3. **`page.waitForFunction` arg order** — signature is
   `(pageFunction, arg, options)`; passing `{timeout}` in the `arg` slot
   silently keeps the 30s default. Always `undefined, { timeout: N }`.
4. **rAF recorders die on navigation** — `page.evaluate` injection
   survives exactly one document. `page.addInitScript` covers future
   navs; ALSO make every stats read tolerate `__ph` being absent.
5. **Phone screen off / tab backgrounded = rAF stopped but JS alive** —
   the profiler reads fps=0 while heap and node counts still churn.
   `document.visibilityState` may still report "visible" via CDP. For
   real numbers: phone awake, game tab in front, screen on.
6. **Stale tabs** — an earlier failed launch leaves a page at the same
   origin; `ctx.pages().find(url.includes('5400'))` can grab the wrong
   one. Prefer the freshest /s/ page or navigate the found page
   explicitly.
7. **`IO.read` on a Tracing stream rejected** ("Invalid parameters") on
   this Chrome build — use `transferMode: 'ReportEvents'` +
   `Tracing.dataCollected` accumulation instead of ReturnAsStream.
8. **`renderer.getSize({x:0,y:0})` throws** — it wants a real Vector2.
   Read `renderer.domElement.width/height` + `getPixelRatio()` instead.
9. **`Object.fromEntries(...).slice` doesn't exist** — it returns an
   object, not array. Keep evals trivial; serialize via
   `JSON.stringify` of a plain object.

## First result found a real bug — canvas oversize → black screen

Measured on the phone before any tuning:

- `innerWidth=1645, innerHeight=2893`, `devicePixelRatio=2.625`,
  `MAX_TEXTURE_SIZE=8192`
- `overscanSize()` forced 16:9 → canvas `5143×2893` CSS
- `setPixelRatio(min(dpr,2))` → drawing buffer **9580×5388 ≈ 51 MP**
- > maxTex → cannot present → **black screen, ~1 rAF/s, `draws=1 tris=1`**

The game never clamps the buffer to the GL limit — any oversized window
(big portrait, huge monitor + supersample pscale<1) hits the same wall.

**Fix shipped in `client/src/core/renderer.ts`:**
- `makeUpdateRendererSize` normal path:
  `setPixelRatio(min(pixelRatio(), maxTex/w, maxTex/h))` —
  `maxTex = renderer.capabilities.maxTextureSize`.
- `applyPixelSize` pscale<1 path: `scale = max(pscale, w/maxTex, h/maxTex)`.

This keeps the 16:9 overscan and resScale machinery intact; it only
trims the pixel ratio when the raw product would exceed the GPU. It does
NOT cap total buffer area — a 1645×2893 portrait viewport still renders
~37 MP (fits, but heavy). Whether to also cap buffer area / drop GAME_ASPECT
overscan on portrait is the next call — phone fps data will say if 37 MP
is even feasible on Adreno.

## Still open

- Re-run `_phoneprof.ts 120` post-clamp: honest fps + p95 + 15s trace
  with hot functions.
- `?res=` and `pscale`/`autoq` interaction on mobile — autoq may
  already rescale; verify.
- UDP lanes (`ws://127.0.0.1:8787-8791/udp`) are NOT adb-reversed — the
  client falls back to ws. Profile the ws path only, or reverse them if
  UDP-lane timing matters.
- The page's `?server=127.0.0.1:8000` works only because BOTH ports are
  adb-reversed; forgetting `tcp:8000` lands the tab on a dead join.
- Touch controls — profiling samples fps/heap/trace only; nothing
  simulates touch input yet.
