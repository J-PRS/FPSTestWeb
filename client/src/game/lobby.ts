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

function btn(text: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.className = 'lb-btn';
  return b;
}

function field(text: string): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'lb-field';
  const span = document.createElement('span');
  span.textContent = text;
  row.appendChild(span);
  return row;
}

function label(text: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = 'lb-label lb-spaced';
  d.textContent = text;
  return d;
}

/** Buttons persist to settings then reload so the URL params stay the
 *  single source of truth (?p2p=/?lobby). */
function p2pGo(p2p: string, lobby: number): void {
  settings.set('fps-p2p', p2p);
  settings.set('fps-lobby', lobby);
  location.reload();
}

function buildP2PButtons(p2pIn: HTMLInputElement): HTMLDivElement {
  const code = () => p2pIn.value.trim() || 'duel';
  const wrap = document.createElement('div');
  wrap.className = 'lb-quick';
  const specs: [string, () => void][] = [
    ['HOST', () => p2pGo(`host:${code()}`, 0)],
    ['JOIN', () => p2pGo(`join:${code()}`, 0)],
    // Open lobby: host publicly — anyone pressing QUICK lands here.
    ['HOST OPEN', () => p2pGo(`host:${code()}`, 1)],
    // Quick join: the relay hands back the oldest open lobby.
    ['QUICK', () => p2pGo('quick', 0)],
    ['OFF', () => p2pGo('', 0)],
  ];
  for (const [text, fn] of specs) {
    const b = btn(text);
    b.addEventListener('click', fn);
    wrap.appendChild(b);
  }
  return wrap;
}

