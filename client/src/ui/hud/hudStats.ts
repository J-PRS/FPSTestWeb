import * as THREE from 'three';
import type { Player } from '../../entities/Player.js';
import { weaponDef } from '../../weapons.js';
import { ammoOf, getWeaponStats } from '../../../../shared/weapons.js';

/**
 * HudStats — the per-frame stat painter: vitals (health/energy/armor),
 * speed readouts, net telemetry, weapon slots, hit marker, damage
 * vignette + direction arc, buff chips, and the FPS meter. Every element
 * ref it paints comes off the host; its own change-detection state
 * (lastText/lastPct caches, timers) lives here.
 */

export interface StatsHost {
  health: HTMLSpanElement;
  energy: HTMLSpanElement;
  speed: HTMLSpanElement;
  speedH: HTMLSpanElement;
  speedV: HTMLSpanElement;
  kills: HTMLSpanElement;
  state: HTMLSpanElement;
  ping: HTMLSpanElement;
  loss: HTMLSpanElement;
  jitter: HTMLSpanElement;
  fps: HTMLSpanElement;
  hitMarker: HTMLDivElement;
  ghostBar: HTMLDivElement;
  armor: HTMLSpanElement;
  armorBar: HTMLDivElement;
  buffsRow: HTMLDivElement;
  weaponBar?: HTMLDivElement;
  weaponSlots: HTMLSpanElement[];
  healthBar: HTMLDivElement;
  energyBar: HTMLDivElement;
  dmgVignette: HTMLDivElement;
  dmgEdge: HTMLDivElement;
  dmgDir: HTMLDivElement;
  dmgDirArc: HTMLDivElement;
  wammoReadout: HTMLDivElement;
  wammoRegenFill?: HTMLDivElement;
  crosshair?: HTMLDivElement;
  bloomRing?: HTMLDivElement;
}

export class HudStats {
  // Last-rendered values — skip redundant DOM writes
  private lastText: Record<string, string> = {};
  private lastHealthPct = -1;
  private prevIsDead = false;
  private lastEnergyPct = -1;
  private lastFpsColor = '';
  private lastWeapon = '';
  private lastArmor = -1;
  private lastBuffsKey = '';
  private lastWammoCol = '';
  private lastWammoRegen = '';
  private lastXhairReady = true;
  private lastBloomPx = -1;
  private lastBloomAlpha = -1;
  private lastBloomW = -1;
  private lastBloomH = -1;
  private ghostPct = 100;      // trails healthPct downward on damage
  private hitTimer = 0;
  private dmgT = 0;            // vignette decay
  private dmgDirT = 0;         // arc fade
  private dmgEdgePeak = 0.5;   // edge-flash ceiling for the current hit
  private shieldVignetteReset = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private fpsValue = 0;
  private lastPlayerPos = new THREE.Vector3();
  private lastPlayerYaw = 0;

  // HUD abbreviations indexed by wid = SLOT_DEFS position (sidearms
  // included, since a stale persisted loadout can shoulder one). Order
  // must mirror weapons.ts SLOT_DEFS exactly - RocketLauncher has no
  // slot def (benched), so 'RKT' is gone and FDL/HOW sit at 25/26.
  private static readonly WEAPON_SHORT = [
    'BL', 'DSC', 'CG', 'MTR', 'GL', 'FLK', 'PLM', 'RG', 'LG', 'SG', 'CAN', 'ML',
    'PST', 'REV', 'STK', 'PG', 'SPR', 'RPR', 'MRV', 'BMB',
    'LAN', 'BLA', 'HLB', 'GON', 'BSK', 'FD', 'HOW',
  ];

  constructor(private h: StatsHost) {}

