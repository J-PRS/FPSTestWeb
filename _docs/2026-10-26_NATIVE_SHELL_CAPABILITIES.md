# Native shell capabilities — beyond fullscreen + UDP

2026-10-26 · research inventory for the Electrobun wrapper
(see also `2026-10-26_NATIVE_UDP_LANE.md`)

A native webview shell costs almost nothing (~200 LOC for the remote-URL
window + a relay) but wraps the web client in real game trappings. What
it actually buys, ranked:

## Real wins

### Fullscreen exclusive + GPU control
`BrowserWindow` supports `titleBarStyle:"hidden"` (borderless, no
chrome) + `setWindowFullScreen` — a real-game window, not a tab.
Beyond cosmetics:
- Exclusive/borderless fullscreen beats the windowed-compositor present
  path on input-to-photon latency.
- Windows driver profiles treat a signed exe as a game: force the
  high-performance GPU on laptops (default exe→iGPU→terrible WebGL),
  pick the high-refresh monitor.

### Disk demos/replays
The `.demo`/`.rec` system gets a real home:
`Documents/Kribes/replays/*.kriberec` written directly (no download
prompt), a replay browser UI, file-association (double-click a rec →
watch). Auto-record every match, clip hotkey, silent PNG screenshots.

### Notifications + presence
- OS toasts while the window is hidden ("match found", invite,
  friend-joined) — no browser Notification permission gating.
- Tray icon ("N online"), jump-list/recent rooms.

### Rich presence + deep links
- Discord/Steam-style presence — "in duel-1" from the `/rooms` roster
  already exposed.
- Protocol handler `kribes://join/duel-1` — one arg into `?room=`; a
  shareable join link that lands a friend directly in the match.

### Push-to-talk / global hotkeys
PTT while unfocused (browsers can't), a global "record clip" hotkey,
screenshot key that writes to disk without a dialog.

### Anti-cheat attestation (the pro-client pitch)
A signed shell is a harder-to-fake environment than a free browser:
known viewport, no extensions, binary integrity, process checks. Not a
kernel anticheat, but the credible "competitive client" story —
pair with the UDP lane + telemetry and it's the differentiator between
the casual and pro tiers.

### Real perf telemetry
Actual CPU/RSS/GPU usage, frame pacing, battery/thermal state — the
things a page can't see. Correlates client stalls with server metrics
in `/status` for both ops and automated client profiling.

### Hardware input
Raw HID/gamepad beyond the browser Gamepad API (flight/HOTAS sticks),
unadjustedMouseMovement-class raw delta without Chrome flags.

## Marginal / trap cards — named so we don't chase them

- **Faster rendering: no.** The webview is still Chromium's renderer +
  JS — wrapping doesn't escape Chrome's input→frame pipeline.
  (Electrobun's WGPU surfaces could host a native renderer someday —
  that's a rewrite, not a win.)
- **Unthrottled rAF: no.** A hidden/occluded webview still throttles —
  the parked-tab desync class is untouched.
- **Audio: still WebAudio.** Native VoIP is possible over the same
  socket story but it's a feature, not an upgrade.

## The 80/20 pitch

Fullscreen + UDP + disk replays + presence/deep-links + PTT +
GPU selection + telemetry = the game *feels* like a real client rather
than a tab, and the signed-shell+UDP+telemetry combo is the honest
"pro client" story. Most of the remainder is chrome.

## What it costs

| Piece | Shape |
|---|---|
| Fullscreen | config (`titleBarStyle:"hidden"` + `setWindowFullScreen`) |
| Replays/files | main-proc fs write + a small RPC surface for the page |
| Presence/notifications | electrobun Tray/dialog APIs + a `kribes://` protocol registration |
| PTT/global hotkeys | platform global-shortcut hook (per-OS; electrobun global-shortcut table) |
| Telemetry | main proc samples → page or `/status` post |

Each is a ~50–150-line island on top of the shell — none touches the
game protocol except the UDP lane.
