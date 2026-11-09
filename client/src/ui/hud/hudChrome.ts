import { WeaponType } from '../../../../shared/weapons.js';
import { botDisplayName } from '../../../../shared/botNames.js';
import type { HUD } from '../hud.js';
import { hudRegion } from './regions.js';

// HUD chrome family — kill feed, match clock + flag chips, death
// vignette/countdown, spectator hint, status-effect chip+vignette.
// All flip DOM elements only; field state lives on the HUD.

const paintFlagChip = (el: HTMLElement, st?: string): void => {
  el.style.display = st ? '' : 'none';
  if (!st) {return;}
  el.textContent = '⚑ LOOSE';
if (st === 'home') {el.textContent = '⚑';}
else if (st === 'carried') {el.textContent = '⚑ TAKEN';}
  el.classList.toggle('taken', st !== 'home');
};

// Enum-name reverse lookup: `WeaponType[7]` → 'PlasmaCannon'. Unknown/absent → nothing shown.
// Projectile airtime rides after the weapon: `[PlasmaCannon] [1.3s]` —
// long-lob kills earn the visible flight time. Sub-100ms hits are
// effectively point-blank; the bracket would just be noise.
function weaponTag(weapon: number | undefined, air: number | undefined): string {
    const wName = weapon !== undefined && WeaponType[weapon] ? `[${WeaponType[weapon]}]` : '';
    const airTag = air !== undefined && air >= 0.1 ? ` [${air.toFixed(1)}s]` : '';
    return wName || airTag ? ` ${wName}${airTag} ` : '';
}

// Self-inflicted kill (own splash): "X cratered" — "X ▸ X" reads as a
// normal frag in the feed.
function killRow(shooter: string, target: string, localIsShooter: boolean, localIsTarget: boolean, meta?: { shooter?: string; target?: string; weapon?: number; air?: number; sName?: string; tName?: string }): HTMLDivElement {
    const { shooter: sTeam, target: tTeam, weapon, air, sName, tName } = meta ?? {};
    const row = document.createElement('div');
    row.className = 'kf-row';
    if (localIsShooter) {row.classList.add('me');}
    const suicide = shooter === target;
    const s = document.createElement('span');
    // Team tint like the TAB board — alpha/bravo first letter keys the class.
    s.className = `kf-s${  sTeam ? ` tm-${sTeam[0]}` : ''}`;
    s.textContent = shooter === 'environment' ? '☠' : (sName ?? botDisplayName(shooter));
    const w = document.createElement('span');
    w.className = 'kf-w';
    w.textContent = weaponTag(weapon, air);
    const t = document.createElement('span');
    let deadCls = '';
    if (localIsTarget) {deadCls = ' dead';}
    else if (tTeam) {deadCls = ` tm-${tTeam[0]}`;}
    t.className = `kf-t${deadCls}`;
    t.textContent = suicide ? 'self' : (tName ?? botDisplayName(target));
    row.append(s, w, t);
    return row;
}

export function feedKill(h: HUD, shooter: string, target: string, localIsShooter: boolean, localIsTarget: boolean, meta?: { shooter?: string; target?: string; weapon?: number; air?: number; sName?: string; tName?: string }): void {
    const row = killRow(shooter, target, localIsShooter, localIsTarget, meta);
    h.killFeed.append(row);
    while (h.killFeed.childElementCount > 6) {h.killFeed.firstElementChild!.remove();}
    // Hard expiry — a fading ghost row reads as a smear while the stack
    // snaps up through it; classic feeds just cut the row in one frame.
    setTimeout((): void => row.remove(), 5200);
    // Kills render ONCE, here — the #player-list log (logEvent) keeps the
    // non-frag timeline (flags, match text) or every kill doubles up.
  }

export function setMatchStatus(h: HUD, msLeft: number | null, flags: { alpha?: string; bravo?: string }): void {
    const hasAny = msLeft !== null || flags.alpha || flags.bravo;
    h.matchStatus.style.display = hasAny ? 'flex' : 'none';
    if (!hasAny) {return;}
    let txt = '';
    if (msLeft === null) {
      h.matchClock.style.display = 'none';
    } else {
      const s = Math.max(0, Math.floor(msLeft / 1000));
      txt = msLeft <= 0 ? 'OT' : `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      h.matchClock.classList.toggle('late', msLeft < 60_000);
      h.matchClock.style.display = '';
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
      d.append(c);
      document.body.append(d);
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
    if (!h.deathClock) {return;}
    const left = Math.max(0, respawnMs - (performance.now() - h.diedAt));
    let txt = 'RESPAWNING';
    if (held) {txt = 'DEAD — CLICK TO RESPAWN';}
    else if (left > 0) {txt = `RESPAWN IN ${(left / 1000).toFixed(1)}`;}
    if (txt !== h.lastDeathTxt) {
      h.deathClock.textContent = txt;
      h.lastDeathTxt = txt;
    }
  }

  /** Boot veil: one blurred overlay while the FPS warmup hold runs.
 *  Release only flips a class — the blur dissolve itself animates on the
 *  compositor and the node is dropped once transparent. */
let bootVeil: HTMLDivElement | null = null;
export function setBootVeil(on: boolean): void {
    document.documentElement.classList.toggle('boot-holding', on);
    if (on && !bootVeil) {
      bootVeil = document.createElement('div');
      bootVeil.id = 'boot-veil';
      document.body.append(bootVeil);
    } else if (!on && bootVeil) {
      const el = bootVeil;
      bootVeil = null;
      el.classList.add('releasing');
      // A node that reached opacity 0 is dead weight — drop it after the
      // dissolve; the timeout doubles as a skipped-transitionend fallback.
      setTimeout((): void => el.remove(), 700);
    }
  }

  // Spectator chrome: HUD hides entirely while flying; this hint is all
  // that remains so the exit key stays discoverable.
export function setSpectatorHint(h: HUD, on: boolean): void {
    if (on && !h.spectateHint) {
      const d = document.createElement('div');
      d.id = 'spectate-hint';
      d.textContent = 'SPECTATING';
      hudRegion('tc').append(d);
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
      document.body.append(vig);
      hudRegion('tc').append(hint);
      h.statusFx.set(kind, { hint, vig });
    } else if (!on && fx) {
      fx.hint.remove();
      fx.vig.remove();
      h.statusFx.delete(kind);
    }
  }

