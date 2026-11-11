/**

 * Scoreboard - the Tab-key roster overlay: visibility toggle, row data,

 * and the 4Hz re-render that splits rows into team sections when any

 * row carries a team. Extracted from hud.ts; HUD forwards the setters.

 */



import { MODES, type ModeId, type TeamId } from '../../../../shared/teams.js';

const MAP_ACRONYMS = new Set(['ctf', 'dm', 'tdm', 't2']);

function prettifyMapName(file: string): string {

  return file

    .replace(/_nef$/i, '') // T2-conversion marker, not part of the name

    .split(/[\s_-]/)

    .filter(Boolean)

    .map((w): string => MAP_ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1))

    .join(' ');

}





/** Header text — "CAPTURE THE FLAG · Dangerous Crossing". The map arg

 *  arrives already resolved server-side (spec.name ?? spec filename);

 *  the filename fallback gets prettified (katabatic_bare → Katabatic Bare).

 *  Spec-less rooms play the built-in field — label it "Default" so the

 *  title still carries both halves (UT/Quake convention: mode · map). */

export function scoreboardTitle(mode?: string, mapName?: string, tag?: string): string {

  const label = [tag, MODES[mode as ModeId]?.label ?? mode?.toUpperCase() ?? ''].filter(Boolean).join(' ');

  let map = '';
  if (mapName) {map = prettifyMapName(mapName);}
  else if (label) {map = 'Default';}

  return [label, map].filter(Boolean).join(' · ');

}





/** Locomotion split for the current life - each field is a percent of
 *  total accrued time; keys map to the colored column segments
 *  (HA/A/S/W/ST/I). */
export type AswSplit = { ha: number; a: number; s: number; w: number; st: number; i: number };

/** Render order + css class per asw segment - keep in sync with the
 *  column header in dom.ts and the .asw-* colors in hud.css. */
const ASW_KEYS = ['ha', 'a', 's', 'w', 'st', 'i'] as const;

export type AswBucket = (typeof ASW_KEYS)[number];

/** Single source for the locomotion buckets - remotes.ts accrues time
 *  with this and pvCam colors the feet gizmo with the same answer, so
 *  the ring can never disagree with the scoreboard column. */
export function aswBucket(alt: number, speed: number, skiing: boolean): AswBucket {
  if (alt > 5) {return 'ha';}
  if (alt >= 0.8) {return 'a';}
  if (speed < 1) {return 'i';}
  if (speed < 5) {return 'st';}
  return skiing ? 's' : 'w';
}

/** Same hues as hud.css .asw-* - the feet gizmo is a THREE material and
 *  can't read css. */
export const ASW_HEX: Record<AswBucket, number> = {
  ha: 0xB0_6E_E8, a: 0x6E_A8_FF, s: 0x6E_E8_7F, w: 0xFF_E0_66, st: 0xFF_9A_3C, i: 0xFF_5A_5A,
};

export type SbRow = {

  name: string; frags: number; deaths: number; score: number | null; ping: number | string | null;

  net?: string | null; self: boolean; dead: boolean;

  team?: TeamId; sheep?: number | null; bot?: boolean;

  /** Armor class — 'light' | 'medium' | 'heavy', rides the roster. */

  cls?: string;

  /** Seconds since last spawn/respawn — null while dead. */

  alive?: number | null;

  /** HA/A/S/W/ST/I — % of this life spent in each locomotion bucket. */

  asw?: AswSplit | null;

  /** Displacement m/s at 1/2/5/10/15s windows - locomotion, not gait. */

  loco?: string[] | null;

};



const CLASS_SHORT: Record<string, string> = { light: 'LGT', medium: 'MED', heavy: 'HVY' };



/** Modes where the personal win metric IS frags. dm pays 10pts/kill +

 *  1pt/creature, so sorting by score lets a creature-farmer outrank a

 *  frag leader; tdm sends kill pts to the TEAM score, leaving personal

 *  PTS empty — frags are the only rank either way. */

const FRAG_RANKED: ReadonlySet<string> = new Set(
  Object.entries(MODES).filter(([, m]): boolean => m.fragRanked === true).map(([k]): string => k));

const scoreboardPing = (ping: number | string | null): string => {
  if (ping == null) {return '—';}
  if (typeof ping === 'string') {return ping;}
  return String(Math.round(ping));
};



/** Row ordering per mode. Objective modes (ctf, flagrun, rabbit) pay

 *  personal pts for caps/returns/damage/hold-time — pts is the honor

 *  board there. Kill modes rank by frags. Both end on deaths + name so

 *  ties render deterministically. */