  tick(dt: number, player: Player, ping = 0, packetLoss = 0, jitter = 0): void {
    const {h} = this;
    this.tickVitals(dt, player);
    this.tickBuffs(player);
    this.lastPlayerPos.copy(player.pos);
    this.lastPlayerYaw = player.yaw;
    this.tickDamageFx(dt);
    this.tickEnergy(player);

    // Three readouts, all magnitude: |v| total, XZ horizontal, |vy|.
    this.setText(h.speed, 'speed', String(Math.round(player.vel.length())));
    this.setText(h.speedH, 'speedH', String(Math.round(player.getSpeed())));
    this.setText(h.speedV, 'speedV', String(Math.round(Math.abs(player.vel.y))));
    this.setText(h.kills, 'kills', String(player.kills));
    this.setText(h.state, 'state', player.onGround ? 'GROUND' : 'AIR');
    this.setText(h.ping, 'ping', String(Math.round(ping)));
    this.setText(h.loss, 'loss', String(Math.round(packetLoss)));
    this.setText(h.jitter, 'jitter', String(Math.round(jitter)));

    this.tickWeaponSlots(player);

    // Pool ammo readout under the crosshair - blank for unlimited weapons.
    // loadout carries slot indices; the pool keys on the real weaponType.
    // Live accrual via ammoOf: the raw cell only updates when something
    // calls accrue, and offline nothing does per-frame - the count AND
    // the regen sliver's fraction both need the lazy accrue to run here.
    const wid = player.armory?.secondaryWid ?? player.loadout[player.weaponIndex];
    const banked = wid === undefined || player.ammoPool === undefined
      ? undefined : ammoOf(player.ammoPool, weaponDef(wid).weaponType, performance.now() / 1000);
    this.tickAmmo(wid, banked);
    this.tickCrosshair(player, wid);
    this.tickBloom(player, wid);

    if (this.hitTimer > 0) {
      this.hitTimer -= dt;
      if (this.hitTimer <= 0) {h.hitMarker.classList.remove('visible');}
    }
  }

  private tickEnergy(player: Player): void {
    const nrg = Math.round(player.energy);
    this.setText(this.h.energy, 'energy', String(nrg));
    const energyPct = Math.round((nrg / 60) * 100);
    if (energyPct !== this.lastEnergyPct) {
      this.lastEnergyPct = energyPct;
      this.h.energyBar.style.transform = `scaleX(${energyPct / 100})`;
    }
  }

  // Slots are loadout-driven: labels + highlight re-render only on change.
  private tickWeaponSlots(player: Player): void {
    const locked = player.armory?.kitLocked === true;
    const loadoutKey = `${player.loadout.join(',')}|${player.weaponIndex}|${locked ? 1 : 0}`;
    if (loadoutKey === this.lastWeapon) {return;}
    this.lastWeapon = loadoutKey;
    // Kit locks shoulder one gun - the whole selector row hides; the
    // single weapon still names itself through the ammo readout.
    if (this.h.weaponBar) {this.h.weaponBar.style.display = locked ? 'none' : '';}
    if (locked) {return;}
    player.loadout.forEach((wid, i): void => {
      const s = this.h.weaponSlots[i];
      if (!s) {return;}
      s.style.display = '';
      s.textContent = `${i + 1} ${HudStats.WEAPON_SHORT[wid] ?? '?'}`;
      s.classList.toggle('active', i === player.weaponIndex);
    });
  }

  private tickAmmo(wid: number | undefined, banked: number | undefined): void {
    const {h} = this;
    if (h.wammoReadout) {
      const n = banked === undefined ? -1 : Math.floor(banked);
      // Yellow at 1, red at 0 - the low-clip tiers ride the cache key
      // so a color flip repaints without touching the text every frame.
      let col = '#66ccff';
      if (n === 0) {col = '#f44';}
      else if (n === 1) {col = '#ffd54a';}
      this.setText(h.wammoReadout, 'wammo', n < 0 ? '' : String(n));
      if (this.lastWammoCol !== col) {this.lastWammoCol = col; h.wammoReadout.style.color = col;}
    }
    this.tickAmmoRegen(wid, banked);
  }

