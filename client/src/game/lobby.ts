/**
 * Lobby — room browser as a self-contained DOM module (chat.ts pattern:
 * own elements, own key routing, textContent-only).
 *
 * Joining a room first tries an in-place hop — the server's switchRoom
 * re-seats the live session and answers with a fresh gameState the normal
 * reconnect path rebuilds from. Offline/degraded clients fall back to the
 * ?room=NAME reload, which stays the shareable link either way.
 */

import { settings } from '../core/settings.js';

export interface RoomRow {
  name: string;
  mode?: string;
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
  mode: string;
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
   *  connection (caller reloads instead). map/bots are creation hints for
   *  a room that doesn't exist yet. */
  switchRoom?(name: string, map?: string, bots?: number): boolean;
}

const POLL_MS = 3000;

// Styling lives in ui/chrome.css (.lb-* classes) — this module only
// builds structure and wires behavior.

function btn(text: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.className = 'lb-btn';
  return b;
}

function field(label: string): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'lb-field';
  const span = document.createElement('span');
  span.textContent = label;
  row.appendChild(span);
  return row;
}

function label(text: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = 'lb-label lb-spaced';
  d.textContent = text;
  return d;
}

export class Lobby {
  private panel: HTMLDivElement;
  private rows: HTMLDivElement;
  private here: HTMLDivElement;
  private mapSelect: HTMLSelectElement;
  private botsInput: HTMLInputElement;
  private timer: ReturnType<typeof setInterval> | null = null;

  private currentRoom(): string {
    return new URLSearchParams(location.search).get('room') ?? 'default';
  }

