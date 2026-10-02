/**
 * Scoreboard — the Tab-key roster overlay: visibility toggle, row data,
 * and the 4Hz re-render that splits rows into team sections when any
 * row carries a team. Extracted from hud.ts; HUD forwards the setters.
 */

import type { TeamId } from '../../../../shared/teams.js';

export type SbRow = {
  name: string; frags: number; score: number | null; ping: number | null;
  net?: string | null; self: boolean; dead: boolean;
  team?: TeamId; sheep?: number | null; bot?: boolean;
  /** Seconds since last spawn/respawn — null while dead. */
  alive?: number | null;
};

// textContent, not innerHTML — display names will be player-chosen
// strings; interpolating them raw is a stored-XSS hole in waiting.
// The ◆/● glyph mirrors the HUD marker shapes (diamond = human,
// round = bot) so the roster doubles as the legend for the icon split.
function sbRowEl(r: SbRow, num = ''): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.className = `${r.self ? 'self' : ''}${r.dead ? ' dead' : ''}${r.team ? ` sb-${r.team}` : ''}`;
  const cells = [String(r.frags), r.score === null ? '—' : String(r.score), r.net ?? '—', r.ping === null ? '—' : String(Math.round(r.ping)), r.sheep == null ? '—' : `${Math.round(r.sheep)}%`, r.alive == null ? '—' : `${r.alive}s`];
  const numTd = document.createElement('td');
  numTd.textContent = num;
  tr.appendChild(numTd);
  const nameTd = document.createElement('td');
  // ◆ renders nearly twice ●'s size in most fonts — the span class sizes
  // the glyph back to text cap-height instead of trusting the font.
  const glyph = document.createElement('span');
  glyph.className = `sb-glyph ${r.bot ? 'bot' : 'human'}`;
  glyph.textContent = r.bot ? '●' : '◆';
  nameTd.appendChild(glyph);
  nameTd.appendChild(document.createTextNode(` ${r.name}`));
  tr.appendChild(nameTd);
  for (const cell of cells) {
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
    // Player markers are later siblings in #hud — no z-index anywhere, so
    // they paint over the panel's translucent dim. Hide them while open.
    this.root.parentElement?.classList.toggle('sb-open', v);
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
      this.tbody.replaceChildren(...this.rows.map((r, i) => sbRowEl(r, String(i + 1))));
      return;
    }
    const kids: HTMLElement[] = [];
    for (const team of ['alpha', 'bravo'] as const) {
      // # restarts per team — the split makes size imbalance readable at
      // a glance (a 9-row team vs a 3-row team is obvious).
      const trs = this.rows.filter(r => r.team === team).map((r, i) => sbRowEl(r, String(i + 1)));
      if (!trs.length) continue;
      // Team label is redundant — name cells are already alpha/bravo
      // tinted. The row survives as a tinted hairline divider so the
      // section split still reads at a glance.
      const th = document.createElement('tr');
      th.className = `sb-team ${team}`;
      const td = document.createElement('td');
      td.colSpan = 99; // span whatever column count the table has
      th.appendChild(td);
      kids.push(th, ...trs);
    }
    // Teamless stragglers (spectators, unteamed) under their own header.
    const rest = this.rows.filter(r => !r.team);
    if (rest.length) kids.push(...rest.map((r, i) => sbRowEl(r, String(i + 1))));
    this.tbody.replaceChildren(...kids);
  }
}
