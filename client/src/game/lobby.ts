/**
 * Lobby — room browser as a self-contained DOM module (chat.ts pattern:
 * own elements, own key routing, textContent-only).
 *
 * Joining a room is a reload with ?room=NAME because room membership is
 * fixed at connect time — the URL stays shareable, which is the whole
 * point of rooms. Mode is inherited from the room, not the URL.
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
}

const POLL_MS = 3000;

// Shared micro-styles — the lobby mirrors the ESC overlay's visual
// language (same panel tint, same #3aa7ff accent) instead of its own look.
const PANEL = 'background:rgba(8,11,16,0.75);border:1px solid rgba(255,255,255,0.07);color:#dde8f2;font-family:inherit;';
const LABEL = 'font-size:0.62rem;letter-spacing:0.2em;font-weight:600;color:rgba(140,170,195,0.6);margin-bottom:6px;';
const BTN = 'background:rgba(255,255,255,0.07);color:#cdd9e5;border:1px solid rgba(255,255,255,0.14);border-radius:6px;font-family:inherit;font-size:0.72rem;font-weight:600;letter-spacing:0.1em;cursor:pointer;text-transform:uppercase;padding:8px 10px;';
const INPUT = 'background:rgba(0,0,0,0.35);border:1px solid rgba(255,255,255,0.18);border-radius:4px;color:#fff;font-family:inherit;font-size:0.72rem;padding:5px 8px;outline:none;letter-spacing:0.08em;';

function btn(text: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.style.cssText = BTN;
  b.onmouseenter = () => { b.style.background = 'rgba(58,167,255,0.18)'; b.style.color = '#fff'; };
  b.onmouseleave = () => { b.style.background = 'rgba(255,255,255,0.07)'; b.style.color = '#cdd9e5'; };
  return b;
}

function field(label: string): HTMLDivElement {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 10px;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.14);border-radius:6px;font-size:0.68rem;font-weight:600;letter-spacing:0.1em;color:#cdd9e5;';
  const span = document.createElement('span');
  span.textContent = label;
  row.appendChild(span);
  return row;
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
    btn0.style.cssText += 'position:fixed;right:12px;bottom:12px;z-index:60;';
    btn0.onclick = () => this.toggle();

    this.panel = document.createElement('div');
    this.panel.style.cssText = `display:none;position:fixed;right:12px;bottom:52px;z-index:60;width:300px;${PANEL}border-radius:8px;padding:14px;font-size:0.72rem;`;

    const head = document.createElement('div');
    head.textContent = 'MATCHES';
    head.style.cssText = LABEL;
    this.here = document.createElement('div');
    this.here.style.cssText = 'color:#6fcf8f;font-size:0.62rem;margin-bottom:8px;letter-spacing:0.1em;';
    this.here.textContent = `IN: ${this.currentRoom().toUpperCase()}`;
    this.rows = document.createElement('div');
    this.rows.style.cssText = 'max-height:220px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;';

    // Match setup — pick a map (its spec carries the mode), optionally
    // override bot count, and the server spins or fills the right room.
    const hostLbl = document.createElement('div');
    hostLbl.textContent = 'HOST MATCH';
    hostLbl.style.cssText = LABEL + 'margin-top:12px;';
    const mapRow = field('MAP');
    this.mapSelect = document.createElement('select');
    this.mapSelect.style.cssText = INPUT + 'cursor:pointer;max-width:150px;';
    mapRow.appendChild(this.mapSelect);
    const botsRow = field('BOTS');
    this.botsInput = document.createElement('input');
    this.botsInput.type = 'number';
    this.botsInput.min = '0'; this.botsInput.max = '24';
    this.botsInput.placeholder = 'map default';
    this.botsInput.style.cssText = INPUT + 'width:110px;text-align:right;';
    this.botsInput.onkeydown = (e) => e.stopPropagation();
    botsRow.appendChild(this.botsInput);
    const hostBtn = btn('PLAY');
    hostBtn.style.cssText += 'width:100%;margin-top:6px;border-color:rgba(58,167,255,0.4);';
    hostBtn.onclick = async () => {
      hostBtn.disabled = true;
      try {
        const map = this.mapSelect.value;
        const mode = this.mapSelect.selectedOptions[0]?.dataset.mode ?? '';
        const bots = this.botsInput.value === '' ? undefined : Math.max(0, Math.min(24, Number(this.botsInput.value) || 0));
        this.join((await this.deps.quickJoin(mode, map || undefined, bots)).room, map || undefined, bots);
      } catch { hostBtn.disabled = false; }
    };

    const quickLbl = document.createElement('div');
    quickLbl.textContent = 'QUICK JOIN';
    quickLbl.style.cssText = LABEL + 'margin-top:12px;';
    const quick = document.createElement('div');
    quick.style.cssText = 'display:flex;gap:4px;margin-bottom:8px;';
    for (const mode of ['nuggets', 'ctf', 'dm', 'tdm']) {
      const b = btn(mode.toUpperCase());
      b.style.cssText += 'flex:1;padding:6px 0;text-align:center;';
      b.onclick = async () => {
        b.disabled = true;
        try { this.join((await this.deps.quickJoin(mode)).room); }
        catch { b.disabled = false; }
      };
      quick.appendChild(b);
    }

    const newWrap = document.createElement('div');
    newWrap.style.cssText = 'display:flex;gap:6px;margin-top:8px;';
    const input = document.createElement('input');
    input.maxLength = 32;
    input.placeholder = 'new room name';
    input.style.cssText = INPUT + 'flex:1;';
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && input.value.trim()) this.join(input.value.trim());
    };
    const create = btn('JOIN');
    create.onclick = () => input.value.trim() && this.join(input.value.trim());
    newWrap.append(input, create);

    // Server + P2P — the URL params ?server=/​?p2p= still work for links,
    // but these fields make them reachable without editing the URL.
    const connLbl = document.createElement('div');
    connLbl.textContent = 'CONNECTION';
    connLbl.style.cssText = LABEL + 'margin-top:12px;';
    const srvRow = field('SERVER');
    const srvIn = document.createElement('input');
    srvIn.placeholder = 'host (blank = local)';
    srvIn.value = settings.get('fps-server');
    srvIn.style.cssText = INPUT + 'flex:1;margin:0 6px;';
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
    p2pIn.style.cssText = INPUT + 'flex:1;min-width:70px;margin:0 6px;';
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
    for (const r of rooms) this.addRow(r);
  }

  private addRow(r: RoomRow): void {
    const row = document.createElement('button');
    row.style.cssText = 'display:block;width:100%;text-align:left;background:rgba(255,255,255,0.04);border:1px solid transparent;border-left:2px solid rgba(255,255,255,0.1);border-radius:4px;color:#dde8f2;font:inherit;padding:6px 10px;cursor:pointer;font-size:0.68rem;letter-spacing:0.06em;';
    row.onmouseenter = () => { row.style.background = 'rgba(58,167,255,0.12)'; row.style.borderLeftColor = '#3aa7ff'; };
    row.onmouseleave = () => { row.style.background = 'rgba(255,255,255,0.04)'; row.style.borderLeftColor = 'rgba(255,255,255,0.1)'; };
    const full = r.players >= r.maxPlayers;
    const current = r.name === this.currentRoom();
    if (full || current) { row.disabled = true; row.style.opacity = current ? '0.9' : '0.45'; }
    if (current) { row.style.borderLeftColor = '#6fcf8f'; }
    const name = document.createElement('span');
    name.textContent = r.name;
    const meta = document.createElement('span');
    meta.style.cssText = 'float:right;color:rgba(58,167,255,0.85);';
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
    const q = new URLSearchParams(location.search);
    if (name === 'default') q.delete('room');
    else q.set('room', name);
    // map/bots go along so a disposed room rebuilds with its spec intact.
    if (map) q.set('map', map); else q.delete('map');
    if (bots !== undefined) q.set('bots', String(bots)); else q.delete('bots');
    location.href = `${location.pathname}?${q.toString()}`;
  }
}
