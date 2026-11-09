/**
 * VGS — the Tribes Voice Game System. V opens the chord menu, two more
 * letters pick a line (VGS = "Shazbot!"), Esc/timeout/invalid cancels.
 * Lines ride the normal chat wire: Global-category emotes go to everyone,
 * tactical categories are team-scoped — same scoping a real Tribes VGS
 * callout has. The menu is its own DOM module like Chat.
 */

import { audio } from '../core/audio.ts';
import { settings } from '../core/settings.js';
import { matchCode } from '../core/keybinds.js';
import { hudRegion } from '../ui/hud/regions.js';

import { TREE, type VgsNode } from './vgsTree.js';

const TIMEOUT_MS = 3000;

/** The letter a chord keypress means: layout letter (e.key) by default —
 *  matches what the menu prints — or the QWERTY position letter
 *  (e.code) when the physical-position toggle is on or the layout key
 *  isn't a letter at all (non-Latin boards). */
function chordLetter(e: KeyboardEvent): string {
  if (!settings.get('fps-vgs-physical')) {
    const k = e.key;
    if (k.length === 1 && /[a-zA-Z]/.test(k)) {return k.toUpperCase();}
  }
  return e.code.startsWith('Key') ? e.code.slice(3) : '';
}

/** Other window-level key routers (chat) check this before claiming a
 *  letter — listener registration order is not a reliable gate. */
export const vgsGate = { active: false };

/** A node's chat scope: leaves read their own `team` flag; a category
 *  inherits when every leaf agrees, else 'mixed'. */
function nodeScope(n: VgsNode): 'global' | 'team' | 'mixed' {
  if ('line' in n) {return n.team === false ? 'global' : 'team';}
  let scope: 'global' | 'team' | null = null;
  for (const c of Object.values(n.children)) {
    const s = nodeScope(c);
    if (s === 'mixed' || (scope && s !== scope)) {return 'mixed';}
    scope = s;
  }
  return scope ?? 'mixed';
}

const scopeColor = (s: 'global' | 'team' | 'mixed'): "#fd8" | "#7d7" | "#ccc" => {
  if (s === 'global') {return '#fd8';}
  if (s === 'team') {return '#7d7';}
  return '#ccc';
};

export interface VgsDeps {
  /** Wire chat — team flag scopes the line; chord is the keypath ("VGS")
   *  printed next to the message so the menu is learnable from chat. */
  send(text: string, team: boolean, chord: string): void;
  /** Offline/local echo into the feed. */
  echo(text: string, team: boolean, chord: string): void;
  /** Spoken voice for the line — fires at send time so the sender hears
   *  it once whether the server echoes the chat back or not. */
  speak(text: string): void;
}

export class Vgs {
  private menu: HTMLDivElement;
  private path: VgsNode[] = [];
  private keys: string[] = [];
  private active = false;
  private timer = 0;

  constructor(private deps: VgsDeps) {
    this.menu = document.createElement('div');
    this.menu.style.cssText =
      'display:none;order:1;' +
      'font:13px/1.5 monospace;color:#fff;background:rgba(0,0,0,.65);' +
      'border:1px solid #555;padding:6px 10px;min-width:220px;pointer-events:none;';
    hudRegion('bl').append(this.menu);
    window.addEventListener('keydown', (e): void => this.onKey(e), true);
    // While the menu is up the keys belong to it entirely — keyup too,
    // so a release can't reach game handlers that never saw the press.
    window.addEventListener('keyup', (e): void => {
      if (this.active) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
  }

  private get node(): Record<string, VgsNode> {
    const top = this.path[this.path.length - 1];
    return top && 'children' in top ? top.children : TREE;
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.active) {
      if (matchCode('vgs', e.code) && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        this.open();
        e.preventDefault();
        // stopImmediatePropagation — same-target window listeners (chat)
        // ignore plain stopPropagation.
        e.stopImmediatePropagation();
      }
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.code === 'Escape') { this.close(); return; }
    // V opens by physical position (it's a bind), but chord letters follow
    // the typist's layout — the printed [VGS] prefix advertises letters, so
    // the keys should be letters too (Dvorak V ≠ QWERTY V position).
    // 'fps-vgs-physical' opts into raw positions for classic muscle memory;
    // e.code also serves as fallback when the layout key isn't a letter.
    const letter = chordLetter(e);
    const next = letter && this.node[letter];
    if (!next) { this.close(); return; }
    if ('line' in next) {
      const team = next.team !== false;
      const chord = `V${  this.keys.join('')  }${letter}`;
      this.deps.send(next.line, team, chord);
      // Own VGS lands immediately like Tribes — the wire echo (if the
      // send actually landed) dedupes inside the feed.
      this.deps.echo(next.line, team, chord);
      this.deps.speak(next.line);
      this.blip();
      this.close();
      return;
    }
    this.keys.push(letter);
    this.path.push(next);
    this.render();
    this.rearm();
  }

  private open(): void {
    this.active = true;
    vgsGate.active = true;
    this.path = [];
    this.keys = [];
    this.menu.style.display = 'block';
    this.render();
    this.rearm();
  }

  private close(): void {
    this.active = false;
    vgsGate.active = false;
    this.menu.style.display = 'none';
    clearTimeout(this.timer);
  }

  private rearm(): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout((): void => this.close(), TIMEOUT_MS);
  }

  private render(): void {
    this.menu.textContent = '';
    const crumb = document.createElement('div');
    crumb.style.color = '#9cf';
    crumb.textContent = `VGS${  this.path.length > 0 ? ` ▸ ${this.path.map((n): string => n.label).join(' ▸ ')}` : ''}`;
    this.menu.append(crumb);
    for (const [k, n] of Object.entries(this.node)) {
      const row = document.createElement('div');
      const key = document.createElement('span');
      // Scope color = the chat channel the line lands in: yellow like
      // global names, green like team chat, gray if a category mixes.
      key.style.color = scopeColor(nodeScope(n));
      key.textContent = `[${k}] `;
      row.append(key, document.createTextNode(n.label));
      this.menu.append(row);
    }
  }

  /** Voice-pack stand-in: two-tone ack blip, pitched like a radio click. */
  private blip(): void {
    const bus = audio.uiBus;
    const c = bus?.context;
    if (!bus || !c) {return;}
    const t = c.currentTime;
    for (const [f, dt] of [[880, 0], [660, 0.07]] as const) {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = 'square';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.06, t + dt);
      g.gain.exponentialRampToValueAtTime(0.001, t + dt + 0.06);
      o.connect(g); g.connect(bus);
      o.start(t + dt); o.stop(t + dt + 0.07);
    }
  }
}
