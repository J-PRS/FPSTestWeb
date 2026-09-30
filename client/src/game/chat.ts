/**
 * Chat overlay — self-contained DOM module so it doesn't entangle the
 * HUD/input stacks: own elements, own key routing.
 *
 * Key model: T opens global chat, Y opens team chat (Tribes/CS heritage),
 * Enter sends, Esc closes.
 * While the input is focused a capture-phase keydown eats everything so a
 * message typed mid-fight doesn't also ski/jump/fire. textContent-only
 * rendering — chat is the classic HTML-injection vector.
 */

import { vgsGate } from './vgs.ts';

export interface ChatDeps {
  send(text: string, team: boolean): void;
  /** null when offline — feed still shows locally-echoed/system lines */
  isConnected(): boolean;
  localName(): string;
}

const MAX_LINES = 8;
const FADE_MS = 12000;

/** The one live feed — Chat is constructed once by netHandlers; other
 *  self-contained modules (offline bots) reach it without threading a
 *  deps chain through three layers. */
export const chatSink: { add?: (from: string | null, text: string, team?: boolean) => void } = {};

export class Chat {
  private feed: HTMLDivElement;
  private inputWrap: HTMLDivElement;
  private input: HTMLInputElement;
  private deps: ChatDeps;
  private team = false;

  constructor(deps: ChatDeps) {
    this.deps = deps;

    const root = document.createElement('div');
    root.id = 'chat';
    root.style.cssText = 'position:fixed;left:12px;bottom:var(--z-bl-1);z-index:60;font:13px/1.4 monospace;color:#fff;pointer-events:none;max-width:420px;';

    this.feed = document.createElement('div');
    root.appendChild(this.feed);

    this.inputWrap = document.createElement('div');
    this.inputWrap.style.cssText = 'display:none;margin-top:4px;pointer-events:auto;';
    this.input = document.createElement('input');
    this.input.maxLength = 200;
    this.input.placeholder = 'say…';
    this.input.style.cssText = 'width:100%;background:rgba(0,0,0,.65);border:1px solid #444;color:#fff;font:inherit;padding:3px 6px;outline:none;';
    this.inputWrap.appendChild(this.input);
    root.appendChild(this.inputWrap);
    document.body.appendChild(root);

    // Capture phase: while composing, keys are ours alone.
    window.addEventListener('keydown', (e) => this.onKey(e), true);
    chatSink.add = (from, text, team) => this.add(from, text, team);
  }

  private get composing(): boolean {
    return document.activeElement === this.input;
  }

  private onKey(e: KeyboardEvent): void {
    if (this.composing) {
      e.stopPropagation();
      if (e.code === 'Enter') {
        const text = this.input.value.trim();
        if (text) {
          this.deps.send(text.slice(0, 200), this.team);
          if (!this.deps.isConnected()) this.add(this.deps.localName(), text, this.team); // offline echo
        }
        this.close();
      } else if (e.code === 'Escape') {
        this.close();
      }
      return;
    }
    // Don't steal T/Y while typing in menus/other inputs, or when a
    // chat-less surface owns the keyboard.
    if ((e.code === 'KeyT' || e.code === 'KeyY') && !vgsGate.active && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
      this.open(e.code === 'KeyY');
      e.preventDefault();
      e.stopPropagation();
    }
  }

  private open(team: boolean): void {
    this.team = team;
    this.input.placeholder = team ? 'team…' : 'say…';
    this.input.style.borderColor = team ? '#4a4' : '#444';
    this.inputWrap.style.display = 'block';
    this.input.value = '';
    this.input.focus();
  }

  private close(): void {
    this.inputWrap.style.display = 'none';
    this.input.blur();
  }

  /** A line in the feed. `from === null` renders as a system line. */
  add(from: string | null, text: string, team = false): void {
    const line = document.createElement('div');
    line.style.cssText = 'text-shadow:1px 1px 0 #000;margin-top:1px;';
    if (from === null) {
      line.style.color = '#9cf';
      line.textContent = text;
    } else {
      const who = document.createElement('span');
      who.style.color = team ? '#7d7' : '#fd8';
      who.textContent = `${team ? '[T] ' : ''}${from}: `;
      const body = document.createElement('span');
      body.textContent = text;
      line.append(who, body);
    }
    this.feed.appendChild(line);
    while (this.feed.children.length > MAX_LINES) this.feed.firstChild?.remove();
    setTimeout(() => line.remove(), FADE_MS);
  }
}
