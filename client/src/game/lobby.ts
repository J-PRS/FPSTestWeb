/**
 * Lobby - room browser as a self-contained DOM module (chat.ts pattern:
 * own elements, own key routing, textContent-only).
 *
 * Joining a room first tries an in-place hop - the server's switchRoom
 * re-seats the live session and answers with a fresh gameState the normal
 * reconnect path rebuilds from. Offline/degraded clients fall back to the
 * /s/NAME reload — the path is the shareable link either way.
 */

import { buildLobbyPanel , type LobbyPanelEls } from './lobbyPanel.js';
import { urlParams, writeJoinSpec } from '../core/params.js';
import { settings } from '../core/settings.js';
import { Logger } from '../core/Logger.js';

const modesOf = (m: { modes: string[]; mode?: string }): string[] => {
  if (m.modes.length > 0) {return m.modes;}
  return m.mode ? [m.mode] : [];
};

export interface RoomRow {
  name: string;
  mode?: string;
  /** Spec map the room is playing — set server-side, follows rotation. */
  map?: string;
  players: number;
  maxPlayers: number;
  /** Seated humans (rest are bots) — the browser shows humans/max. */
  humans?: number;
  /** Team-mode live score. */
  scores?: { alpha: number; bravo: number };
  /** FFA-mode live leader [id, pts]. */
  ffaLeader?: [string, number];
  winAt?: number;
  /** ms until the match clock's horn — omitted while unarmed. */
  timeLeftMs?: number;
}

export interface MapRow {
  name: string;
  /** The map's default ruleset — used when MODE is left on ANY. */
  mode: string;
  /** Modes the map can legally host (map = geometry, mode = ruleset). */
  modes: string[];
  bots: number;
  /** Tribes 2 port — badged in the picker so ports read as ports. */
  t2?: boolean;
  /** Tribes 1 port — same ported family, own badge. */
  t1?: boolean;
  /** Quake-family port (OACMP/Xonotic .map conversions) — own badge. */
  q3?: boolean;
}

/** Any ported map (Tribes or Quake) — procedural modes want native specs. */
const isPort = (m: MapRow): boolean => Boolean(m.t2 || m.t1 || m.q3);
const mapFamOf = (m: MapRow): 't2' | 'q3' | 'custom' => {
  if (m.t2 || m.t1) {return 't2';}
  return m.q3 ? 'q3' : 'custom';
};
const mapBadge = (m: MapRow): string => {
  if (m.t2) {return '[T2] ';}
  if (m.t1) {return '[T1] ';}
  return m.q3 ? '[Q3] ' : '';
};

export interface LobbyDeps {
  /** GETs {name, mode?, players, maxPlayers}[]; throws when offline. */
  listRooms(): Promise<RoomRow[]>;
  /** GET /maps — playable map list for the match-setup picker. */
  listMaps(): Promise<MapRow[]>;
  /** GET /join?mode&map&bots — server picks the emptiest live match
   *  fitting the request (or spins a fresh room from the map spec). */
  quickJoin(mode: string, map?: string, bots?: number, noCreatures?: boolean, noBalls?: boolean): Promise<{ room: string }>;
  /** In-place room hop over the live socket — false when there's no
   *  connection (caller reloads instead). map/bots/mode are creation
   *  hints for a room that doesn't exist yet. */
  switchRoom?(name: string, map?: string, bots?: number, mode?: string, unlisted?: boolean, noCreatures?: boolean, noBalls?: boolean): boolean;
  /** /maps/thumbs/<name>.png — pre-rendered vantage shot for the MAP
   *  picker preview. Absent → no preview panel. */
  mapThumbUrl?(name: string): string;
  /** GET /rtc/lobbies — public P2P hosts still waiting for a peer.
   *  Absent → P2P tab hides the open-lobby list. */
  listP2pLobbies?(): Promise<{ room: string; since: number }[]>;
  /** Live socket check — without it a solo-offline boot reads as "in
   *  the default room" and the join path dead-ends (row disabled,
   *  early return). Absent → assume online (legacy behavior). */
  isConnected?(): boolean;
}

const POLL_MS = 3000;

// Styling lives in ui/chrome.css (.lb-* classes) — this module only
// builds structure and wires behavior.

