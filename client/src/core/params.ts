/**
 * URL params — one accessor module. Every `new URLSearchParams(location.search)`
 * call site used to re-parse the same string; this is the single source.
 *
 * The URL is for CONNECTION + headless hooks (server address, p2p code,
 * ?export/?bakedbg/?pixelated screenshot overrides). Gameplay-facing
 * choices — mode, spawn rules, debug — live in the menu settings now:
 * the `urlParams` getters below read the persisted setting so existing
 * call sites don't care where the value came from.
 */

import { settings } from './settings.js';

/** Dev surfaces (SIM/GUN LAB, spawn-script toggle, DEBUG wiring,
 *  ?dummy/?yaw/?pitch headless hooks) belong to the operator's machine.
 *  A public deploy is always behind TLS — http means the vite dev
 *  server, localhost, or a LAN build, all of which may show the tools.
 *  Gate on the protocol rather than a URL param strangers can flip. */
export const isDevHost = (): boolean =>
  import.meta.env.DEV || window.location.protocol !== 'https:';

// Read live, not a boot snapshot: switchRoom() rewrites ?room/?map/?bots
// via history.replaceState with no reload — a parse-once snapshot would
// serve the PREVIOUS room to every later call site. Some debug readers
// DO run per-frame per-remote (collider gizmo tint), so the parse is
// keyed on the raw string — compare is ~free, reparse only on change.
let lastSearch = '';
let liveParams = new URLSearchParams();
const live = (): URLSearchParams => {
  // Node/bun test hosts have no location — URL params read empty, every
  // getter falls through to its settings/default leg.
  const s = typeof window === 'undefined' ? '' : window.location.search;
  if (s !== lastSearch) {
    lastSearch = s;
    liveParams = new URLSearchParams(s);
  }
  return liveParams;
};

export const urlParams = {
  get: (k: string): string | null => live().get(k),
  has: (k: string): boolean => live().has(k),
  /** Game mode — URL wins (shareable room links carry ?mode=), then the
   *  persisted menu pick ('' | nuggets | ctf | dm | tdm | duel | classic). */
  get mode(): string | null { return live().get('mode') || settings.get('fps-mode') || null; },
  /** classic = solo bounce-and-shoot: balls only, no rage, no roster */
  get isClassic(): boolean { return settings.get('fps-mode') === 'classic'; },
  /** All-random creature spawns — no scripted beats, everything rolls from t=0 */
  get randomSpawns(): boolean { return settings.get('fps-spawns') === 1; },
  /** Dev overlays / verbose combat logging — menu toggle OR ?debug (the
   *  param stays as a headless-capture override). Dev hosts only: on a
   *  public deploy the flag reads false no matter what a URL carries. */
  get debug(): boolean { return isDevHost() && (live().has('debug') || settings.get('fps-debug') === 1); },
  /** ?p2p=host:CODE|join:CODE — WebRTC duel via /rtc handshake relay.
   *  URL wins for shareability; falls back to the lobby's saved field. */
  get p2p(): string | null { return live().get('p2p') || settings.get('fps-p2p') || null; },
  /** ?lobby / saved flag — host marks the p2p room public on the relay
   *  so quick-joiners find it via /rtc/lobbies. */
  get lobby(): boolean { return live().has('lobby') || settings.get('fps-lobby') === 1; },
  /** ?room=NAME — match room on the server (default: 'default'). Lets two
   *  matches coexist on one server; share the URL to share the room. */
  get room(): string | null { return live().get('room'); },
  /** ?map=/?bots= — spec hints the join message forwards so a fresh
   *  server-side room rebuilds from the right maps/<X>.json. */
  get map(): string | null { return live().get('map'); },
  get bots(): number | undefined { const b = live().get('bots'); return b ? Number(b) : undefined; },
  /** ?unlisted — creation-time flag forwarded on join/switchRoom: the
   *  room stays off /rooms and out of quick-join picks. */
  get unlisted(): boolean { return live().has('unlisted'); },
  /** ?nocreatures=/?noballs= — creation-time sim gates forwarded on
   *  join/switchRoom: the hosted room skips the species populations. */
  get noCreatures(): boolean { return live().has('nocreatures'); },
  get noBalls(): boolean { return live().has('noballs'); },
  /** ?net=wt|rtc — probe that transport tier before falling back to
   *  WebSocket (netcode v2; the UDP tiers are stubbed until server halves
   *  exist). Absent param = straight WS, today's behavior. */
  get net(): string | null { return live().get('net'); },
  /** ?fxfull — debug A/B: batched FX buffers (ribbon trails, ball dots)
   *  upload the whole attribute instead of the marked range. If trails
   *  appear with this set, the partial-upload path is the break. */
  get fxfull(): boolean { return live().has('fxfull'); },
};