export class Lobby {
  private panel: HTMLDivElement;
  private rows: HTMLDivElement;
  private here: HTMLDivElement;
  private mapSelect: HTMLSelectElement;
  private modeSelect: HTMLSelectElement;
  private botsInput: HTMLInputElement;
  private maps: MapRow[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  private currentRoom(): string {
    return new URLSearchParams(location.search).get('room') ?? 'default';
  }

  constructor(private deps: LobbyDeps) {
    // The trigger lives in the ESC menu (#lobby-open in index.html) —
    // a floating HUD button during gameplay was HUD clutter. The panel
    // mounts inside #overlay so menu-close takes it down too.
    const openBtn = document.getElementById('lobby-open');
    if (openBtn) openBtn.addEventListener('click', () => this.toggle());

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

    // Match setup — mode (ruleset) and map (geometry) are separate picks:
    // MODE filters which maps are offered, MAP picks the arena. Bot count
    // can override the spec default.
    const hostLbl = label('HOST MATCH');
    const modeRow = field('MODE');
    this.modeSelect = document.createElement('select');
    this.modeSelect.className = 'lb-input';
    this.modeSelect.style.cssText = 'cursor:pointer;flex:1;min-width:0;';
    this.modeSelect.addEventListener('change', () => this.fillMapSelect());
    modeRow.appendChild(this.modeSelect);
    const mapRow = field('MAP');
    this.mapSelect = document.createElement('select');
    this.mapSelect.className = 'lb-input';
    this.mapSelect.style.cssText = 'cursor:pointer;flex:1;min-width:0;';
    mapRow.appendChild(this.mapSelect);
    const botsRow = field('BOTS');
    this.botsInput = document.createElement('input');
    this.botsInput.type = 'number';
    this.botsInput.min = '0'; this.botsInput.max = '24';
    this.botsInput.placeholder = 'map default';
    this.botsInput.className = 'lb-input';
    this.botsInput.style.cssText = 'width:110px;text-align:right;';
    this.botsInput.addEventListener('keydown', (e) => e.stopPropagation());
    botsRow.appendChild(this.botsInput);
    const hostBtn = btn('PLAY');
    hostBtn.style.cssText = 'width:100%;margin-top:6px;border-color:rgba(58,167,255,0.4);';
    hostBtn.addEventListener('click', async () => {
      hostBtn.disabled = true;
      try {
        const map = this.mapSelect.value;
        // ANY = let the map's own spec decide the ruleset.
        const mode = this.modeSelect.value || this.mapSelect.selectedOptions[0]?.dataset.mode || '';
        const bots = this.botsInput.value === '' ? undefined : Math.max(0, Math.min(24, Number(this.botsInput.value) || 0));
        this.join((await this.deps.quickJoin(mode, map || undefined, bots)).room, map || undefined, bots);
      } catch { hostBtn.disabled = false; }
    });

    const quickLbl = label('QUICK JOIN');
    const quick = document.createElement('div');
    quick.className = 'lb-quick';
    for (const mode of ['nuggets', 'ctf', 'dm', 'tdm']) {
      const b = btn(mode.toUpperCase());
      b.addEventListener('click', async () => {
        b.disabled = true;
        try { this.join((await this.deps.quickJoin(mode)).room); }
        catch { b.disabled = false; }
      });
      quick.appendChild(b);
    }

    const newWrap = document.createElement('div');
    newWrap.className = 'lb-newrow';
    const input = document.createElement('input');
    input.maxLength = 32;
    input.placeholder = 'new room name';
    input.className = 'lb-input';
    input.style.flex = '1';
    // Named-room joins honor the HOST MATCH pickers — a fresh room spins up
    // from the selected spec + bot count instead of always landing bare.
    const named = () => {
      const v = input.value.trim();
      if (!v) return;
      const map = this.mapSelect.value || undefined;
      const mode = this.modeSelect.value || this.mapSelect.selectedOptions[0]?.dataset.mode || undefined;
      const bots = this.botsInput.value === '' ? undefined : Math.max(0, Math.min(24, Number(this.botsInput.value) || 0));
      this.join(v, map, bots, mode);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') named();
    });
    const create = btn('JOIN');
    create.addEventListener('click', named);
    newWrap.append(input, create);

    // Server + P2P — the URL params ?server=/?p2p= still work for links,
    // but these fields make them reachable without editing the URL.
    const connLbl = label('CONNECTION');
    const srvRow = field('SERVER');
    const srvIn = document.createElement('input');
    srvIn.placeholder = 'host (blank = local)';
    srvIn.value = settings.get('fps-server');
    srvIn.className = 'lb-input';
    srvIn.style.cssText = 'flex:1;min-width:0;';
    srvIn.addEventListener('keydown', (e) => e.stopPropagation());
    const srvBtn = btn('GO');
    srvBtn.addEventListener('click', () => { settings.set('fps-server', srvIn.value.trim()); location.reload(); });
    srvRow.append(srvIn, srvBtn);

    const p2pRow = field('P2P DUEL');
    const p2pIn = document.createElement('input');
    p2pIn.maxLength = 24;
    p2pIn.placeholder = 'code';
    // Strip the role prefix for display; the saved value is 'role:code'.
    const savedP2p = settings.get('fps-p2p');
    p2pIn.value = savedP2p.includes(':') ? savedP2p.slice(savedP2p.indexOf(':') + 1) : '';
    p2pIn.className = 'lb-input';
    p2pIn.style.cssText = 'flex:1;min-width:0;';
    p2pIn.addEventListener('keydown', (e) => e.stopPropagation());
    p2pRow.appendChild(p2pIn);
    const p2pBtns = buildP2PButtons(p2pIn);

    this.panel.append(head, this.here, this.rows, hostLbl, modeRow, mapRow, botsRow, hostBtn, quickLbl, quick, newWrap, connLbl, srvRow, p2pRow, p2pBtns);
    (document.getElementById('overlay') ?? document.body).appendChild(this.panel);
    // Menu closed while the panel was open (resume / re-lock) — display:none
    // hides it anyway, but the poll timer would keep burning for nothing.
    new MutationObserver(() => {
      if (!document.body.classList.contains('menu-open') && this.panel.style.display !== 'none') this.toggle();
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
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
  private fillMapSelect(): void {
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

  private toggle(): void {
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

  private join(name: string, map?: string, bots?: number, mode?: string): void {
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
