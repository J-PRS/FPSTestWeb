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
import { settings } from '../core/settings.js';
import { matchCode } from '../core/keybinds.js';
import { hudRegion } from '../ui/hud/regions.js';

export interface ChatDeps {
  send(text: string, team: boolean): void;
  /** null when offline — feed still shows locally-echoed/system lines */
  isConnected(): boolean;
  localName(): string;
  /** Display name for a speaker id — resolves the join-declared `name`
   *  for humans; absent (offline/bots) the raw id/bot name renders. */
  nameFor?(id: string): string;
  /** id → its roster entry — /mute needs to resolve typed display
   *  names back to the identity (names are cosmetic, ids are not). */
  idFor?(name: string): string | undefined;
}

/** Client-side mute — the speaker's lines never render/speak on THIS
 *  client; everyone else still sees them (a server mute would be a
 *  moderation power beta doesn't need). Stored by playerId so a name
 *  change can't slip it. */
const mutedIds = (): Set<string> => {
  try { return new Set(JSON.parse(settings.get('fps-muted')) as string[]); }
  catch { return new Set(); }
};
const saveMuted = (s: Set<string>): void => settings.set('fps-muted', JSON.stringify([...s]));

const MAX_LINES = 8;
const FADE_MS = 12_000;

/** The one live feed — Chat is constructed once by netHandlers; other
 *  self-contained modules (offline bots) reach it without threading a
 *  deps chain through three layers. */
export const chatSink: { add?: (from: string | null, text: string, team?: boolean, vgs?: string, muted?: boolean) => void } = {};

export class Chat {
  private feed: HTMLDivElement;
  private inputWrap: HTMLDivElement;
  private input: HTMLInputElement;
  private deps: ChatDeps;
  private team = false;
  /** Locally-echoed own lines awaiting (or skipping) their wire echo —
   *  keyed by team|vgs|text so the relayed copy dedupes instead of
   *  printing twice. The element rides along so a `muted` echo back
   *  (flood control) can gray the line in place. A line that never
   *  echoes just stays shown — like Tribes, your words land the moment
   *  you say them. */
  private pendingSelf = new Map<string, { n: number; el: HTMLDivElement }>();