export function rankRows(mode: string | undefined, rows: SbRow[]): SbRow[] {

  const byFrags = FRAG_RANKED.has(mode ?? '');

  return rows.toSorted((a, b): number =>

    (byFrags

      ? b.frags - a.frags || (b.score ?? 0) - (a.score ?? 0)

      : (b.score ?? b.frags) - (a.score ?? a.frags) || b.frags - a.frags)

    || a.deaths - b.deaths

    || a.name.localeCompare(b.name));

}



// textContent, not innerHTML — display names will be player-chosen

// strings; interpolating them raw is a stored-XSS hole in waiting.

function sbRowEl(r: SbRow, num = ''): HTMLTableRowElement {

  const tr = document.createElement('tr');

  tr.className = `${r.self ? 'self' : ''}${r.dead ? ' dead' : ''}${r.team ? ` sb-${r.team}` : ''}`;

  const cells = [String(r.frags), String(r.deaths), r.score === null ? '—' : String(r.score), r.net ?? '—', scoreboardPing(r.ping), r.sheep == null ? '—' : `${Math.round(r.sheep)}%`, r.alive == null ? '—' : `${r.alive}s`];

  const numTd = document.createElement('td');

  numTd.textContent = num;

  tr.append(numTd);

  const nameTd = document.createElement('td');

  // Bots carry a literal [BOT] badge in the name — a diamond/dot glyph

  // in front would be a second legend saying the same thing.

  nameTd.append(document.createTextNode(` ${r.name}`));

  tr.append(nameTd);

  const clsTd = document.createElement('td');

  // Three-letter class codes (T2 board convention) — a full word's width

  // for a three-value column is wasted; HVY over HEV is the era spelling.

  clsTd.textContent = r.cls ? (CLASS_SHORT[r.cls] ?? r.cls.slice(0, 3).toUpperCase()) : '—';

  clsTd.className = `sb-cls-${r.cls ?? 'none'}`;

  tr.append(clsTd);

  for (const cell of cells) {

    const td = document.createElement('td');

    td.textContent = cell;

    tr.append(td);

  }

  // Locomotion split - one colored segment per bucket so the column reads
  // at a glance (colors live in hud.css .asw-*).
  const aswTd = document.createElement('td');
  if (r.asw) {
    ASW_KEYS.forEach((k, i): void => {
      if (i > 0) {aswTd.append(document.createTextNode('/'));}
      const span = document.createElement('span');
      span.className = `asw-${k}`;
      span.textContent = String(r.asw![k]);
      aswTd.append(span);
    });
  } else {aswTd.textContent = '—';}
  tr.append(aswTd);
  // Loco windows 1/2/5/10/15s - same asw palette, no label (the
  // displacement story reads across the window chain, not one number).
  const locoTd = document.createElement('td');
  if (r.loco && r.loco.length > 0) {
    const LOCO_HUES = ['s', 'a', 'w', 'st', 'i'];
    r.loco.forEach((v, i): void => {
      if (i > 0) {locoTd.append(document.createTextNode('/'));}
      const span = document.createElement('span');
      span.className = `asw-${LOCO_HUES[i] ?? 's'}`;
      span.textContent = v;
      locoTd.append(span);
    });
  } else {locoTd.textContent = '—';}
  tr.append(locoTd);

  return tr;

}



export class Scoreboard {

  private visible = false;

  private refresh = 0;

  private rows: SbRow[] = [];



  private title: HTMLElement | null;

  private lastTitle = '';

  private countdownEl: HTMLElement | null;

  /** Team aggregate strip under the title — "17 – 7" in team colors
   *  (CS2/Valorant convention: two numbers, no labels). Hidden for
   *  modes without team scores. */
  private teamsEl: HTMLElement | null;
  private tsA: HTMLElement | null;
  private tsB: HTMLElement | null;
  private lastTeamTxt = '';

  /** Wall-clock deadline for "NEXT MATCH IN N" — 0 hides the footer.

   *  Client-side estimate: matchStart releases the board anyway, so a

   *  tick of skew against the server's intermission never shows. */

  private countdownAt = 0;

  private lastCountdownTxt = '';



  constructor(

    private root: HTMLDivElement,

    private tbody: HTMLElement,

  ) {

    this.title = root.querySelector('#sb-title');

    this.teamsEl = root.querySelector('#sb-teams');

    this.tsA = root.querySelector('#sb-ts-a');

    this.tsB = root.querySelector('#sb-ts-b');

    this.countdownEl = root.querySelector('#sb-countdown');

  }