  // Regen sliver: fractional accrue is the progress to the next round -
  // hidden on unlimited pools (no counter shown) and full drums.
  private tickAmmoRegen(wid: number | undefined, banked: number | undefined): void {
    const regen = this.h.wammoRegenFill;
    if (!regen) {return;}
    // Show only while a round is actually accruing - unlimited pools
    // and full drums get no track at all (an empty sliver parked under
    // every weapon reads as UI cruft).
    const st = wid === undefined ? undefined : getWeaponStats(weaponDef(wid).weaponType);
    const cap = st?.ammoCap ?? 0;
    // Only slow-charge pools earn the sliver - a Howitzer's 6s round
    // needs the countdown, a plasma gun's sub-second trickle is noise.
    const regenS = (st?.fireInterval ?? 0.5) * (st?.ammoRegenMult ?? 1);
    const accruing = banked !== undefined && banked < cap && regenS >= 2;
    (regen.parentElement as HTMLElement).style.display = accruing ? '' : 'none';
    const frac = accruing ? banked! % 1 : 0;
    const pct = `${(frac * 100).toFixed(0)}%`;
    if (this.lastWammoRegen !== pct) {this.lastWammoRegen = pct; regen.style.width = pct;}
  }

  // Deploy weapons telegraph a dead pull: groundedOnly and off the
  // ground/skiing = faint crosshair, same rule the fire gate applies.
  private tickCrosshair(player: Player, wid: number | undefined): void {
    const ch = this.h.crosshair;
    if (!ch) {return;}
    const grounded = wid === undefined
      || !(getWeaponStats(weaponDef(wid).weaponType).groundedOnly && (!player.onGround || player.skiing));
    if (grounded !== this.lastXhairReady) {
      this.lastXhairReady = grounded;
      ch.style.opacity = grounded ? '' : '0.25';
    }
  }

  // Bloom cone arms: alpha fades in on sqrt(normalized bloom) - they
  // ramp in FASTER than linear early (quadratic would do the reverse),
  // invisible at rest, full strength by bloom.max. Gap still rides the
  // real cone so the arms sit where slugs can land.
  private tickBloom(player: Player, wid: number | undefined): void {
    const {h} = this;
    if (!h.bloomRing) {return;}
    const bloomDef = wid === undefined ? undefined : weaponDef(wid).bloom;
    // Deadband: hidden for the first ~5% of the cone (the tight taps) -
    // sqrt then ramps the rest of the way to full at bloom.max.
    const t = bloomDef ? Math.min(1, Math.max(0, player.bloom / bloomDef.max - 0.05) / 0.95) : 0;
    const alpha = Math.round(Math.sqrt(t) * 20) / 20; // 5% steps - cache-friendly
    const px = bloomDef === undefined ? 0
      : Math.max(4, Math.round(player.bloom * window.innerHeight * 0.5));
    if (px !== this.lastBloomPx || alpha !== this.lastBloomAlpha) {
      this.lastBloomPx = px;
      this.lastBloomAlpha = alpha;
      h.bloomRing.style.setProperty('--gap', `${px}px`);
      h.bloomRing.style.opacity = String(alpha);
    }
    // Snap the origin to whole pixels or the tick edges anti-alias.
    const bw = window.innerWidth, bh = window.innerHeight;
    if (bw !== this.lastBloomW || bh !== this.lastBloomH) {
      this.lastBloomW = bw; this.lastBloomH = bh;
      h.bloomRing.style.left = `${Math.round(bw / 2)}px`;
      h.bloomRing.style.top = `${Math.round(bh / 2)}px`;
    }
  }

  hit(): void {
    this.hitTimer = 0.12;
    this.h.hitMarker.classList.add('visible');
  }

  // Health text + bar with ghost-drain: damage leaves a trailing sliver
  // that bleeds down at ~40%/s so a hit reads as loss, not a snap.
  private tickVitals(dt: number, player: Player): void {
    const {h} = this;
    // health is float (regen ticks at 12/s leave fractions) — the chip
    // shows whole hp or it prints 78.00000000000001.
    this.setText(h.health, 'health', String(Math.round(player.health)));
    // Bar %, not raw hp — heavy runs a 200hp pool and light 75, so the
    // width must normalize or heavies read "full" through half a healthbar.
    const healthPct = Math.round((player.health / player.maxHealth) * 100);
    // A first sample or restored life has no previous health to lose.
    const resetHealth = this.lastHealthPct < 0 || (this.prevIsDead && !player.isDead);
    this.prevIsDead = player.isDead;
    if (resetHealth) {
      this.lastHealthPct = healthPct;
      this.ghostPct = healthPct;
      h.healthBar.style.transform = `scaleX(${healthPct / 100})`;
      h.ghostBar.style.transform = 'scaleX(0)';
    }
    if (!resetHealth && healthPct !== this.lastHealthPct) {
      this.lastHealthPct = healthPct;
      h.healthBar.style.transform = `scaleX(${healthPct / 100})`;
      // Damage → ghost holds the old width and drains down; heal → snap
      if (healthPct < this.ghostPct) {
        this.paintGhost(healthPct);
      } else {
        this.ghostPct = healthPct;
        h.ghostBar.style.transform = 'scaleX(0)';
      }
    }
    if (this.ghostPct > healthPct) {
      this.ghostPct = Math.max(healthPct, this.ghostPct - 40 * dt);
      this.paintGhost(healthPct);
    }
    const armor = Math.round(player.armor);
    if (armor !== this.lastArmor) {
      this.lastArmor = armor;
      this.setText(h.armor, 'armor', String(armor));
      h.armorBar.style.transform = `scaleX(${armor / 100})`;
    }
  }

