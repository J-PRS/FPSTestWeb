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
let lastPath = '';
let liveParams = new URLSearchParams();
let liveRoom = '';
const live = (): URLSearchParams => {
  // Node/bun test hosts have no location — URL params read empty, every
  // getter falls through to its settings/default leg.
  const s = typeof window === 'undefined' ? '' : window.location.search;
  const p = typeof window === 'undefined' ? '' : window.location.pathname;
  if (s !== lastSearch || p !== lastPath) {
    lastSearch = s;
    lastPath = p;
    liveParams = new URLSearchParams(s);
    // Canonical share link is the PATH: /s/<room>. ?room= stays readable
    // for old links; nothing writes it anymore.
    const m = /^\/s\/([^/?#]+)/.exec(p);
    liveRoom = m ? decodeURIComponent(m[1]) : '';
  }
  return liveParams;
};

/** Creation hints that must survive the join-time reload — written by
 *  Lobby.join() right before navigation, consumed by the join payload.
 *  Once the room exists its spec is server-side, so stale hints only
 *  matter if the room was disposed since (same semantics ?map/?bots
 *  in the URL used to give). */
export interface JoinSpec { map?: string; bots?: number; mode?: string }
export function readJoinSpec(): JoinSpec {
  try {
    const v = JSON.parse(settings.get('fps-join-spec')) as JoinSpec;
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}
export function writeJoinSpec(spec: JoinSpec): void {
  settings.set('fps-join-spec', JSON.stringify(spec));
}

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
  /** Room identity is the PATH — /s/NAME. The ?room= fallback keeps old
   *  shared links working. */
  get room(): string | null { live(); return liveRoom || liveParams.get('room'); },
  /** SOLO session intent — the old ?solo marker, now a persisted setting;
   *  the param stays as a headless-harness override. */
  get solo(): boolean { return live().has('solo') || settings.get('fps-solo') === 1; },
  /** Solo field pick — URL override first (harnesses), then the SOLO
   *  tab's persisted choice. */
  get soloMap(): string | null { return live().get('map') || settings.get('fps-solo-map') || null; },
  get soloBots(): number | undefined {
    const b = live().get('bots');
    if (b) {return Number(b);}
    const s = settings.get('fps-solo-bots');
    return s >= 0 ? s : undefined;
  },
  /** ?map=/?bots= — URL-only creation hints (harnesses + legacy links).
   *  Interactive joins carry hints via readJoinSpec instead. */
  get map(): string | null { return live().get('map'); },
  get bots(): number | undefined { const b = live().get('bots'); return b ? Number(b) : undefined; },
  /** ?unlisted — creation-time flag forwarded on join/switchRoom: the
   *  room stays off /rooms and out of quick-join picks. */
  get unlisted(): boolean { return live().has('unlisted') || settings.get('fps-unlisted') === 1; },
  /** ?nocreatures=/?noballs= — creation-time sim gates forwarded on
   *  join/switchRoom: the hosted room skips the species populations. */
  get noCreatures(): boolean { return live().has('nocreatures') || settings.get('fps-nocreatures') === 1; },
  get noBalls(): boolean { return live().has('noballs') || settings.get('fps-noballs') === 1; },
  /** ?net=wt|rtc — probe that transport tier before falling back to
   *  WebSocket (netcode v2; the UDP tiers are stubbed until server halves
   *  exist). Absent param = straight WS, today's behavior. */
  get net(): string | null { return live().get('net'); },
  /** ?fxfull — debug A/B: batched FX buffers (ribbon trails, ball dots)
   *  upload the whole attribute instead of the marked range. If trails
   *  appear with this set, the partial-upload path is the break. */
  get fxfull(): boolean { return live().has('fxfull'); },
};
