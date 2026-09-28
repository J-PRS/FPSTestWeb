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

export interface LobbyDeps {
  /** GETs {name, mode?, players, maxPlayers}[]; throws when offline. */
  listRooms(): Promise<RoomRow[]>;
  /** GET /join?mode — server picks the emptiest live match (or makes one). */
  quickJoin(mode: string): Promise<{ room: string }>;
}

const POLL_MS = 3000;

export class Lobby {
  private panel: HTMLDivElement;
  private rows: HTMLDivElement;
  private here: HTMLDivElement;
  private timer: ReturnType<typeof setInterval> | null = null;

  private currentRoom(): string {
    return new URLSearchParams(location.search).get('room') ?? 'default';
  }

  constructor(private deps: LobbyDeps) {
    const btn = document.createElement('button');
    btn.textContent = 'LOBBY';
    btn.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:60;font:12px monospace;padding:4px 10px;background:rgba(0,0,0,.6);color:#9cf;border:1px solid #345;cursor:pointer;';
    btn.onclick = () => this.toggle();

    this.panel = document.createElement('div');
    this.panel.style.cssText = 'display:none;position:fixed;right:12px;bottom:44px;z-index:60;min-width:260px;background:rgba(0,0,0,.85);border:1px solid #345;color:#fff;font:13px monospace;padding:8px;';

    const head = document.createElement('div');
    head.textContent = 'ROOMS';
    head.style.cssText = 'color:#9cf;margin-bottom:6px;letter-spacing:1px;';
    this.here = document.createElement('div');
    this.here.style.cssText = 'color:#7d8;font-size:11px;margin-bottom:4px;';
    this.here.textContent = `in: ${this.currentRoom()}`;
    this.rows = document.createElement('div');

    const newWrap = document.createElement('div');
    newWrap.style.cssText = 'display:flex;gap:6px;margin-top:8px;';
    const input = document.createElement('input');
    input.maxLength = 32;
    input.placeholder = 'new room name';
    input.style.cssText = 'flex:1;background:#111;border:1px solid #444;color:#fff;font:inherit;padding:3px 6px;outline:none;';
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && input.value.trim()) this.join(input.value.trim());
    };
    const create = document.createElement('button');
    create.textContent = 'CREATE';
    create.style.cssText = 'background:#16303f;border:1px solid #345;color:#9cf;font:inherit;padding:3px 8px;cursor:pointer;';
    create.onclick = () => input.value.trim() && this.join(input.value.trim());
    newWrap.append(input, create);

    const quick = document.createElement('div');
    quick.style.cssText = 'display:flex;gap:4px;margin:6px 0;';
    for (const mode of ['nuggets', 'ctf', 'dm', 'tdm']) {
      const b = document.createElement('button');
      b.textContent = mode.toUpperCase();
      b.style.cssText = 'flex:1;background:#16303f;border:1px solid #345;color:#9cf;font:inherit;padding:3px 0;cursor:pointer;';
      b.onclick = async () => {
        b.disabled = true;
        try { this.join((await this.deps.quickJoin(mode)).room); }
        catch { b.disabled = false; }
      };
      quick.appendChild(b);
    }

    // Server + P2P — the URL params ?server=/​?p2p= still work for links,
    // but these fields make them reachable without editing the URL.
    const srvRow = document.createElement('div');
    srvRow.style.cssText = 'display:flex;gap:6px;margin-top:8px;align-items:center;';
    const srvLbl = document.createElement('span');
    srvLbl.textContent = 'SERVER';
    srvLbl.style.cssText = 'color:#9cf;font-size:11px;';
    const srvIn = document.createElement('input');
    srvIn.placeholder = 'host (blank = this machine)';
    srvIn.value = settings.get('fps-server');
    srvIn.style.cssText = 'flex:1;background:#111;border:1px solid #444;color:#fff;font:inherit;padding:3px 6px;outline:none;';
    srvIn.onkeydown = (e) => e.stopPropagation();
    const srvBtn = document.createElement('button');
    srvBtn.textContent = 'GO';
    srvBtn.style.cssText = 'background:#16303f;border:1px solid #345;color:#9cf;font:inherit;padding:3px 8px;cursor:pointer;';
    srvBtn.onclick = () => { settings.set('fps-server', srvIn.value.trim()); location.reload(); };
    srvRow.append(srvLbl, srvIn, srvBtn);

    const p2pRow = document.createElement('div');
    p2pRow.style.cssText = 'display:flex;gap:6px;margin-top:6px;align-items:center;';
    const p2pLbl = document.createElement('span');
    p2pLbl.textContent = 'P2P DUEL';
    p2pLbl.style.cssText = 'color:#9cf;font-size:11px;';
    const p2pIn = document.createElement('input');
    p2pIn.maxLength = 24;
    p2pIn.placeholder = 'code (blank = off)';
    // Strip the role prefix for display; the saved value is 'role:code'.
    const savedP2p = settings.get('fps-p2p');
    p2pIn.value = savedP2p.includes(':') ? savedP2p.slice(savedP2p.indexOf(':') + 1) : '';
    p2pIn.style.cssText = 'flex:1;background:#111;border:1px solid #444;color:#fff;font:inherit;padding:3px 6px;outline:none;';
    p2pIn.onkeydown = (e) => e.stopPropagation();
    for (const role of ['host', 'join'] as const) {
      const b = document.createElement('button');
      b.textContent = role.toUpperCase();
      b.style.cssText = 'background:#16303f;border:1px solid #345;color:#9cf;font:inherit;padding:3px 8px;cursor:pointer;';
      b.onclick = () => {
        const code = p2pIn.value.trim() || 'duel';
        settings.set('fps-p2p', `${role}:${code}`);
        location.reload();
      };
      p2pRow.append(p2pLbl, p2pIn, b);
    }
    const p2pOff = document.createElement('button');
    p2pOff.textContent = 'OFF';
    p2pOff.style.cssText = 'background:#3f1616;border:1px solid #543;color:#f99;font:inherit;padding:3px 8px;cursor:pointer;';
    p2pOff.onclick = () => { settings.set('fps-p2p', ''); location.reload(); };
    p2pRow.appendChild(p2pOff);

    this.panel.append(head, this.here, quick, this.rows, newWrap, srvRow, p2pRow);
    document.body.append(btn, this.panel);
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
    row.style.cssText = 'display:block;width:100%;text-align:left;background:none;border:none;border-bottom:1px solid #222;color:#fff;font:inherit;padding:4px 2px;cursor:pointer;';
    const full = r.players >= r.maxPlayers;
    const current = r.name === this.currentRoom();
    if (full || current) { row.disabled = true; row.style.opacity = current ? '0.8' : '0.45'; }
    if (current) row.style.color = '#7d8';
    const name = document.createElement('span');
    name.textContent = r.name;
    const meta = document.createElement('span');
    meta.style.cssText = 'float:right;color:#9cf;';
    const scoreTxt = r.scores ? `  ${r.scores.alpha}:${r.scores.bravo}`
      : r.ffaLeader ? `  ${r.ffaLeader[0]} ${r.ffaLeader[1]}pts` : '';
    const clock = r.timeLeftMs ? ` ${Math.ceil(r.timeLeftMs / 60000)}m` : '';
    meta.textContent = `${r.mode ? r.mode + ' ' : ''}${r.players}/${r.maxPlayers}${scoreTxt}${r.winAt ? ` →${r.winAt}` : ''}${clock}`;
    row.append(name, meta);
    row.onclick = () => this.join(r.name);
    this.rows.appendChild(row);
  }

  private join(name: string): void {
    // Already there — a reload would boot us into the same seat anyway.
    if (name === this.currentRoom()) return;
    const q = new URLSearchParams(location.search);
    if (name === 'default') q.delete('room');
    else q.set('room', name);
    location.href = `${location.pathname}?${q.toString()}`;
  }
}