export class Lobby {
  deps: LobbyDeps;
  private panel: HTMLDivElement;
  private rows: HTMLDivElement;
  private mapSelect: HTMLSelectElement;
  private modeSelect: HTMLSelectElement;
  private botsInput: HTMLInputElement;
  private els: LobbyPanelEls;
  private maps: MapRow[] = [];
  private mapsFailed = false;
  // MAP picker family filter — [T2]/[T1]/[Q3] badges mark ports;
  // 'custom' is our own spec. All on = the full list.
  private mapFam = { t2: true, q3: true, custom: true };
  private timer: ReturnType<typeof setInterval> | null = null;
  /** SOLO tab's pickers — same fill rules as HOST's, bound from the
   *  panel builder once it exists. */
  private soloSels: { mode: HTMLSelectElement; map: HTMLSelectElement } | null = null;

  currentRoom(): string {
    return urlParams.room ?? 'default';
  }

  /** True membership vs the ?room fallback — a solo boot has room==null
   *  and no socket, so it is in NO room, not the default one. */
  private online(): boolean {
    return this.deps.isConnected?.() ?? true;
  }

  constructor(deps: LobbyDeps) {
    this.deps = deps;
    // Panel DOM lives in lobbyPanel.ts — structure + wiring, .lb-* styling.
    const els = buildLobbyPanel(this);
    this.panel = els.panel;
    this.rows = els.rows;
    this.mapSelect = els.mapSelect;
    this.modeSelect = els.modeSelect;
    this.botsInput = els.botsInput;
    this.els = els;
  }

