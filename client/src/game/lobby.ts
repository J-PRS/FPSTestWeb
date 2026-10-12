/**
 * Lobby — room browser as a self-contained DOM module (chat.ts pattern:
 * own elements, own key routing, textContent-only).
 *
 * Joining a room first tries an in-place hop — the server's switchRoom
 * re-seats the live session and answers with a fresh gameState the normal
 * reconnect path rebuilds from. Offline/degraded clients fall back to the
 * ?room=NAME reload, which stays the shareable link either way.
 */

import { buildLobbyPanel , type LobbyPanelEls } from './lobbyPanel.js';
import { urlParams } from '../core/params.js';
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
}

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
  private here: HTMLDivElement;
  private mapSelect: HTMLSelectElement;
  private modeSelect: HTMLSelectElement;
  private botsInput: HTMLInputElement;
  private leaveBtn: HTMLButtonElement;
  private els: LobbyPanelEls;
  private maps: MapRow[] = [];
  private mapsFailed = false;
  // MAP picker family filter — the [T2] badge marks Tribes 2 ports;
  // 'custom' is our own spec. Both on = the full list.
  private mapFam = { t2: true, custom: true };
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
    this.here = els.here;
    this.mapSelect = els.mapSelect;
    this.modeSelect = els.modeSelect;
    this.botsInput = els.botsInput;
    this.leaveBtn = els.leaveBtn;
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
      this.fillModeSel(this.soloSels.mode, modes, 'FREE ROAM', false);
      for (const [extra, label] of [['flagrun', 'FLAG RUN'], ['classic', 'BALLS']] as const) {
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
      this.mapFam[m.t2 ? 't2' : 'custom'] &&
      (!procedural || !m.t2) &&
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
      // The ·MODE suffix is the map's DEFAULT ruleset — shown only on
      // ANY/FREE ROAM where it disambiguates the pick. With a mode
      // already chosen it would read as the map overriding that choice.
      o.textContent = `${m.t2 ? '[T2] ' : ''}${m.name.toUpperCase()}${!mode && m.mode ? ` · ${m.mode.toUpperCase()}` : ''}`;
      mapSelect.append(o);
    }
  }

  mapFamOn(kind: 't2' | 'custom'): boolean {
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

  toggleMapFam(kind: 't2' | 'custom'): void {
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

  private async refreshRooms(): Promise<void> {
    this.rows.textContent = '';
    // oxlint-disable-next-line init-declarations -- assigned later
    let rooms!: RoomRow[];
    // RTT of the /rooms fetch itself = the server ping — green/amber/red.
    const t0 = performance.now();
    try {
      rooms = await this.deps.listRooms();
      const ms = Math.round(performance.now() - t0);
      this.els.pingEl.textContent = `${ms}ms`;
      this.els.pingEl.style.color = ms < 60 ? '#6fcf8f' : '#ffd76f';
      if (ms >= 120) {this.els.pingEl.style.color = '#f88';}
    } catch {
      this.els.pingEl.textContent = '';
      const err = document.createElement('div');
      err.style.color = '#f88';
      err.textContent = 'server offline';
      this.rows.append(err);
      return;
    }
    // Default lobby first — it's the immortal room — then favorites
    // (browser-column convention), then alphabetical.
    const favs = this.favSet();
    const rank = (r: RoomRow): 0 | 1 | 2 => {
      if (r.name === 'default') {return 0;}
      return favs.has(r.name) ? 1 : 2;
    };
    rooms.sort((a, b): number => rank(a) - rank(b) || a.name.localeCompare(b.name));
    const cur = rooms.find((r): boolean => r.name === this.currentRoom());
    const online = this.online();
    // Dedupe: "ctf-1 · CTF · CTF" is three fields agreeing, not info —
    // keep each token only when it adds something.
    const hereExtras: string[] = [];
    if (cur?.mode) {hereExtras.push(cur.mode.toUpperCase());}
    if (cur?.map && cur.map.toUpperCase() !== cur.mode?.toUpperCase()
      && !this.currentRoom().toUpperCase().includes(cur.map.toUpperCase())) {
      hereExtras.push(cur.map.toUpperCase());
    }
    this.here.textContent = online
      ? `IN: ${this.currentRoom().toUpperCase()}${hereExtras.length > 0 ? ` · ${hereExtras.join(' · ')}` : ''}`
      : 'IN: OFFLINE';
    // Default lobby IS home — leaving it is a no-op; offline there's no
    // room to leave, but the button doubles as "go to the lobby".
    this.leaveBtn.disabled = online && this.currentRoom() === 'default';
    this.leaveBtn.textContent = online ? 'LEAVE' : 'GO';
    for (const r of rooms) {this.addRow(r);}
    if (rooms.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:rgba(58,167,255,0.5);padding:6px 2px;';
      empty.textContent = '— no matches — host one from the HOST tab';
      this.rows.append(empty);
    }
  }

  private addRow(r: RoomRow): void {
    const row = document.createElement('button');
    row.className = 'lb-room';
    const full = r.players >= r.maxPlayers;
    const current = this.online() && r.name === this.currentRoom();
    if (full || current) {row.disabled = true;}
    if (current) {row.classList.add('current');}
    if (full) {row.classList.add('full');}
    // Fav star — own click target so marking a room never joins it.
    const star = document.createElement('span');
    star.className = 'lb-fav';
    star.textContent = this.isFav(r.name) ? '★' : '☆';
    star.addEventListener('click', (e): void => {
      e.stopPropagation();
      this.toggleFav(r.name);
    });
    const name = document.createElement('span');
    name.textContent = r.name;
    name.style.flex = '1';
    const meta = document.createElement('span');
    meta.className = 'meta';
    let scoreTxt = '';
    if (r.scores) {scoreTxt = `  ${r.scores.alpha}:${r.scores.bravo}`;}
    else if (r.ffaLeader) {scoreTxt = `  ${r.ffaLeader[0]} ${r.ffaLeader[1]}pts`;}
    const clock = r.timeLeftMs ? ` ${Math.ceil(r.timeLeftMs / 60_000)}m` : '';
    // Same dedupe as the header — a room named after its mode doesn't
    // need "ctf" three times in one line.
    const room = r.name.toUpperCase();
    const modeTxt = r.mode && !room.includes(r.mode.toUpperCase()) ? `${r.mode} ` : '';
    const mapTxt = r.map && r.map.toUpperCase() !== r.mode?.toUpperCase()
      && !room.includes(r.map.toUpperCase()) ? `${r.map} ` : '';
    meta.textContent = `${modeTxt}${mapTxt}${r.players}/${r.maxPlayers}${scoreTxt}${r.winAt ? ` →${r.winAt}` : ''}${clock}`;
    row.append(star, name, meta);
    row.addEventListener('click', (): void => this.join(r.name));
    this.rows.append(row);
  }

  join(name: string, map?: string, bots?: number, mode?: string, unlisted?: boolean, noCreatures?: boolean, noBalls?: boolean): void {
    // Already there — a reload would boot us into the same seat anyway.
    // Offline solo has no room, so 'default' is a real join target.
    if (name === this.currentRoom() && this.online()) {return;}
    // map/bots/mode ride the URL so a disposed room rebuilds with its
    // spec intact — and so refresh/share land in this same match. A duel
    // session is mutually exclusive with a server room — drop it here.
    settings.set('fps-p2p', '');
    settings.set('fps-lobby', 0);
    const q = new URLSearchParams(window.location.search);
    q.delete('p2p'); q.delete('lobby');
    if (name === 'default') {
      // Live hop cleans the param; the reload path needs ?room=default
      // present or the boot won't connect at all.
      if (this.deps.switchRoom?.(name, map, bots, mode, unlisted, noCreatures, noBalls)) {
        q.delete('room');
        history.replaceState(null, '', q.toString() ? `${window.location.pathname}?${q}` : window.location.pathname);
        return;
      }
      q.set('room', 'default');
    } else {q.set('room', name);}
    for (const [k, v] of [['map', map], ['bots', bots], ['mode', mode]] as const) {
      if (v !== undefined && v !== '') {q.set(k, String(v));} else {q.delete(k);}
    }
    if (unlisted) {q.set('unlisted', '1');} else {q.delete('unlisted');}
    if (noCreatures) {q.set('nocreatures', '1');} else {q.delete('nocreatures');}
    if (noBalls) {q.set('noballs', '1');} else {q.delete('noballs');}
    const href = q.toString() ? `${window.location.pathname}?${q}` : window.location.pathname;
    // Live socket: hop in place — the gameState rebuild does the rest.
    if (this.deps.switchRoom?.(name, map, bots, mode, unlisted, noCreatures, noBalls)) {
      history.replaceState(null, '', href);
      return;
    }
    window.location.href = href;
  }
}
