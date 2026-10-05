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
import { speakVgs, speakChat, chatTtsEnabled } from '../core/tts.js';
import { botDisplayName, feedNames } from '../../../shared/botNames.js';

export interface ChatDeps {
  send(text: string, team: boolean): void;
  /** null when offline — feed still shows locally-echoed/system lines */
  isConnected(): boolean;
  localName(): string;
}

const MAX_LINES = 8;
const FADE_MS = 12_000;

/** The one live feed — Chat is constructed once by netHandlers; other
 *  self-contained modules (offline bots) reach it without threading a
 *  deps chain through three layers. */
export const chatSink: { add?: (from: string | null, text: string, team?: boolean, vgs?: string) => void } = {};

export class Chat {
  private feed: HTMLDivElement;
  private inputWrap: HTMLDivElement;
  private input: HTMLInputElement;
  private deps: ChatDeps;
  private team = false;
  /** Locally-echoed own lines awaiting (or skipping) their wire echo —
   *  keyed by team|vgs|text so the relayed copy dedupes instead of
   *  printing twice. A line that never echoes just stays shown — like
   *  Tribes, your own words land the moment you say them. */
  private pendingSelf = new Map<string, number>();

  constructor(deps: ChatDeps) {
    this.deps = deps;

    const root = document.createElement('div');
    root.id = 'chat';
    // max-width is capped at 50vw-170px: the bottom-center vitals block is
    // 300px wide, so on narrow windows an uncapped feed would nick it.
    root.style.cssText = 'position:fixed;left:12px;bottom:var(--z-bl-1);z-index:60;font:13px/1.4 monospace;color:#fff;pointer-events:none;max-width:min(420px, calc(50vw - 170px));';

    this.feed = document.createElement('div');
    root.append(this.feed);

    this.inputWrap = document.createElement('div');
    this.inputWrap.style.cssText = 'display:none;margin-top:4px;pointer-events:auto;';
    this.input = document.createElement('input');
    this.input.maxLength = 200;
    this.input.placeholder = 'say…';
    this.input.style.cssText = 'width:100%;background:rgba(0,0,0,.65);border:1px solid #444;color:#fff;font:inherit;padding:3px 6px;outline:none;';
    this.inputWrap.append(this.input);
    root.append(this.inputWrap);
    document.body.append(root);

    // Capture phase: while composing, keys are ours alone.
    window.addEventListener('keydown', (e) => this.onKey(e), true);
    chatSink.add = (from, text, team, vgs) => this.add(from, text, team, vgs);
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
          const line = text.slice(0, 200);
          this.deps.send(line, this.team);
          this.echoSelf(line, this.team);
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

  /** Own line rendered instantly + registered so the server's relayed
   *  copy back gets swallowed. Chat text and VGS chords both route here. */
  echoSelf(text: string, team: boolean, vgs?: string): void {
    const key = `${team ? 1 : 0}|${vgs ?? ''}|${text}`;
    this.pendingSelf.set(key, (this.pendingSelf.get(key) ?? 0) + 1);
    if (this.pendingSelf.size > 64) {this.pendingSelf.clear();}
    this.add(this.deps.localName(), text, team, vgs);
  }

  /** A line in the feed. `from === null` renders as a system line.
   *  `vgs` = the chord ("VGS") — printed as a prefix AND the speech
   *  switch: VGS goes to the robot, typed lines to system TTS when the
   *  CHAT TTS toggle is on. Speech lives here (not in onChat) so every
   *  path that lands in the feed — wire, host relay, offline echo, bot
   *  taunts — speaks identically. */
  /** The wire copy of a line we already printed locally — consume the
   *  marker, print nothing. If the wire never delivered, the local
   *  echo is on screen anyway (like Tribes: your words always land). */
  private swallowSelfEcho(from: string, text: string, team: boolean, vgs?: string): boolean {
    const key = `${team ? 1 : 0}|${vgs ?? ''}|${text}`;
    const n = this.pendingSelf.get(key) ?? 0;
    if (!n) {return false;}
    if (n > 1) {this.pendingSelf.set(key, n - 1);} else {this.pendingSelf.delete(key);}
    return true;
  }

  add(from: string | null, text: string, team = false, vgs?: string): void {
    if (from !== null) {
      const isSelf = from === this.deps.localName();
      if (isSelf && this.swallowSelfEcho(from, text, team, vgs)) {return;}
      if (vgs) {
        // Own VGS spoke at send time — the echo back is feed-only.
        if (!isSelf) {speakVgs(feedNames(text), from);}
      } else if (chatTtsEnabled()) {
        speakChat(feedNames(text), from); // own lines too — audible send confirmation
      }
    }
    const line = document.createElement('div');
    line.style.cssText = 'text-shadow:1px 1px 0 #000;margin-top:1px;';
    if (from === null) {
      line.style.color = '#9cf';
      line.textContent = feedNames(text);
    } else {
      const who = document.createElement('span');
      who.style.color = team ? '#7d7' : '#fd8';
      who.textContent = `${team ? '[T] ' : ''}${botDisplayName(from)}: `;
      const body = document.createElement('span');
      body.textContent = vgs ? `[${vgs}] ${feedNames(text)}` : feedNames(text);
      // Whole line tinted for team — name-color alone was easy to miss
      // mid-fight. A left tick marks the channel too.
      if (team) {
        body.style.color = '#9e9';
        line.style.borderLeft = '2px solid #4a4';
        line.style.paddingLeft = '5px';
      }
      line.append(who, body);
    }
    this.feed.append(line);
    while (this.feed.children.length > MAX_LINES) {this.feed.firstChild?.remove();}
    setTimeout(() => line.remove(), FADE_MS);
  }
}
