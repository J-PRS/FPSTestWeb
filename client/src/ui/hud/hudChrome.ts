import { WeaponType } from '../../../../shared/weapons.js';
import { botDisplayName } from '../../../../shared/botNames.js';
import type { HUD } from '../hud.js';

// HUD chrome family — kill feed, match clock + flag chips, death
// vignette/countdown, spectator hint, status-effect chip+vignette.
// All flip DOM elements only; field state lives on the HUD.

const paintFlagChip = (el: HTMLElement, st?: string) => {
  el.style.display = st ? '' : 'none';
  if (!st) return;
  el.textContent = st === 'home' ? '⚑' : st === 'carried' ? '⚑ TAKEN' : '⚑ LOOSE';
  el.classList.toggle('taken', st !== 'home');
};

export function feedKill(h: HUD, shooter: string, target: string, localIsShooter: boolean, localIsTarget: boolean, meta?: { shooter?: string; target?: string; weapon?: number; air?: number }): void {
    const { shooter: sTeam, target: tTeam, weapon, air } = meta ?? {};
    const row = document.createElement('div');
    row.className = 'kf-row';
    if (localIsShooter) row.classList.add('me');
    // Self-inflicted kill (own splash): "X cratered" — "X ▸ X" reads as a
    // normal frag in the feed.
    const suicide = shooter === target;
    const s = document.createElement('span');
    // Team tint like the TAB board — alpha/bravo first letter keys the class.
    s.className = 'kf-s' + (sTeam ? ` tm-${sTeam[0]}` : '');
    s.textContent = shooter === 'environment' ? '☠' : botDisplayName(shooter);
    const w = document.createElement('span');
    w.className = 'kf-w';
    // Enum-name reverse lookup: `WeaponType[7]` → 'PlasmaCannon'. Unknown/absent → nothing shown.
    // Projectile airtime rides after the weapon: `[PlasmaCannon] [1.3s]` —
    // long-lob kills earn the visible flight time. Sub-100ms hits are
    // effectively point-blank; the bracket would just be noise.
    const wName = weapon !== undefined && WeaponType[weapon] ? `[${WeaponType[weapon]}]` : '';
    const airTag = air !== undefined && air >= 0.1 ? ` [${air.toFixed(1)}s]` : '';
    w.textContent = wName || airTag ? `${wName}${airTag} ` : '';
    const t = document.createElement('span');
    t.className = 'kf-t' + (localIsTarget ? ' dead' : tTeam ? ` tm-${tTeam[0]}` : '');
    t.textContent = suicide ? 'self' : botDisplayName(target);
    row.append(s, w, t);
    h.killFeed.append(row);
    while (h.killFeed.childElementCount > 6) h.killFeed.firstElementChild!.remove();
    // Hard expiry — a fading ghost row reads as a smear while the stack
    // snaps up through it; classic feeds just cut the row in one frame.
    setTimeout(() => row.remove(), 5200);
    // Kills render ONCE, here — the #player-list log (logEvent) keeps the
    // non-frag timeline (flags, match text) or every kill doubles up.
  }

export function setMatchStatus(h: HUD, msLeft: number | null, flags: { alpha?: string; bravo?: string }): void {
    const hasAny = msLeft !== null || flags.alpha || flags.bravo;
    h.matchStatus.style.display = hasAny ? 'flex' : 'none';
    if (!hasAny) return;
    let txt = '';
    if (msLeft !== null) {
      const s = Math.max(0, Math.floor(msLeft / 1000));
      txt = msLeft <= 0 ? 'OT' : `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      h.matchClock.classList.toggle('late', msLeft < 60_000);
      h.matchClock.style.display = '';
    } else {
      h.matchClock.style.display = 'none';
    }
    if (txt !== h.lastClockTxt) { h.lastClockTxt = txt; h.matchClock.textContent = txt; }
    const key = `${flags.alpha ?? ''}|${flags.bravo ?? ''}`;
    if (key !== h.lastFlagsKey) {
      h.lastFlagsKey = key;
      paintFlagChip(h.flagA, flags.alpha);
      paintFlagChip(h.flagB, flags.bravo);
    }
  }

export function setDeathOverlay(h: HUD, on: boolean): void {
    if (on && !h.deathOverlay) {
      const d = document.createElement('div');
      d.id = 'death-overlay';
      const c = document.createElement('div');
      c.className = 'death-clock';
      d.appendChild(c);
      document.body.appendChild(d);
      h.deathOverlay = d;
      h.deathClock = c;
      h.diedAt = performance.now();
      h.lastDeathTxt = '';
    } else if (!on && h.deathOverlay) {
      h.deathOverlay.remove();
      h.deathOverlay = null;
      h.deathClock = null;
    }
  }

/** Frame tick while dead — counts down to the server respawnMs deadline.
 *  A held corpse (L's die+spectate) doesn't count down: the server parks
 *  it until a dead-state press, so the line says so instead of lying. */
export function updateDeathCountdown(h: HUD, respawnMs: number, held = false): void {
    if (!h.deathClock) return;
    const left = Math.max(0, respawnMs - (performance.now() - h.diedAt));
    const txt = held ? 'DEAD — CLICK TO RESPAWN'
      : left > 0 ? `RESPAWN IN ${(left / 1000).toFixed(1)}` : 'RESPAWNING';
    if (txt !== h.lastDeathTxt) {
      h.deathClock.textContent = txt;
      h.lastDeathTxt = txt;
    }
  }

  // Spectator chrome: HUD hides entirely while flying; this hint is all
  // that remains so the exit key stays discoverable.
export function setSpectatorHint(h: HUD, on: boolean): void {
    if (on && !h.spectateHint) {
      const d = document.createElement('div');
      d.id = 'spectate-hint';
      d.textContent = 'SPECTATING';
      document.body.appendChild(d);
      h.spectateHint = d;
    } else if (!on && h.spectateHint) {
      h.spectateHint.remove();
      h.spectateHint = null;
    }
  }

  /* Status effects (cloak/shield/mend) share one chrome shape: a top-center
     chip + a full-screen edge vignette. Colors/offsets live in hud.css —
     these methods just flip elements on and off. */
export function setStatusFx(h: HUD, kind: 'cloak' | 'shield' | 'mend', label: string, on: boolean): void {
    const fx = h.statusFx.get(kind);
    if (on && !fx) {
      const vig = document.createElement('div');
      vig.className = `status-vignette ${kind}`;
      const hint = document.createElement('div');
      hint.className = `status-hint ${kind}`;
      hint.textContent = label;
      document.body.append(vig, hint);
      h.statusFx.set(kind, { hint, vig });
    } else if (!on && fx) {
      fx.hint.remove();
      fx.vig.remove();
      h.statusFx.delete(kind);
    }
  }