  constructor(deps: ChatDeps) {
    this.deps = deps;

    const root = document.createElement('div');
    root.id = 'chat';
    // max-width is capped at 50vw-170px: the bottom-center vitals block is
    // 300px wide, so on narrow windows an uncapped feed would nick it.
    // z 8: above the world render, below EVERY UI chrome — the menu
    // overlay sits at 10, HUD panels at 40. Ambient text never paints
    // over menus or panels.
    root.style.cssText = 'font:13px/1.4 monospace;color:#fff;pointer-events:none;max-width:min(420px, calc(50vw - 170px));order:2;';

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
    hudRegion('bl').append(root);

    // Capture phase: while composing, keys are ours alone.
    window.addEventListener('keydown', (e): void => this.onKey(e), true);
    chatSink.add = (from, text, team, vgs, muted): HTMLDivElement => this.add(from, text, team, vgs, muted);
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
          if (!this.slash(line)) {
            this.deps.send(line, this.team);
            this.echoSelf(line, this.team);
          }
        }
        this.close();
      } else if (e.code === 'Escape') {
        this.close();
      }
      return;
    }
    // Don't steal T/Y while typing in menus/other inputs, or when a
    // chat-less surface owns the keyboard.
    if ((matchCode('chatAll', e.code) || matchCode('chatTeam', e.code)) && !vgsGate.active && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
      this.open(matchCode('chatTeam', e.code));
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

  /** /mute /unmute /muted — local commands, never reach the wire.
   *  Returns true when the line was consumed. */
  private slash(line: string): boolean {
    const [cmd, ...rest] = line.split(/\s+/);
    const arg = rest.join(' ');
    if (cmd === '/mute' || cmd === '/unmute') {
      const id = this.deps.idFor?.(arg) ?? arg;
      if (!id) { this.add(null, `no such player: ${arg}`); return true; }
      const s = mutedIds();
      if (cmd === '/mute') { s.add(id); } else { s.delete(id); }
      saveMuted(s);
      this.add(null, `${cmd === '/mute' ? 'muted' : 'unmuted'} ${this.nameOf(id)}`);
      return true;
    }
    if (cmd === '/muted') {
      const s = mutedIds();
      this.add(null, s.size > 0 ? `muted: ${[...s].map((id): string => this.nameOf(id)).join(', ')}` : 'nobody muted');
      return true;
    }
    return false;
  }

  /** Own line rendered instantly + registered so the server's relayed
   *  copy back gets swallowed. Chat text and VGS chords both route here. */
  echoSelf(text: string, team: boolean, vgs?: string): void {
    const key = `${team ? 1 : 0}|${vgs ?? ''}|${text}`;
    const el = this.add(this.deps.localName(), text, team, vgs);
    const cur = this.pendingSelf.get(key);
    this.pendingSelf.set(key, { n: (cur?.n ?? 0) + 1, el });
    if (this.pendingSelf.size > 64) {this.pendingSelf.clear();}
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
  private swallowSelfEcho(from: string, text: string, team: boolean, vgs?: string): HTMLDivElement | null {
    const key = `${team ? 1 : 0}|${vgs ?? ''}|${text}`;
    const cur = this.pendingSelf.get(key);
    if (!cur) {return null;}
    if (cur.n > 1) {this.pendingSelf.set(key, { n: cur.n - 1, el: cur.el });} else {this.pendingSelf.delete(key);}
    return cur.el;
  }

  /** Flood-controlled send: the words reached only the speaker — the
   *  line reads gray+italic so a spammer sees what died on the wall. */
  private static grayMuted(el: HTMLDivElement): void {
    el.style.opacity = '0.45';
    el.style.fontStyle = 'italic';
    el.title = 'muted — flood control';
  }

  /** Channel voice for a rendered line — VGS always speaks through the
   *  robot (own VGS spoke at send time, so the echo is feed-only); typed
   *  chat reads through system TTS only while CHAT TTS is on. */
  private static speak(from: string, text: string, vgs: string | undefined, isSelf: boolean): void {
    if (vgs) {
      if (!isSelf) {speakVgs(feedNames(text), from);}
    } else if (chatTtsEnabled()) {
      speakChat(feedNames(text), from); // own lines too — audible send confirmation
    }
  }

  /** Instance-bound so it can consult deps.nameFor for human ids. */
  private nameOf(from: string): string {
    return this.deps.nameFor?.(from) ?? botDisplayName(from);
  }

  private buildLine(from: string | null, text: string, team: boolean, vgs?: string): HTMLDivElement {
    const line = document.createElement('div');
    line.style.cssText = 'text-shadow:1px 1px 0 #000;margin-top:1px;';
    if (from === null) {
      line.style.color = '#9cf';
      line.textContent = feedNames(text);
      return line;
    }
    const who = document.createElement('span');
    who.style.color = team ? '#7d7' : '#fd8';
    who.textContent = `${team ? '[T] ' : ''}${this.nameOf(from)}: `;
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
    return line;
  }

  add(from: string | null, text: string, team = false, vgs?: string, muted = false): HTMLDivElement {
    if (from !== null && mutedIds().has(from)) {
      // Swallowed silently — the muted speaker's words die at the wall.
      // Still consume a pending self-echo so the map can't leak.
      if (from === this.deps.localName()) {this.swallowSelfEcho(from, text, team, vgs);}
      return document.createElement('div');
    }
    if (from !== null) {
      const isSelf = from === this.deps.localName();
      if (isSelf) {
        const el = this.swallowSelfEcho(from, text, team, vgs);
        if (el) {
          if (muted) {Chat.grayMuted(el);}
          return el;
        }
      }
      Chat.speak(from, text, vgs, isSelf);
    }
    const line = this.buildLine(from, text, team, vgs);
    // A muted echo that missed its pending match (feed trimmed, relay
    // path) still renders gray — never as a normal send.
    if (muted && from !== null) {Chat.grayMuted(line);}
    this.feed.append(line);
    // Trim by ELEMENT child: firstChild may be a non-element node — removing
    // it doesn't shrink `children`, and a null firstChild makes ?.remove()
    // no-op forever (infinite loop once >MAX_LINES lines land within FADE_MS).
    while (this.feed.children.length > MAX_LINES) {this.feed.children[0]?.remove();}
    setTimeout((): void => line.remove(), FADE_MS);
    return line;
  }
}