  constructor(private deps: LobbyDeps) {
    const btn0 = btn('LOBBY');
    btn0.classList.add('lb-open');
    btn0.onclick = () => this.toggle();

    this.panel = document.createElement('div');
    this.panel.className = 'lb-panel';
    this.panel.style.display = 'none';

    const head = label('MATCHES');
    head.style.marginTop = '0';
    this.here = document.createElement('div');
    this.here.className = 'lb-here';
    this.here.textContent = `IN: ${this.currentRoom().toUpperCase()}`;
    this.rows = document.createElement('div');
    this.rows.className = 'lb-rows';

    // Match setup — pick a map (its spec carries the mode), optionally
    // override bot count, and the server spins or fills the right room.
    const hostLbl = label('HOST MATCH');
    const mapRow = field('MAP');
    this.mapSelect = document.createElement('select');
    this.mapSelect.className = 'lb-input';
    this.mapSelect.style.cssText = 'cursor:pointer;max-width:150px;';
    mapRow.appendChild(this.mapSelect);
    const botsRow = field('BOTS');
    this.botsInput = document.createElement('input');
    this.botsInput.type = 'number';
    this.botsInput.min = '0'; this.botsInput.max = '24';
    this.botsInput.placeholder = 'map default';
    this.botsInput.className = 'lb-input';
    this.botsInput.style.cssText = 'width:110px;text-align:right;';
    this.botsInput.onkeydown = (e) => e.stopPropagation();
    botsRow.appendChild(this.botsInput);
    const hostBtn = btn('PLAY');
    hostBtn.style.cssText = 'width:100%;margin-top:6px;border-color:rgba(58,167,255,0.4);';
    hostBtn.onclick = async () => {
      hostBtn.disabled = true;
      try {
        const map = this.mapSelect.value;
        const mode = this.mapSelect.selectedOptions[0]?.dataset.mode ?? '';
        const bots = this.botsInput.value === '' ? undefined : Math.max(0, Math.min(24, Number(this.botsInput.value) || 0));
        this.join((await this.deps.quickJoin(mode, map || undefined, bots)).room, map || undefined, bots);
      } catch { hostBtn.disabled = false; }
    };

    const quickLbl = label('QUICK JOIN');
    const quick = document.createElement('div');
    quick.className = 'lb-quick';
    for (const mode of ['nuggets', 'ctf', 'dm', 'tdm']) {
      const b = btn(mode.toUpperCase());
      b.onclick = async () => {
        b.disabled = true;
        try { this.join((await this.deps.quickJoin(mode)).room); }
        catch { b.disabled = false; }
      };
      quick.appendChild(b);
    }

    const newWrap = document.createElement('div');
    newWrap.className = 'lb-newrow';
    const input = document.createElement('input');
    input.maxLength = 32;
    input.placeholder = 'new room name';
    input.className = 'lb-input';
    input.style.flex = '1';
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && input.value.trim()) this.join(input.value.trim());
    };
    const create = btn('JOIN');
    create.onclick = () => input.value.trim() && this.join(input.value.trim());
    newWrap.append(input, create);

    // Server + P2P — the URL params ?server=/​?p2p= still work for links,
    // but these fields make them reachable without editing the URL.
    const connLbl = label('CONNECTION');
    const srvRow = field('SERVER');
    const srvIn = document.createElement('input');
    srvIn.placeholder = 'host (blank = local)';
    srvIn.value = settings.get('fps-server');
    srvIn.className = 'lb-input';
    srvIn.style.cssText = 'flex:1;margin:0 6px;';
    srvIn.onkeydown = (e) => e.stopPropagation();
    const srvBtn = btn('GO');
    srvBtn.onclick = () => { settings.set('fps-server', srvIn.value.trim()); location.reload(); };
    srvRow.append(srvIn, srvBtn);

    const p2pRow = field('P2P DUEL');
    p2pRow.style.flexWrap = 'wrap';
    const p2pIn = document.createElement('input');
    p2pIn.maxLength = 24;
    p2pIn.placeholder = 'code';
    // Strip the role prefix for display; the saved value is 'role:code'.
    const savedP2p = settings.get('fps-p2p');
    p2pIn.value = savedP2p.includes(':') ? savedP2p.slice(savedP2p.indexOf(':') + 1) : '';
    p2pIn.className = 'lb-input';
    p2pIn.style.cssText = 'flex:1;min-width:70px;margin:0 6px;';
    p2pIn.onkeydown = (e) => e.stopPropagation();
    p2pRow.appendChild(p2pIn);
    for (const role of ['host', 'join'] as const) {
      const b = btn(role.toUpperCase());
      b.style.padding = '5px 8px';
      b.onclick = () => {
        const code = p2pIn.value.trim() || 'duel';
        settings.set('fps-p2p', `${role}:${code}`);
        location.reload();
      };
      p2pRow.appendChild(b);
    }
    const p2pOff = btn('OFF');
    p2pOff.style.padding = '5px 8px';
    p2pOff.onclick = () => { settings.set('fps-p2p', ''); location.reload(); };
    p2pRow.appendChild(p2pOff);

    this.panel.append(head, this.here, this.rows, hostLbl, mapRow, botsRow, hostBtn, quickLbl, quick, newWrap, connLbl, srvRow, p2pRow);
    document.body.append(btn0, this.panel);
  }

  /** Populate the map picker once per open — cheap, menu is user-paced. */
  private async refreshMaps(): Promise<void> {
    try {
      const maps = await this.deps.listMaps();
      this.mapSelect.textContent = '';
      if (!maps.length) {
        const o = document.createElement('option');
        o.textContent = 'server default';
        o.value = ''; o.dataset.mode = '';
        this.mapSelect.appendChild(o);
        return;
      }
      for (const m of maps) {
        const o = document.createElement('option');
        o.value = m.name;
        o.dataset.mode = m.mode;
        o.textContent = `${m.name.toUpperCase()}${m.mode ? ` · ${m.mode.toUpperCase()}` : ''}${m.bots ? ` · ${m.bots} bots` : ''}`;
        this.mapSelect.appendChild(o);
      }
    } catch {
      this.mapSelect.textContent = '';
      const o = document.createElement('option');
      o.textContent = 'maps unavailable';
      o.value = ''; o.dataset.mode = '';
      this.mapSelect.appendChild(o);
    }
  }

  private toggle(): void {
    const open = this.panel.style.display !== 'none';
    if (open) {
      this.panel.style.display = 'none';
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    } else {
      this.panel.style.display = 'block';
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
    this.here.textContent = `IN: ${this.currentRoom().toUpperCase()}${cur?.mode ? ` · ${cur.mode.toUpperCase()}` : ''}`;
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
    meta.textContent = `${r.mode ? r.mode + ' ' : ''}${r.players}/${r.maxPlayers}${scoreTxt}${r.winAt ? ` →${r.winAt}` : ''}${clock}`;
    row.append(name, meta);
    row.onclick = () => this.join(r.name);
    this.rows.appendChild(row);
  }

  private join(name: string, map?: string, bots?: number): void {
    // Already there — a reload would boot us into the same seat anyway.
    if (name === this.currentRoom()) return;
    // Live socket: hop in place — the gameState rebuild does the rest.
    // Keep the URL honest so refresh/share still lands in this room.
    if (this.deps.switchRoom?.(name, map, bots)) {
      const q = new URLSearchParams(location.search);
      if (name === 'default') q.delete('room');
      else q.set('room', name);
      if (map) q.set('map', map); else q.delete('map');
      if (bots !== undefined) q.set('bots', String(bots)); else q.delete('bots');
      history.replaceState(null, '', `${location.pathname}?${q.toString()}`);
      return;
    }
    const q = new URLSearchParams(location.search);
    if (name === 'default') q.delete('room');
    else q.set('room', name);
    // map/bots go along so a disposed room rebuilds with its spec intact.
    if (map) q.set('map', map); else q.delete('map');
    if (bots !== undefined) q.set('bots', String(bots)); else q.delete('bots');
    location.href = `${location.pathname}?${q.toString()}`;
  }
}