  // Ghost sliver: translate to the new health edge, scale the delta —
  // transform-only, no layout while it drains.
  private paintGhost(healthPct: number): void {
    this.h.ghostBar.style.transform =
      `translateX(${healthPct}%) scaleX(${(this.ghostPct - healthPct) / 100})`;
  }

  // Timed buffs — chips with seconds left; rebuilt only on change.
  private tickBuffs(player: Player): void {
    const now = Date.now();
    const hoardActive = player.heldBuffActive;
    const shieldLeft = player.buffUntil.shield > now ? Math.ceil((player.buffUntil.shield - now) / 1000) : 0;
    const buffsKey = `${player.buffUntil.regen > now ? Math.ceil((player.buffUntil.regen - now) / 1000) : 0}|${player.buffUntil.dd > now ? Math.ceil((player.buffUntil.dd - now) / 1000) : 0}|${hoardActive ? 1 : 0}|${shieldLeft}`;
    if (buffsKey === this.lastBuffsKey) {return;}
    this.lastBuffsKey = buffsKey;
    const chips: string[] = [];
    const [rs, ds] = buffsKey.split('|').map(Number);
    if (rs > 0) {chips.push(`<span class="buff regen">REGEN ${rs}s</span>`);}
    if (ds > 0) {chips.push(`<span class="buff dd">2×DMG ${ds}s</span>`);}
    if (hoardActive) {chips.push(`<span class="buff hoard">HOARD</span>`);}
    if (shieldLeft > 0) {chips.push(`<span class="buff shield">SHIELD ${shieldLeft}s</span>`);}
    this.h.buffsRow.innerHTML = chips.join('');
  }

  // Damage vignette decay (~0.7s to clear) + direction arc fade.
  private tickDamageFx(dt: number): void {
    if (this.dmgT > 0) {
      this.dmgT = Math.max(0, this.dmgT - dt * 1.4);
      this.h.dmgVignette.style.opacity = String(this.dmgT * 0.85);
    }
    if (this.dmgDirT > 0) {
      this.dmgDirT = Math.max(0, this.dmgDirT - dt * 1.1);
      this.h.dmgDir.style.opacity = String(this.dmgDirT);
      this.h.dmgEdge.style.opacity = String(this.dmgDirT * this.dmgEdgePeak);
    }
  }

  /** A frame actually RENDERED — the FPS meter counts renders, not loop
   *  ticks: the fps-cap skips renderFrame while sim/input tick at full
   *  rAF, so ticking here would read 60 on a 30fps cap. dt is the real
   *  elapsed time since the last render. */
  rendered(dt: number): void {
    this.updateFps(dt);
  }

  private updateFps(dt: number): void {
    this.fpsAccum += dt;
this.fpsFrames += 1;
    if (this.fpsAccum >= 0.5) {
      this.fpsValue = Math.round(this.fpsFrames / this.fpsAccum);
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }
    this.setText(this.h.fps, 'fps', String(this.fpsValue));
    let fpsColor = '#8cf';
    if (this.fpsValue < 40) {fpsColor = '#f44';}
    else if (this.fpsValue < 50) {fpsColor = '#f80';}
    else if (this.fpsValue < 59) {fpsColor = '#ff4';}
    if (fpsColor !== this.lastFpsColor) {
      this.lastFpsColor = fpsColor;
      this.h.fps.style.color = fpsColor;
    }
  }

