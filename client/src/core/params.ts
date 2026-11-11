/**
 * URL params - one accessor module. Every `new URLSearchParams(location.search)`
 * call site used to re-parse the same string; this is the single source.
 *
 * The URL is for CONNECTION + headless hooks (server address, p2p code,
 * ?export/?bakedbg/?pixelated screenshot overrides). Gameplay-facing
 * choices - mode, spawn rules, debug - live in the menu settings now:
 * the `urlParams` getters below read the persisted setting so existing
 * call sites don't care where the value came from.
 */

import { settings } from './settings.js';

/** Dev surfaces (SIM/GUN LAB, spawn-script toggle, DEBUG wiring,
 *  ?dummy/?yaw/?pitch headless hooks) belong to the operator's machine.
 *  A public deploy is always behind TLS - http means the vite dev
 *  server, localhost, or a LAN build, all of which may show the tools.
 *  Gate on the protocol rather than a URL param strangers can flip. */
export const isDevHost = (): boolean =>
  import.meta.env.DEV || window.location.protocol !== 'https:';

/** P2P/LAN duels embed the real authority modules (p2p/host.ts pulls
 *  server_bun adjudication into the client bundle) - serving that to
 *  every visitor hands out the moat. Static gate: tree-shaken out of
 *  prod bundles entirely; dev builds and VITE_FPS_P2P=1 builds keep it. */
export const P2P_ENABLED = import.meta.env.DEV || import.meta.env.VITE_FPS_P2P === '1';

// Read live, not a boot snapshot: switchRoom() rewrites ?room/?map/?bots
// via history.replaceState with no reload - a parse-once snapshot would
// serve the PREVIOUS room to every later call site. Some debug readers
// DO run per-frame per-remote (collider gizmo tint), so the parse is
// keyed on the raw string - compare is ~free, reparse only on change.
let liveParams = new URLSearchParams();
let liveRoom = '';
let liveServerPath = '';
// The DOM reads themselves were the remaining cost - location.search
// allocates a fresh string per access and this runs per-frame from
// dozens of sites. The URL only moves through history.pushState/
// replaceState/popstate - hook them and skip the read entirely.
let liveDirty = true;
if (typeof window !== 'undefined' && typeof history !== 'undefined') {
  const dirty = (): void => { liveDirty = true; };
  window.addEventListener('popstate', dirty);
  for (const m of ['pushState', 'replaceState'] as const) {
    const orig = history[m];
    history[m] = function (this: History, ...args: Parameters<History['pushState']>): ReturnType<History['pushState']> {
      dirty();
      return orig.apply(this, args);
    };
  }
}
/** Test seam - stubs mutate location.search/pathname directly, bypassing
 *  the history API. Call after such a write to invalidate the cache. */