  /** Populate the mode + map pickers once per open — cheap, menu is
   *  user-paced. Mode select lists the union of every map's legal modes. */
  private async refreshMaps(): Promise<void> {
    try {
      this.maps = await this.deps.listMaps();
      this.mapsFailed = false;
    } catch {
      this.maps = [];
      // Rooms poll shows "server offline" on the same failure — an empty
      // map picker with only "server default" hid the identical problem.
      this.mapsFailed = true;
      Logger.warn('lobby: listMaps failed — map picker degraded');
    }
    // Mode order is a curated popularity ramp (team staples first, niche
    // FFA last), not alphabetical — a mode picker is a recommendation.
    const MODE_ORDER = ['ctf', 'tdm', 'nuggets', 'dm', 'rabbit', 'duel'];
    const modes = [...new Set(this.maps.flatMap(modesOf))]
      .toSorted((a, b) => (MODE_ORDER.indexOf(a) + 1 || 99) - (MODE_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
    this.fillModeSel(this.modeSelect, modes, 'ANY');
    if (this.soloSels) {
      // Solo modes: the same legal set plus the no-map rulesets —
      // '' is free roam (no TeamBots), flagrun/classic host no spec.
      // Trailing position: it's a real pick, not a "no filter" default.
      // Extras own their values — a spec that also declares 'flagrun'
      // would mint a duplicate option, so keep them out of the catalog
      // pass and let the labeled extra be the single entry.
      const extras = [['flagrun', 'FLAG RUN'], ['classic', 'BALLS']] as const;
      const extraVals = new Set(extras.map(([v]): string => v));
      this.fillModeSel(this.soloSels.mode, modes.filter((m): boolean => !extraVals.has(m)), 'FREE ROAM', false);
      for (const [extra, label] of extras) {
        const o = document.createElement('option');
        // 'classic' boots the original bounce-and-shoot sandbox — BALLS
        // names what you actually do; "classic" is only its dev codename.
        o.value = extra; o.textContent = label;
        this.soloSels.mode.append(o);
      }
      // FREE ROAM dead last — sandbox entries sit at the tail of the ramp.
      const fr = this.soloSels.mode.querySelector('option[value=""]');
      if (fr) {this.soloSels.mode.append(fr);}
    }
    this.fillMapSelect();
  }

  /** Mode options into one select — HOST and SOLO share the list. The
   *  '' option leads on HOST ("ANY" = no filter) but trails on SOLO
   *  ("FREE ROAM" is a mode among peers, not a default). */
  private fillModeSel(sel: HTMLSelectElement, modes: string[], firstLabel: string, leading = true): void {
    const keep = sel.value;
    sel.textContent = '';
    const any = document.createElement('option');
    any.value = ''; any.textContent = firstLabel;
    if (leading) {sel.append(any);}
    for (const mode of modes) {
      const o = document.createElement('option');
      o.value = mode;
      o.textContent = mode.toUpperCase();
      sel.append(o);
    }
    if (!leading) {sel.append(any);}
    sel.value = keep;
  }

  bindSoloSelects(modeSel: HTMLSelectElement, mapSel: HTMLSelectElement): void {
    this.soloSels = { mode: modeSel, map: mapSel };
    modeSel.addEventListener('change', (): void => this.fillMapSel(this.soloSels!));
    mapSel.addEventListener('change', (): void => {
      // A map pick with no mode chosen adopts the spec's own ruleset —
      // the label already advertises it ("BASTION · CTF · 8 bots").
      const m = this.maps.find((x): boolean => x.name === mapSel.value);
      if (m?.mode && modeSel.value === '') {
        modeSel.value = m.mode;
        // Real change: the toggle row relights and the map list refilters
        // to the adopted ruleset (which the map already declared legal).
        modeSel.dispatchEvent(new Event('change'));
      }
    });
    if (this.maps.length > 0 || this.mapsFailed) {this.refreshMaps();}
  }

  /** Refill MAP for the chosen MODE — a map only shows the modes it
   *  declares, so the list shrinks to the legal arenas. */
  fillMapSelect(): void {
    this.fillMapSel({ mode: this.modeSelect, map: this.mapSelect });
    if (this.soloSels) {this.fillMapSel(this.soloSels);}
  }

  private fillMapSel(sels: { mode: HTMLSelectElement; map: HTMLSelectElement }): void {
    const mode = sels.mode.value;
    const mapSelect = sels.map;
    // Remember the pick — a mode swap refills the list and the user's map
    // survives if it's still legal under the new mode.
    const keep = mapSelect.value;
    mapSelect.textContent = '';
    if (this.maps.length === 0) {
      const o = document.createElement('option');
      o.textContent = this.mapsFailed ? 'server offline' : 'server default';
      o.value = ''; o.dataset.mode = '';
      mapSelect.append(o);
      return;
    }
    // Modes no spec declares (flagrun circuit, classic sandbox) aren't
    // map rulesets at all — the mode stamps its own layout onto bare
    // terrain. Restrict those to our own spec maps: an 800m circuit
    // square wants a real core heightmap, not a T2 port's bounds.
    const catalogModes = new Set(this.maps.flatMap(modesOf));
    const procedural = Boolean(mode) && !catalogModes.has(mode);
    const rows = this.maps.filter((m): boolean =>
      this.mapFam[mapFamOf(m)] &&
      (!procedural || !isPort(m)) &&
      (!mode || procedural ||
        (m.modes.length > 0 ? m.modes : [m.mode]).includes(mode)));
    if (rows.length === 0) {
      const o = document.createElement('option');
      o.textContent = `no ${mode} maps`;
      o.value = ''; o.dataset.mode = '';
      mapSelect.append(o);
      return;
    }
    for (const m of rows) {
      const o = document.createElement('option');
      o.value = m.name;
      o.dataset.mode = mode || m.mode;
      // No ruleset tag on the name — maps are mode-agnostic geometry; a
      // bare name with ANY picked still boots the map's default mode via
      // dataset.mode, the mode row owns the override.
      o.textContent = `${mapBadge(m)}${m.name.toUpperCase()}`;
      mapSelect.append(o);
    }
    if ([...mapSelect.options].some((o): boolean => o.value === keep)) {mapSelect.value = keep;}
  }

  mapFamOn(kind: 't2' | 'q3' | 'custom'): boolean {
    return this.mapFam[kind];
  }

  // Favorite rooms persist across sessions — a server browser without a
  // fav column is only half a browser.
  private favSet(): Set<string> {
    try { return new Set(JSON.parse(settings.get('fps-fav-rooms') || '[]') as string[]); }
    catch { return new Set(); }
  }
  isFav(name: string): boolean {
    return this.favSet().has(name);
  }
  toggleFav(name: string): void {
    const favs = this.favSet();
    if (favs.has(name)) {favs.delete(name);} else {favs.add(name);}
    settings.set('fps-fav-rooms', JSON.stringify([...favs]));
    this.refresh();
  }

  /** Manual repoll — the ↻ button in the JOIN tab header. */
  refresh(): void {
    this.refreshRooms();
    this.els.refreshLobs();
  }

  toggleMapFam(kind: 't2' | 'q3' | 'custom'): void {
    this.mapFam[kind] = !this.mapFam[kind];
    this.fillMapSelect();
  }

  toggle(): void {
    const open = this.panel.style.display !== 'none';
    if (open) {
      this.panel.style.display = 'none';
      document.body.classList.remove('lobby-open');
      if (this.timer) {clearInterval(this.timer);}
      this.timer = null;
    } else {
      this.panel.style.display = 'block';
      document.body.classList.add('lobby-open');
      this.refresh();
      this.refreshMaps();
      this.timer = setInterval((): void => this.refresh(), POLL_MS);
    }
  }

  /** Live room tiles, keyed by room name — refresh diffs in place so a
   *  score/player-count tick updates the meta span instead of destroying
   *  and re-creating every tile (the flicker the rebuild caused). */
  private rowEls = new Map<string, { row: HTMLButtonElement; mode: HTMLSpanElement; map: HTMLSpanElement; occ: HTMLSpanElement; ping: HTMLSpanElement }>();
  /** Column header — minted once per poll batch, sits above the tiles. */
  private head: HTMLDivElement | null = null;
  /** Last /rooms RTT — the single-server ping every row shares. */
  private lastPing = '';

  private async refreshRooms(): Promise<void> {
    // oxlint-disable-next-line init-declarations -- assigned later
    let rooms!: RoomRow[];
    // RTT of the /rooms fetch itself = the server ping — green/amber/red.
    const t0 = performance.now();
    try {
      rooms = await this.deps.listRooms();
      const ms = Math.round(performance.now() - t0);
      this.lastPing = `${ms}ms`;
    } catch {
      this.rowEls.clear();
      this.rows.textContent = '';
      const err = document.createElement('div');
      err.style.color = '#f88';
      err.textContent = 'server offline';
      this.rows.append(err);
      return;
    }
    // The room you're IN tops the list (green tile replaces the old
    // IN: banner row) — then default lobby, favorites, alphabetical.
    const favs = this.favSet();
    const curName = this.currentRoom();
    const rank = (r: RoomRow): -1 | 0 | 1 | 2 => {
      if (this.online() && r.name === curName) {return -1;}
      if (r.name === 'default') {return 0;}
      return favs.has(r.name) ? 1 : 2;
    };
    rooms.sort((a, b): number => rank(a) - rank(b) || a.name.localeCompare(b.name));
    // Diff, don't rebuild: append() moves an existing row, so walking the
    // sorted list both inserts new tiles and re-sorts without a repaint.
    const seen = new Set<string>();
    this.rows.querySelector('.lb-empty')?.remove();
    if (!this.head) {
      this.head = document.createElement('div');
      this.head.className = 'lb-head';
      for (const h of ['SERVER', 'MODE', 'MAP', 'PLAYERS', 'PING']) {
        const c = document.createElement('span');
        c.textContent = h;
        this.head.append(c);
      }
    }
    this.rows.append(this.head);
    for (const r of rooms) {
      seen.add(r.name);
      let tile = this.rowEls.get(r.name);
      if (!tile) { tile = this.makeRow(r); this.rowEls.set(r.name, tile); }
      this.updateRow(tile, r);
      this.rows.append(tile.row);
    }
    for (const [name, tile] of this.rowEls) {
      if (!seen.has(name)) { tile.row.remove(); this.rowEls.delete(name); }
    }
    if (rooms.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'lb-empty';
      empty.style.cssText = 'color:rgba(58,167,255,0.5);padding:6px 2px;';
      empty.textContent = '— no matches — host one from the HOST tab';
      this.rows.append(empty);
    }
  }

  private static metaSpan(txt: string, cls = ''): HTMLSpanElement {
    const s = document.createElement('span');
    if (cls) {s.className = cls;}
    s.textContent = txt;
    return s;
  }

  /** Build a room tile once — static structure only: star | server | mode
   *  | map | players | ping, the servers.html column set. updateRow owns
   *  every field that churns. */
  private makeRow(r: RoomRow): { row: HTMLButtonElement; mode: HTMLSpanElement; map: HTMLSpanElement; occ: HTMLSpanElement; ping: HTMLSpanElement } {
    const row = document.createElement('button');
    row.className = 'lb-room';
    const name = document.createElement('span');
    name.className = 'lb-name';
    name.textContent = r.name;
    const mode = document.createElement('span');
    mode.className = 'lb-mode';
    const map = document.createElement('span');
    map.className = 'lb-map';
    const occ = document.createElement('span');
    occ.className = 'meta';
    const ping = document.createElement('span');
    ping.className = 'lb-ping';
    row.append(name, mode, map, occ, ping);
    row.addEventListener('click', (): void => this.join(r.name));
    return { row, mode, map, occ, ping };
  }

  /** Per-poll refresh of the churning bits — state classes, fav glyph,
   *  mode chip, map, occupancy (+score/target/clock), ping. */
  private updateRow(tile: { row: HTMLButtonElement; mode: HTMLSpanElement; map: HTMLSpanElement; occ: HTMLSpanElement; ping: HTMLSpanElement }, r: RoomRow): void {
    const full = r.players >= r.maxPlayers;
    const current = this.online() && r.name === this.currentRoom();
    tile.row.disabled = full || current;
    tile.row.classList.toggle('current', current);
    tile.row.classList.toggle('full', full);
    tile.mode.textContent = r.mode ? (Lobby.MODE_SHORT[r.mode] ?? r.mode.toUpperCase()) : '';
    tile.map.textContent = r.map ?? '—';
    tile.occ.textContent = '';
    this.rowMeta(tile.occ, r);
    tile.ping.textContent = this.lastPing;
  }

  private static readonly MODE_SHORT: Record<string, string> = {
    headhunt: 'HH', conquest: 'CONQ', infestation: 'INF', deathball: 'DB', rabbit: 'RBT', teamrabbit: 'TRBT',
  };

  /** Occupancy cell — the servers.html read: humans/max (bots). Match
   *  internals (score/target/clock) live in the room, not the browser. */
  private rowMeta(meta: HTMLElement, r: RoomRow): void {
    const mk = Lobby.metaSpan;
    const bots = r.players - (r.humans ?? r.players);
    meta.append(mk(`${r.humans ?? r.players}/${r.maxPlayers}`));
    if (bots > 0) {meta.append(mk(`(${bots})`, 'lb-bots'));}
  }

  join(name: string, map?: string, bots?: number, mode?: string, unlisted?: boolean, noCreatures?: boolean, noBalls?: boolean): void {
    // Already there — a reload would boot us into the same seat anyway.
    // Offline solo has no room, so 'default' is a real join target.
    if (name === this.currentRoom() && this.online()) {return;}
    // Room identity is the path: /s/<name>. Creation hints (map/bots/mode)
    // ride fps-join-spec so the reload path can mint a disposed room with
    // its spec intact — the URL stays shareable-clean. The sim gates are
    // already persisted fps-* settings; a duel session is mutually
    // exclusive with a server room — drop it here.
    settings.set('fps-p2p', '');
    settings.set('fps-lobby', 0);
    settings.set('fps-solo', 0);
    settings.set('fps-last-room', name);
    writeJoinSpec({ map, bots, mode });
    if (unlisted) {settings.set('fps-unlisted', 1);}
    if (noCreatures) {settings.set('fps-nocreatures', 1);}
    if (noBalls) {settings.set('fps-noballs', 1);}
    const q = new URLSearchParams(window.location.search);
    for (const k of ['room', 'p2p', 'lobby', 'map', 'bots', 'mode', 'unlisted', 'solo', 'nocreatures', 'noballs']) {q.delete(k);}
    const href = `/s/${encodeURIComponent(name)}${q.size > 0 ? `?${q}` : ''}`;
    // Live socket: hop in place — the gameState rebuild does the rest.
    if (this.deps.switchRoom?.(name, map, bots, mode, unlisted, noCreatures, noBalls)) {
      history.replaceState(null, '', href);
      return;
    }
    window.location.href = href;
  }
}