  // Write text only when it changed — textContent assignment touches the DOM
  // even for identical strings. Public — the host's own nugget chip paints
  // through the same cache.
  setText(el: HTMLElement, key: string, value: string): void {
    if (this.lastText[key] === value) {return;}
    this.lastText[key] = value;
    el.textContent = value;
  }

  /** Same change-gate as setText, for style props (the belt sliver's
   *  scaleX would otherwise dirty the element every frame). */
  setStyle(el: HTMLElement, key: string, prop: 'transform', value: string): void {
    if (this.lastText[key] === value) {return;}
    this.lastText[key] = value;
    el.style[prop] = value;
  }

  /** Local player took damage — vignette pulse scaled to the hit, plus a
   *  directional arc pointing at the source when we know where it is. */
  damage(fromPos: THREE.Vector3 | null, damage: number): void {
    const {h} = this;
    // Vignette: 10dmg ≈ subtle, 40+ ≈ strong. Pulse semantics — a hit
    // raises the level to its own size, it doesn't accumulate: chip
    // ticks +0.26 each at multi-hit/s otherwise saturate the edge ring
    // permanently and graze fire reads identical to a direct mortar.
    this.dmgT = Math.min(1, Math.max(this.dmgT, 0.22 + damage * 0.014));
    h.dmgVignette.style.opacity = String(Math.min(0.85, this.dmgT));
    // A real hit during a shield glow takes the red shadow back now —
    // the shieldVignetteReset timeout alone would leave cyan until it fires.
    clearTimeout(this.shieldVignetteReset);
    h.dmgVignette.style.boxShadow = '';

    if (fromPos) {this.pointAt(fromPos, Math.min(0.85, 0.25 + damage * 0.015));}
  }

  /** Shielded hit — same directional language as damage() but cyan and
   *  punchier: the bubble ate it, the energy bar is the real damage readout. */
  shieldDamage(fromPos: THREE.Vector3 | null, damage: number): void {
    const {h} = this;
    this.dmgT = Math.min(1, Math.max(this.dmgT, 0.15 + damage * 0.008));
    h.dmgVignette.style.opacity = String(Math.min(0.6, this.dmgT));
    // The soak is cyan THROUGH the vignette — the red background would
    // otherwise show under the shadow for a muddy purple mix, and the
    // 300ms restore put red back mid-fade. Swap the gradient too.
    h.dmgVignette.style.background =
      'radial-gradient(ellipse at center, transparent 52%, transparent 68%, rgba(90,190,255,0.5) 100%)';
    h.dmgVignette.style.boxShadow =
      'inset 0 0 18vmax rgba(90,200,255,0.55), inset 0 0 5vmax rgba(140,220,255,0.4)';
    // Red restores on timeout or on the next real hit, whichever lands first.
    clearTimeout(this.shieldVignetteReset);
    this.shieldVignetteReset = window.setTimeout((): void => {
      h.dmgVignette.style.boxShadow = '';
      h.dmgVignette.style.background = '';
    }, 300);
    if (fromPos) {this.pointAt(fromPos, 0.35);}
  }

  /** Bearing: world angle of (source - player) relative to facing.
   *  forward = (sin yaw, cos yaw) on XZ; arc's 0° is screen-top. Same
   *  bearing rotates the edge flash so its red mass hugs that side. */
  private pointAt(fromPos: THREE.Vector3, edge = 0.5): void {
    const dx = fromPos.x - this.lastPlayerPos.x;
    const dz = fromPos.z - this.lastPlayerPos.z;
    let rel = Math.atan2(dx, dz) - this.lastPlayerYaw;
    // Normalize to [-π, π], then flip: screen-right is -x when yaw=0
    while (rel > Math.PI) {rel -= Math.PI * 2;}
    while (rel < -Math.PI) {rel += Math.PI * 2;}
    this.h.dmgDirArc.style.transform = `rotate(${-rel}rad)`;
    this.h.dmgEdge.style.transform = `rotate(${-rel}rad)`;
    this.dmgDirT = 1;
    this.dmgEdgePeak = edge;
    this.h.dmgDir.style.opacity = '1';
    this.h.dmgEdge.style.opacity = String(edge);
  }
}