export function invalidateUrlParams(): void { liveDirty = true; }
const live = (): URLSearchParams => {
  // Node/bun test hosts have no location - URL params read empty, every
  // getter falls through to its settings/default leg.
  if (liveDirty && typeof window !== 'undefined') {
    liveDirty = false;
    liveParams = new URLSearchParams(window.location.search);
    // Canonical share link is the PATH: /s/<room>. ?room= stays readable
    // for old links; nothing writes it anymore.
    // /s/<room> = default server; /<alias>/<room> = a named server from
    // endpoints.ts NAMED_SERVERS (/pub/rimrock-1 pins the public box).
    // Only known aliases match - other routes can't collide.
    const m = /^\/(s|pub|jp)\/([^/?#]+)/.exec(window.location.pathname);
    liveRoom = m ? decodeURIComponent(m[2]) : '';
    liveServerPath = m && m[1] !== 's' ? m[1] : '';
  }
  return liveParams;
};

/** Creation hints that must survive the join-time reload - written by
 *  Lobby.join() right before navigation, consumed by the join payload.
 *  Once the room exists its spec is server-side, so stale hints only
 *  matter if the room was disposed since (same semantics ?map/?bots
 *  in the URL used to give). */
export interface JoinSpec { map?: string; bots?: number; mode?: string; instagib?: boolean; gungame?: boolean; igun?: boolean }
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
  /** Game mode - URL wins (shareable room links carry ?mode=), then the
   *  persisted menu pick ('' | nuggets | ctf | dm | tdm | duel | classic). */
  get mode(): string | null { return live().get('mode') || settings.get('fps-mode') || null; },
  /** classic = solo bounce-and-shoot: balls only, no rage, no roster */
  get isClassic(): boolean { return settings.get('fps-mode') === 'classic'; },
  /** All-random creature spawns - no scripted beats, everything rolls from t=0 */
  get randomSpawns(): boolean { return settings.get('fps-spawns') === 1; },
  /** Dev overlays / verbose combat logging - menu toggle OR ?debug (the
   *  param stays as a headless-capture override). Dev hosts only: on a
   *  public deploy the flag reads false no matter what a URL carries. */
  get debug(): boolean { return isDevHost() && (live().has('debug') || settings.get('fps-debug') === 1); },
  /** ?p2p=host:CODE|join:CODE - WebRTC duel via /rtc handshake relay.
   *  URL wins for shareability; falls back to the lobby's saved field. */
  get p2p(): string | null { return live().get('p2p') || settings.get('fps-p2p') || null; },
  /** ?lobby / saved flag - host marks the p2p room public on the relay
   *  so quick-joiners find it via /rtc/lobbies. */
  get lobby(): boolean { return live().has('lobby') || settings.get('fps-lobby') === 1; },
  /** Room identity is the PATH - /s/NAME. The ?room= fallback keeps old
   *  shared links working. */
  get room(): string | null { live(); return liveRoom || liveParams.get('room'); },
  /** Named server from the path - /<alias>/<room>. '' when on /s/. */
  get serverPath(): string { live(); return liveServerPath; },
  /** SOLO session intent - the old ?solo marker, now a persisted setting;
   *  the param stays as a headless-harness override. */
  get solo(): boolean { return live().has('solo') || settings.get('fps-solo') === 1; },
  /** Solo field pick - URL override first (harnesses), then the SOLO
   *  tab's persisted choice. */
  get soloMap(): string | null { return live().get('map') || settings.get('fps-solo-map') || null; },
  get soloBots(): number | undefined {
    const b = live().get('bots');
    if (b) {return Number(b);}
    const s = settings.get('fps-solo-bots');
    return s >= 0 ? s : undefined;
  },
  /** ?map=/?bots= - URL-only creation hints (harnesses + legacy links).
   *  Interactive joins carry hints via readJoinSpec instead. */
  get map(): string | null { return live().get('map'); },
  get bots(): number | undefined { const b = live().get('bots'); return b ? Number(b) : undefined; },
  /** ?unlisted - creation-time flag forwarded on join/switchRoom: the
   *  room stays off /rooms and out of quick-join picks. */
  get unlisted(): boolean { return live().has('unlisted') || settings.get('fps-unlisted') === 1; },
  /** ?nocreatures=/?noballs= - creation-time sim gates forwarded on
   *  join/switchRoom: the hosted room skips the species populations. */
  get noCreatures(): boolean { return live().has('nocreatures') || settings.get('fps-nocreatures') === 1; },
  /** ?creatures - opt BACK IN to species in the local population. Offline
   *  default is balls-only (species sim was the frame hog); hosted-room
   *  creature gates still read noCreatures above. */
  get creatures(): boolean { return live().has('creatures') || settings.get('fps-creatures') === 1; },
  get noBalls(): boolean { return live().has('noballs') || settings.get('fps-noballs') === 1; },
  /** ?instagib / fps-instagib - creation-time modifier forwarded on
   *  join/switchRoom: light chassis, railgun+hook only, 200dmg rail hits,
   *  no rail splash. Layers onto whatever mode the room runs. */
  get instagib(): boolean { return live().has('instagib') || settings.get('fps-instagib') === 1; },
  /** ?gungame / fps-gungame - creation-time modifier: the shared weapon
   *  ladder owns every player's gun (kills advance, deaths reset). */
  get gungame(): boolean { return live().has('gungame') || settings.get('fps-gungame') === 1; },
  /** ?igun / fps-igun - gun game with ~200-effective damage on every
   *  weapon; implies gungame server-side (roomModsOf). */
  get igun(): boolean { return live().has('igun') || settings.get('fps-igun') === 1; },
  get noLips(): boolean { return live().has('nolips') || settings.get('fps-nolips') === 1; },
  /** Local ambient ball field only - honors an explicit ?noballs, but NOT
   *  the persisted fps-noballs room-creation flag (pure-PvP hosted default
   *  shouldn't strip the offline sandbox's main attraction). */
  get noBallsLocal(): boolean { return live().has('noballs'); },
  /** ?net=wt|rtc - probe that transport tier before falling back to
   *  WebSocket (netcode v2; the UDP tiers are stubbed until server halves
   *  exist). Absent param = straight WS, today's behavior. */
  get net(): string | null { return live().get('net'); },
  /** ?fxfull - debug A/B: batched FX buffers (ribbon trails, ball dots)
   *  upload the whole attribute instead of the marked range. If trails
   *  appear with this set, the partial-upload path is the break. */
  get fxfull(): boolean { return live().has('fxfull'); },
};