  /** Arm the intermission footer — seconds until the next matchStart. */

  setCountdown(secLeft: number | null): void {

    this.countdownAt = secLeft === null ? 0 : performance.now() + secLeft * 1000;

    if (!this.countdownAt) {

      this.lastCountdownTxt = '';

      if (this.countdownEl) {this.countdownEl.style.display = 'none';}

    }

  }



  /** Header line — "CAPTURE THE FLAG · Dangerous Crossing". Change-guarded:

   *  callers recompute every scoreboard tick, but the DOM only pays when

   *  the match actually changes. */

  setTitle(t: string): void {

    if (t === this.lastTitle || !this.title) {return;}

    this.lastTitle = t;

    this.title.textContent = t;

    this.title.style.display = t ? '' : 'none';

  }



  setVisible(v: boolean): void {

    this.visible = v;

    this.root.style.display = v ? 'block' : 'none';

    // Player markers are later siblings in #hud — no z-index anywhere, so

    // they paint over the panel's translucent dim. Hide them while open.

    this.root.parentElement?.classList.toggle('sb-open', v);

    if (v) {this.refresh = 0;} // force render on open

  }



  get isVisible(): boolean { return this.visible; }



  setTeamScores(s: { alpha: number; bravo: number } | null): void {
    const txt = s ? `${s.alpha}–${s.bravo}` : '';
    if (txt === this.lastTeamTxt || !this.teamsEl) {return;}
    this.lastTeamTxt = txt;
    this.teamsEl.style.display = s ? '' : 'none';
    if (s && this.tsA && this.tsB) {
      this.tsA.textContent = String(s.alpha);
      this.tsB.textContent = String(s.bravo);
    }
  }


  setRows(rows: SbRow[]): void {

    this.rows = rows;

  }

  /** Offline (bots-only) boards have no meaningful latency column - hide
   *  the whole PING column via the root class rather than per-cell. */
  setPingVisible(v: boolean): void {
    this.root.classList.toggle('sb-noping', !v);
  }

  /** Offline boards render NET as 'bot'/'-' on every row - a transport
   *  column with no transports. Hide it like PING. */
  setNetVisible(v: boolean): void {
    this.root.classList.toggle('sb-nonet', !v);
  }



  /** 4Hz re-render while open — cheap enough that diffing row state

   *  isn't worth the bookkeeping. */

  tick(dt: number): void {

    if (!this.visible) {return;}

    if (this.countdownAt && this.countdownEl) {

      const left = Math.max(0, Math.ceil((this.countdownAt - performance.now()) / 1000));

      const txt = left > 0 ? `NEXT MATCH IN ${left}` : 'NEXT MATCH…';

      if (txt !== this.lastCountdownTxt) {

        this.lastCountdownTxt = txt;

        this.countdownEl.textContent = txt;

        this.countdownEl.style.display = 'block';

      }

    }

    this.refresh -= dt;

    if (this.refresh > 0) {return;}

    this.refresh = 0.25;

    // Any row carrying a team → split into sections; otherwise flat FFA.

    const hasTeams = this.rows.some((r): TeamId | undefined => r.team);

    if (!hasTeams) {

      this.tbody.replaceChildren(...this.rows.map((r, i): HTMLTableRowElement => sbRowEl(r, String(i + 1))));

      return;

    }

    const kids: HTMLElement[] = [];

    for (const team of ['alpha', 'bravo'] as const) {

      // # restarts per team — the split makes size imbalance readable at

      // a glance (a 9-row team vs a 3-row team is obvious).

      const trs = this.rows.filter((r): boolean => r.team === team).map((r, i): HTMLTableRowElement => sbRowEl(r, String(i + 1)));

      if (trs.length === 0) {continue;}

      // Team label is redundant — name cells are already alpha/bravo

      // tinted. The row survives as a tinted hairline divider so the

      // section split still reads at a glance.

      const th = document.createElement('tr');

      th.className = `sb-team ${team}`;

      const td = document.createElement('td');

      td.colSpan = 99; // span whatever column count the table has

      th.append(td);

      kids.push(th, ...trs);

    }

    // Teamless stragglers (spectators, unteamed) under their own header.

    const rest = this.rows.filter((r): boolean => !r.team);

    if (rest.length > 0) {kids.push(...rest.map((r, i): HTMLTableRowElement => sbRowEl(r, String(i + 1))));}

    this.tbody.replaceChildren(...kids);

  }

}

