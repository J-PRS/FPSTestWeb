import * as THREE from 'three';
import type { Player } from '../../entities/Player.js';

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
  weaponSlots: HTMLSpanElement[];
  healthBar: HTMLDivElement;
  energyBar: HTMLDivElement;
  dmgVignette: HTMLDivElement;
  dmgEdge: HTMLDivElement;
  dmgDir: HTMLDivElement;
  dmgDirArc: HTMLDivElement;
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

  // HUD abbreviations indexed by wid = SLOT_DEFS position (all 19 slots —
  // sidearms included, since a stale persisted loadout can shoulder one).
  private static readonly WEAPON_SHORT = [
    'BLT', 'DSG', 'CG', 'MTR', 'GL', 'FLK', 'PLM', 'RAIL', 'LG', 'SG', 'CAN', 'RKT',
    'PST', 'REV', 'STK', 'PLG', 'SPR', 'RPR', 'MRV', 'BMB',
  ];

  constructor(private h: StatsHost) {}

  tick(dt: number, player: Player, ping = 0, packetLoss = 0, jitter = 0): void {
    const {h} = this;
    this.tickVitals(dt, player);
    this.tickBuffs(player);
    this.lastPlayerPos.copy(player.pos);
    this.lastPlayerYaw = player.yaw;
    this.tickDamageFx(dt);

    const nrg = Math.round(player.energy);
    this.setText(h.energy, 'energy', String(nrg));
    const energyPct = Math.round((nrg / 60) * 100);
    if (energyPct !== this.lastEnergyPct) {
      this.lastEnergyPct = energyPct;
      h.energyBar.style.transform = `scaleX(${energyPct / 100})`;
    }

    // Three readouts, all magnitude: |v| total, XZ horizontal, |vy|.
    this.setText(h.speed, 'speed', String(Math.round(player.vel.length())));
    this.setText(h.speedH, 'speedH', String(Math.round(player.getSpeed())));
    this.setText(h.speedV, 'speedV', String(Math.round(Math.abs(player.vel.y))));
    this.setText(h.kills, 'kills', String(player.kills));
    this.setText(h.state, 'state', player.onGround ? 'GROUND' : 'AIR');
    this.setText(h.ping, 'ping', String(Math.round(ping)));
    this.setText(h.loss, 'loss', String(Math.round(packetLoss)));
    this.setText(h.jitter, 'jitter', String(Math.round(jitter)));

    // Slots are loadout-driven: labels + highlight re-render only on change.
    const loadoutKey = `${player.loadout.join(',')  }|${  player.weaponIndex}`;
    if (loadoutKey !== this.lastWeapon) {
      this.lastWeapon = loadoutKey;
      player.loadout.forEach((wid, i): void => {
        const s = h.weaponSlots[i];
        if (!s) {return;}
        s.textContent = `${i + 1} ${HudStats.WEAPON_SHORT[wid] ?? '?'}`;
        s.classList.toggle('active', i === player.weaponIndex);
      });
    }

    if (this.hitTimer > 0) {
      this.hitTimer -= dt;
      if (this.hitTimer <= 0) {h.hitMarker.classList.remove('visible');}
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
