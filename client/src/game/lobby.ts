/**
 * Lobby — room browser as a self-contained DOM module (chat.ts pattern:
 * own elements, own key routing, textContent-only).
 *
 * Joining a room first tries an in-place hop — the server's switchRoom
 * re-seats the live session and answers with a fresh gameState the normal
 * reconnect path rebuilds from. Offline/degraded clients fall back to the
 * ?room=NAME reload, which stays the shareable link either way.
 */

import { buildLobbyPanel } from './lobbyPanel.js';

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
}

export interface LobbyDeps {
  /** GETs {name, mode?, players, maxPlayers}[]; throws when offline. */
  listRooms(): Promise<RoomRow[]>;
  /** GET /maps — playable map list for the match-setup picker. */
  listMaps(): Promise<MapRow[]>;
  /** GET /join?mode&map&bots — server picks the emptiest live match
   *  fitting the request (or spins a fresh room from the map spec). */
  quickJoin(mode: string, map?: string, bots?: number): Promise<{ room: string }>;
  /** In-place room hop over the live socket — false when there's no
   *  connection (caller reloads instead). map/bots/mode are creation
   *  hints for a room that doesn't exist yet. */
  switchRoom?(name: string, map?: string, bots?: number, mode?: string): boolean;
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
  private maps: MapRow[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  currentRoom(): string {
    return new URLSearchParams(location.search).get('room') ?? 'default';
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
  }

  /** Populate the mode + map pickers once per open — cheap, menu is
   *  user-paced. Mode select lists the union of every map's legal modes. */
  private async refreshMaps(): Promise<void> {
    try {
      this.maps = await this.deps.listMaps();
    } catch {
      this.maps = [];
    }
    this.modeSelect.textContent = '';
    const any = document.createElement('option');
    any.value = ''; any.textContent = 'ANY';
    this.modeSelect.appendChild(any);
    const modes = [...new Set(this.maps.flatMap((m) => m.modes.length ? m.modes : (m.mode ? [m.mode] : [])))].toSorted();
    for (const mode of modes) {
      const o = document.createElement('option');
      o.value = mode;
      o.textContent = mode.toUpperCase();
      this.modeSelect.appendChild(o);
    }
    this.fillMapSelect();
  }

  /** Refill MAP for the chosen MODE — a map only shows the modes it
   *  declares, so the list shrinks to the legal arenas. */
  fillMapSelect(): void {
    const mode = this.modeSelect.value;
    this.mapSelect.textContent = '';
    if (!this.maps.length) {
      const o = document.createElement('option');
      o.textContent = 'server default';
      o.value = ''; o.dataset.mode = '';
      this.mapSelect.appendChild(o);
      return;
    }
    const rows = mode ? this.maps.filter((m) => (m.modes.length ? m.modes : [m.mode]).includes(mode)) : this.maps;
    if (!rows.length) {
      const o = document.createElement('option');
      o.textContent = `no ${mode} maps`;
      o.value = ''; o.dataset.mode = '';
      this.mapSelect.appendChild(o);
      return;
    }
    for (const m of rows) {
      const o = document.createElement('option');
      o.value = m.name;
      o.dataset.mode = mode || m.mode;
      // Label shows the default ruleset so a shared map doesn't pretend
      // the pick is unique to the selected mode.
      o.textContent = `${m.name.toUpperCase()}${m.mode ? ` · ${m.mode.toUpperCase()}` : ''}${m.bots ? ` · ${m.bots} bots` : ''}`;
      this.mapSelect.appendChild(o);
    }
  }

  toggle(): void {
    const open = this.panel.style.display !== 'none';
    if (open) {
      this.panel.style.display = 'none';
      document.body.classList.remove('lobby-open');
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    } else {
      this.panel.style.display = 'block';
      document.body.classList.add('lobby-open');
      void this.refresh();
      void this.refreshMaps();
      this.timer = setInterval(() => void this.refresh(), POLL_MS);
    }
  }

  private async refresh(): Promise<void> {
    this.rows.textContent = '';
    let rooms: RoomRow[];
    try {
      rooms = await this.deps.listRooms();
    } catch {
      const err = document.createElement('div');
      err.style.color = '#f88';
      err.textContent = 'server offline';
      this.rows.appendChild(err);
      return;
    }
    // Default lobby first — it's the immortal room.
    rooms.sort((a, b) => (a.name === 'default' ? -1 : b.name === 'default' ? 1 : a.name.localeCompare(b.name)));
    const cur = rooms.find((r) => r.name === this.currentRoom());
    this.here.textContent = `IN: ${this.currentRoom().toUpperCase()}${cur?.mode ? ` · ${cur.mode.toUpperCase()}` : ''}${cur?.map ? ` · ${cur.map.toUpperCase()}` : ''}`;
    for (const r of rooms) this.addRow(r);
  }

  private addRow(r: RoomRow): void {
    const row = document.createElement('button');
    row.className = 'lb-room';
    const full = r.players >= r.maxPlayers;
    const current = r.name === this.currentRoom();
    if (full || current) row.disabled = true;
    if (current) row.classList.add('current');
    if (full) row.classList.add('full');
    const name = document.createElement('span');
    name.textContent = r.name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    const scoreTxt = r.scores ? `  ${r.scores.alpha}:${r.scores.bravo}`
      : r.ffaLeader ? `  ${r.ffaLeader[0]} ${r.ffaLeader[1]}pts` : '';
    const clock = r.timeLeftMs ? ` ${Math.ceil(r.timeLeftMs / 60000)}m` : '';
    meta.textContent = `${r.mode ? r.mode + ' ' : ''}${r.map ? r.map + ' ' : ''}${r.players}/${r.maxPlayers}${scoreTxt}${r.winAt ? ` →${r.winAt}` : ''}${clock}`;
    row.append(name, meta);
    row.addEventListener('click', () => this.join(r.name));
    this.rows.appendChild(row);
  }

  join(name: string, map?: string, bots?: number, mode?: string): void {
    // Already there — a reload would boot us into the same seat anyway.
    if (name === this.currentRoom()) return;
    // map/bots/mode ride the URL so a disposed room rebuilds with its
    // spec intact — and so refresh/share land in this same match.
    const q = new URLSearchParams(location.search);
    if (name === 'default') q.delete('room');
    else q.set('room', name);
    for (const [k, v] of [['map', map], ['bots', bots], ['mode', mode]] as const) {
      if (v !== undefined && v !== '') q.set(k, String(v)); else q.delete(k);
    }
    const href = `${location.pathname}?${q.toString()}`;
    // Live socket: hop in place — the gameState rebuild does the rest.
    if (this.deps.switchRoom?.(name, map, bots, mode)) {
      history.replaceState(null, '', href);
      return;
    }
    location.href = href;
  }
}
