import { FRAG_MESSAGE_DURATION, FRAG_MESSAGE_FADE } from '../core/config.js';
import { hudRegion } from './hud/regions.js';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

export class FragMessages {
  private scoreDiv: HTMLDivElement;
  private fadeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.scoreDiv = document.createElement('div');
    this.scoreDiv.id = 'frag-msg'; // hidden with the rest of the HUD via body.menu-open
    this.scoreDiv.style.cssText = `
      font-family:Rajdhani,'Segoe UI',sans-serif; color:#fff;
      text-transform:uppercase; letter-spacing:0.08em;
      pointer-events:none; text-align:center; line-height:1.3;
      opacity:0; transition:opacity ${FRAG_MESSAGE_FADE}ms ease;
    `;
    hudRegion('uc').append(this.scoreDiv);
  }

  show(msg: string): void {
    // First line is the headline (YOU DIED / FRAGGED X) — big Rajdhani
    // slab; the rest reads as a smaller subtitle under it.
    const [head, ...rest] = msg.split('\n');
    this.scoreDiv.innerHTML =
      `<div style="font-size:2.6rem;font-weight:700;color:#ff5544;letter-spacing:0.12em;text-shadow:0 0 18px rgba(255,60,40,0.55),1px 2px 4px #000">${esc(head ?? '')}</div>${ 
      rest.length > 0
        ? `<div style="font-size:1.05rem;font-weight:600;color:#e8d8cc;letter-spacing:0.15em;text-shadow:1px 1px 3px #000">${esc(rest.join(' · '))}</div>`
        : ''}`;
    this.flash();
  }

  /** The live kill headline — streak/multi banners STACK onto it
   *  instead of stomping the FRAGGED line they fired alongside. */
  private currentKill = '';

  /** Frag headline — mid-tier: a frag matters less than YOU DIED or a
   *  flag event, so it gets a compact line, not the 2.6rem red slab. */
  showKill(msg: string): void {
    this.currentKill = msg;
    const [head, ...rest] = msg.split('\n');
    this.scoreDiv.innerHTML =
      `<div style="font-size:1.35rem;font-weight:700;color:#ffd9cc;letter-spacing:0.1em;text-shadow:0 0 10px rgba(255,120,80,0.4),1px 2px 3px #000">${esc(head ?? '')}</div>${ 
      rest.length > 0
        ? `<div style="font-size:0.9rem;font-weight:600;color:#e8d8cc;letter-spacing:0.14em;text-shadow:1px 1px 3px #000">${esc(rest.join(' · '))}</div>`
        : ''}`;
    this.flash();
  }

  /** Streak/multi banner riding a frag — UT convention: the RARE event
   *  headlines (DOUBLE KILL gets the big slab), the routine frag reads
   *  as the small subtitle under it. A bare banner (no live frag, e.g.
   *  announce-only paths) renders on its own. */
  stackKill(banner: string): void {
    this.show(this.currentKill ? `${banner}\n${this.currentKill}` : banner);
    this.currentKill = '';
  }

  // On-shot score tick ("84.2 · 41 · 0.35s · +8") — the OLD small style.
  // The headline treatment is for deaths/frags only; a 2.6rem slab every
  // hit is screen spam. `air` scales the score in discrete steps — a 2s
  // airtime frag is a bigger deal than a 0.4s plink, so it LOOKS bigger.
  private static readonly SCORE_TIERS: [number, string, string][] = [
    // [min airtime, stats font, score font] — capped at the top tier
    [2, '1.05rem', '2.2rem'],
    [1, '0.95rem', '1.7rem'],
    [0.5, '0.9rem', '1.4rem'],
    [0, '0.85rem', '1.2rem'],
  ];

  showScore(msg: string, air = 0): void {
    const tier = FragMessages.SCORE_TIERS.find((t): boolean => air >= t[0])!;
    const [head, ...rest] = msg.split('\n');
    this.scoreDiv.innerHTML =
      `<div style="font-size:${tier[1]};font-weight:600;color:#cfe0ff;letter-spacing:0.1em;text-shadow:1px 1px 3px #000">${esc(head ?? '')}</div>${ 
      rest.length > 0
        ? `<div style="font-size:${tier[2]};font-weight:700;color:#8fd8a8;letter-spacing:0.08em;text-shadow:1px 1px 3px #000">${esc(rest.join(' · '))}</div>`
        : ''}`;
    this.flash();
  }

  private flash(): void {
    this.scoreDiv.style.transition = 'none';
    this.scoreDiv.style.opacity = '1';
    clearTimeout(this.fadeTimer);
    this.fadeTimer = setTimeout((): void => {
      this.scoreDiv.style.transition = `opacity ${FRAG_MESSAGE_FADE}ms ease`;
      this.scoreDiv.style.opacity = '0';
      this.currentKill = '';
    }, FRAG_MESSAGE_DURATION);
  }
}
