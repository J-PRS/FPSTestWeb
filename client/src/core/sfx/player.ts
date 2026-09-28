import { audio } from '../audio.js';
import { ctx, play, env, osc, sample, layer, noise } from './util.js';

export function jump(): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.15)) return;
  if (sample('jump', g, 0.5)) return;
  osc('sine', 250, 420, 0.12, 0.15, g);
}

export function land(impactSpeed: number): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.2)) return;
  const s = Math.min(1, impactSpeed / 30);
  if (sample('land', g, 0.3 * s + 0.1)) return;
  noise(0.15, 0.3 * s + 0.05, g, 'lowpass', 400, 120);
  if (s > 0.6) osc('sine', 120, 50, 0.15, 0.2 * s, g);
}

export function dash(): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.25)) return;
  if (sample(Math.random() < 0.5 ? 'dash' : 'dash2', g, 0.5)) return;
  noise(0.22, 0.3, g, 'bandpass', 600, 2400, 1.5);
}

export function bounce(): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.2)) return;
  if (sample('bounce', g, 0.6)) return;
  osc('triangle', 300, 700, 0.15, 0.25, g);
}

export function blink(): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.2)) return;
  if (sample('teleport', g, 0.4)) return;
  osc('sine', 1200, 2400, 0.08, 0.15, g);
  osc('sine', 800, 300, 0.12, 0.15, g);
}

export function slam(): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.4)) return;
  // Layered: big metallic slam + low thud an octave down = impact with weight
  if (layer(g, [['thud_big', 0.9], ['slam_thud', 0.8, 0.8]])) return;
  noise(0.35, 0.5, g, 'lowpass', 800, 80);
  osc('sine', 90, 30, 0.35, 0.6, g);
}

export function hitMarker(direct: boolean): void {
  const bus = audio.uiBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.08)) return;
  if (sample('hit_marker', g, direct ? 0.6 : 0.4, direct ? 1.2 : 1)) return;
  osc('square', direct ? 2200 : 1600, direct ? 1800 : 1400, 0.05, direct ? 0.18 : 0.12, g);
}

export function playerHurt(): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.2)) return;
  // Neutral short snap — 'hurt' was a monster grunt, impact+punch too heavy
  if (sample('impact', g, 0.45, 1.3, 2500, 0.15)) return;
  osc('sawtooth', 300, 120, 0.15, 0.25, g);
  noise(0.12, 0.2, g, 'lowpass', 600, 200);
}

export function pickup(): void {
  const bus = audio.uiBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.25)) return;
  if (sample('pickup', g, 0.4)) return;
  osc('sine', 880, 880, 0.07, 0.15, g);
  const o2 = c.createOscillator(); const g2 = c.createGain();
  o2.type = 'sine';
  o2.frequency.setValueAtTime(1320, c.currentTime + 0.07);
  env(g2, c.currentTime + 0.07, 0.15, 0.12);
  o2.connect(g2).connect(bus);
  o2.start(c.currentTime + 0.07); o2.stop(c.currentTime + 0.25);
}

export function equip(): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.5)) return;
  if (sample('equip', g, 0.55)) return;
  osc('square', 500, 700, 0.06, 0.1, g);
}

export function shieldOn(): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.4)) return;
  // Rising shimmer — a wall of charge snapping into place.
  osc('sine', 300, 900, 0.18, 0.22, g);
  osc('triangle', 600, 1800, 0.22, 0.1, g);
  noise(0.15, 0.12, g, 'bandpass', 2000, 5000, 1.2);
}

export function shieldHit(): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.12)) return;
  // Metallic ping + absorbed thud — energy taking the punch.
  osc('sine', 1500, 900, 0.07, 0.2, g);
  noise(0.06, 0.15, g, 'highpass', 3000);
}

export function shieldBreak(): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.4)) return;
  // Falling shimmer — the bubble collapsing.
  osc('sine', 900, 180, 0.28, 0.25, g);
  noise(0.2, 0.18, g, 'bandpass', 4000, 600, 1.4);
}

export function mendOn(): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.35)) return;
  // Warm rising hum — the field knitting you back together.
  osc('sine', 400, 800, 0.2, 0.2, g);
  osc('triangle', 800, 1200, 0.25, 0.08, g);
}

export function mendOff(): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.25)) return;
  osc('sine', 800, 350, 0.18, 0.15, g);
}

export function killConfirm(): void {
  const bus = audio.uiBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.3)) return;
  if (sample('powerup', g, 0.5)) return;
  osc('square', 660, 660, 0.06, 0.15, g);
  osc('square', 990, 990, 0.12, 0.15, g);
}
