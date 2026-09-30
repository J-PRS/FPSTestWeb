/**
 * Scoreboard — the Tab-key roster overlay: visibility toggle, row data,
 * and the 4Hz re-render that splits rows into team sections when any
 * row carries a team. Extracted from hud.ts; HUD forwards the setters.
 */

export type SbRow = {
  name: string; frags: number; score: number | null; ping: number | null;
  net?: string | null; self: boolean; dead: boolean;
  team?: 'alpha' | 'bravo'; sheep?: number | null;
};

// textContent, not innerHTML — display names will be player-chosen
// strings; interpolating them raw is a stored-XSS hole in waiting.
function sbRowEl(r: SbRow): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.className = `${r.self ? 'self' : ''}${r.dead ? ' dead' : ''}${r.team ? ` sb-${r.team}` : ''}`;
  for (const cell of [r.name, String(r.frags), r.score === null ? '—' : String(r.score), r.net ?? '—', r.ping === null ? '—' : String(Math.round(r.ping)), r.sheep == null ? '—' : `${Math.round(r.sheep)}%`]) {
    const td = document.createElement('td');
    td.textContent = cell;
    tr.appendChild(td);
  }
  return tr;
}

export class Scoreboard {
  private visible = false;
  private refresh = 0;
  private rows: SbRow[] = [];

  constructor(
    private root: HTMLDivElement,
    private tbody: HTMLElement,
  ) {}

  setVisible(v: boolean): void {
    this.visible = v;
    this.root.style.display = v ? 'block' : 'none';
    if (v) this.refresh = 0; // force render on open
  }

  get isVisible(): boolean { return this.visible; }

  setRows(rows: SbRow[]): void {
    this.rows = rows;
  }

  /** 4Hz re-render while open — cheap enough that diffing row state
   *  isn't worth the bookkeeping. */
  tick(dt: number): void {
    if (!this.visible) return;
    this.refresh -= dt;
    if (this.refresh > 0) return;
    this.refresh = 0.25;
    // Any row carrying a team → split into sections; otherwise flat FFA.
    const hasTeams = this.rows.some(r => r.team);
    if (!hasTeams) {
      this.tbody.replaceChildren(...this.rows.map(sbRowEl));
      return;
    }
    const kids: HTMLElement[] = [];
    for (const team of ['alpha', 'bravo'] as const) {
      const trs = this.rows.filter(r => r.team === team).map(sbRowEl);
      if (!trs.length) continue;
      const th = document.createElement('tr');
      th.className = `sb-team ${team}`;
      const td = document.createElement('td');
      td.colSpan = 5;
      td.textContent = team.toUpperCase();
      th.appendChild(td);
      kids.push(th, ...trs);
    }
    // Teamless stragglers (spectators, unteamed) under their own header.
    const rest = this.rows.filter(r => !r.team);
    if (rest.length) kids.push(...rest.map(sbRowEl));
    this.tbody.replaceChildren(...kids);
  }
}
