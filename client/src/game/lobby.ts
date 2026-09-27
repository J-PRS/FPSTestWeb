/**
 * Lobby — room browser as a self-contained DOM module (chat.ts pattern:
 * own elements, own key routing, textContent-only).
 *
 * Joining a room is a reload with ?room=NAME because room membership is
 * fixed at connect time — the URL stays shareable, which is the whole
 * point of rooms. Mode is inherited from the room, not the URL.
 */

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
  private timer: ReturnType<typeof setInterval> | null = null;

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
    for (const mode of ['nuggets', 'ctf', 'dm']) {
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

    this.panel.append(head, quick, this.rows, newWrap);
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
    if (full) { row.disabled = true; row.style.opacity = '0.45'; }
    const name = document.createElement('span');
    name.textContent = r.name;
    const meta = document.createElement('span');
    meta.style.cssText = 'float:right;color:#9cf;';
    const scoreTxt = r.scores ? `  ${r.scores.alpha}:${r.scores.bravo}`
      : r.ffaLeader ? `  ${r.ffaLeader[0]} ${r.ffaLeader[1]}pts` : '';
    meta.textContent = `${r.mode ? r.mode + ' ' : ''}${r.players}/${r.maxPlayers}${scoreTxt}${r.winAt ? ` →${r.winAt}` : ''}`;
    row.append(name, meta);
    row.onclick = () => this.join(r.name);
    this.rows.appendChild(row);
  }

  private join(name: string): void {
    const q = new URLSearchParams(location.search);
    if (name === 'default') q.delete('room');
    else q.set('room', name);
    location.href = `${location.pathname}?${q.toString()}`;
  }
}
