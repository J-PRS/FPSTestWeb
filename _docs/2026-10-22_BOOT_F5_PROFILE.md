# Boot / F5 Deep Profile — 2026-10-22

Measured on real GPU Chrome (chrome-devtools MCP, CDP traces + in-page
`performance` marks). Dev numbers on vite dev server; prod on `vite preview`
of the meshopt/post-shrink dist (~11.3MB).

## Result summary

| mark | dev (unbundled) | dev (bundledDev) | prod |
|---|---|---|---|
| initStart | 8511ms | 1082ms | 426ms |
| initComplete | 9044 | **1275** | **556** |
| playerModelLoaded | 9728 | 1953 | 964 |
| networkConnected | 9878 | **2177** | **966** |
| module requests | ~250 | **16** | 16 |
| LCP / FCP | — | — | 639ms |

F5 on prod lands ~0.5s to the game loop, ~1s to connected. Dev F5 after
bundledDev lands ~2.2s end-to-end — ~8x faster than the unbundled ESM
waterfall.

## What the waterfall was

The dev cost was never transform — `server.warmup` +
`preTransformRequests` were already on. It was the **~250-module ESM
request waterfall** (depth-first import discovery over ~6 h1
connections). The init pipeline itself is ~530ms everywhere.

## Changes landed this pass

- `vite@8.0.16 → 8.1.6` + `experimental.bundledDev: true`
  (`vite.config.js`) — rolldown lazy-bundles modules in dev; ESM output,
  instant HMR. Experimental: delete the flag to revert.
- Session veil now arms for **all online boots** (was:
  `fps-session-token` only) — fresh joins get `JOINING`, reconnects
  `RECONNECTING`. Covers the unspawned-camera window (the under-terrain
  flash) until gameState + firstTerrain + ~45 stable frames; 8s escape
  on connect failure. `armSessionVeil(label?)`.
- `index.html` preload hint for `heightmap.bin` — starts at HTML parse
  instead of post-eval. `crossorigin` (anonymous) matches the plain
  `fetch()`; `use-credentials` warned and double-fetched.
- Class-body GLB prefetch at module eval — warms HTTP cache for the
  saved `fps-class` (~1.5s before `playerCtor` would fetch it cold).
- `urlParams.live()` — event-driven cache (popstate + history hooks +
  exported `invalidateUrlParams()` for non-history writes). ~1% frame CPU.
- `unifySkeletons()` in PlayerModel — remote bodies drop ~9→3 skeleton
  instances (class GLBs ship per-part armatures); same bones, less
  `skeleton.update` churn per body.
- Verified prod build on 8.1.6: 10.7s → **3.67s**.

## Known issues found (not yet fixed)

- **GL sampler/type mismatch warnings** — hundreds of
  `GL_INVALID_OPERATION` per session on real GPU Chrome (glDrawElements /
  glDrawArraysInstanced). A shader samples a texture with the wrong
  sampler class (int/uint vs float, or depth vs color). Floods the
  console and likely reads garbage somewhere. Own bug hunt — isolate
  which material via the frame trace.
- **Reconnect tail** — cold reload WITH a session token ran ~4.5s past
  initComplete (fresh join: ~400ms). Suspect `restoreLocalPlayer`
  journal replay or the token handshake. Instrument the
  gameState→veilDrop→spawn window on reconnect vs fresh join.
- **HMR ws → :5400** — `hmr.clientPort: 5400` is hardcoded; e2e stacks
  on :5399+ get a 400 token-mismatch against whoever owns :5400. Noise
  in test stacks only; real dev on :5400 is unaffected.
- **`__test` attach timing** — probes can briefly sample `test:false`
  during boot even when the game is joining fine; poll it, don't
  single-shot.

## Still open (deploy-side, not code)

- `game-[hash].js` + `Cache-Control: immutable` on hashed assets —
  eliminates F5 revalidation entirely; needs the static host's headers.
- Brotli on `game.js` (886KB gz → ~700KB).
- `codeSplitting: false` remains deliberate — one 2.85MB chunk; revisit
  only with real measurements.

## Method notes

- `performance_start_trace` gives a bounded ~8s capture; in-page
  `performance.getEntriesByType('mark')` reads the LoadProfiler marks —
  `resCount` + `transferSize===0` distinguishes cache-hit F5 runs from
  cold loads.
- MCP Chrome profile lock: `Singleton*` files survive killed chromes —
  `del %USERPROFILE%\.cache\chrome-devtools-mcp\chrome-profile\Singleton*`.
