import { audio } from '../audio.js';
import { ctx, play, env, osc, sample, layer, noise } from './util.js';

export function jump(): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.15, undefined, 1)) return;
  // A hop is footwork, not a fanfare — the 'jump' sample read as a
  // cartoon boop and autoHop machine-gunned it. Short air whoosh + a
  // faint low thump instead; quiet enough to hold the key.
  noise(0.1, 0.09, g, 'bandpass', 900, 400, 0.8);
  osc('sine', 170, 95, 0.09, 0.06, g);
}

export function land(impactSpeed: number): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.2, undefined, 1)) return;
  const s = Math.min(1, impactSpeed / 30);
  if (sample('land', g, 0.3 * s + 0.1)) return;
  noise(0.15, 0.3 * s + 0.05, g, 'lowpass', 400, 120);
  if (s > 0.6) osc('sine', 120, 50, 0.15, 0.2 * s, g);
}

export function dash(): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.25, undefined, 1)) return;
  if (sample(Math.random() < 0.5 ? 'dash' : 'dash2', g, 0.5)) return;
  noise(0.22, 0.3, g, 'bandpass', 600, 2400, 1.5);
}

export function bounce(): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.2, undefined, 1)) return;
  if (sample('bounce', g, 0.6)) return;
  osc('triangle', 300, 700, 0.15, 0.25, g);
}

export function blink(): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.2, undefined, 1)) return;
  if (sample('teleport', g, 0.4)) return;
  osc('sine', 1200, 2400, 0.08, 0.15, g);
  osc('sine', 800, 300, 0.12, 0.15, g);
}

export function slam(): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.4, undefined, 1)) return;
  // Layered: big metallic slam + low thud an octave down = impact with weight
  if (layer(g, [['thud_big', 0.9], ['slam_thud', 0.8, 0.8]])) return;
  noise(0.35, 0.5, g, 'lowpass', 800, 80);
  osc('sine', 90, 30, 0.35, 0.6, g);
}

export function hitMarker(direct: boolean): void {
  const bus = audio.uiBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.08, undefined, 2)) return;
  if (sample('hit_marker', g, direct ? 0.6 : 0.4, direct ? 1.2 : 1)) return;
  osc('square', direct ? 2200 : 1600, direct ? 1800 : 1400, 0.05, direct ? 0.18 : 0.12, g);
}

export function playerHurt(): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.2, undefined, 1)) return;
  // Neutral short snap — 'hurt' was a monster grunt, impact+punch too heavy
  if (sample('impact', g, 0.45, 1.3, 2500, 0.15)) return;
  osc('sawtooth', 300, 120, 0.15, 0.25, g);
  noise(0.12, 0.2, g, 'lowpass', 600, 200);
}

export function pickup(): void {
  const bus = audio.uiBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.25, undefined, 2)) return;
  if (sample('pickup', g, 0.4)) return;
  osc('sine', 880, 880, 0.07, 0.15, g);
  const o2 = c.createOscillator(); const g2 = c.createGain();
  o2.type = 'sine';
  o2.frequency.setValueAtTime(1320, c.currentTime + 0.07);
  env(g2, c.currentTime + 0.07, 0.15, 0.12);
  o2.connect(g2).connect(bus);
  o2.start(c.currentTime + 0.07); o2.stop(c.currentTime + 0.25);
}

/** Server powerup collect — one synth voice per kind so the reward reads
 *  by ear: heal chirps warm, armor clanks metal, regen bubbles up, dd
 *  growls. Falls back to the plain pickup chirp when a 'powerup' sample
 *  exists in the bank. */
export function powerup(kind: string): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.6, undefined, 2)) return;
  if (sample(`powerup_${kind}`, g, 0.5)) return;
  if (sample('powerup', g, 0.45)) { powerupTail(kind, g); return; }
  switch (kind) {
    case 'heal':
      osc('sine', 520, 1040, 0.16, 0.3, g);
      osc('sine', 780, 1560, 0.2, 0.18, g);
      break;
    case 'armor':
      osc('square', 220, 180, 0.1, 0.3, g);
      noise(0.12, 0.25, g, 'bandpass', 3200, 1800, 2);
      osc('triangle', 900, 1500, 0.22, 0.12, g);
      break;
    case 'regen':
      osc('sine', 300, 1200, 0.3, 0.25, g);
      osc('sine', 600, 1800, 0.35, 0.12, g);
      noise(0.25, 0.08, g, 'highpass', 2500, 6000, 1);
      break;
    case 'dd':
      osc('sawtooth', 160, 90, 0.3, 0.4, g);
      osc('sawtooth', 320, 640, 0.15, 0.2, g);
      noise(0.2, 0.15, g, 'lowpass', 900, 300);
      break;
    case 'gem':
      // Crystal chime — the nugget economy's coin-drop.
      osc('sine', 1040, 1560, 0.09, 0.25, g);
      osc('sine', 1560, 2080, 0.14, 0.15, g);
      break;
    case 'tag':
      // Metallic clink — dog-tag confirm, drier than the gem chime.
      noise(0.05, 0.2, g, 'bandpass', 4200, 2600, 3);
      osc('square', 880, 660, 0.07, 0.12, g);
      break;
    default:
      osc('sine', 880, 880, 0.07, 0.15, g);
  }
}

/** Light shimmer layered under a real 'powerup' sample so each kind keeps
 *  a bit of its own color on top of the shared recording. */
function powerupTail(kind: string, g: GainNode): void {
  switch (kind) {
    case 'heal': osc('sine', 780, 1400, 0.18, 0.12, g); break;
    case 'armor': noise(0.1, 0.12, g, 'bandpass', 3000, 2000, 2); break;
    case 'regen': osc('sine', 500, 1500, 0.3, 0.1, g); break;
    case 'dd': osc('sawtooth', 180, 100, 0.25, 0.18, g); break;
    case 'gem': osc('sine', 1560, 2080, 0.12, 0.1, g); break;
    case 'tag': noise(0.05, 0.1, g, 'bandpass', 4200, 2600, 3); break;
  }
}

export function equip(): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.5, undefined, 1)) return;
  if (sample('equip', g, 0.55)) return;
  osc('square', 500, 700, 0.06, 0.1, g);
}

export function shieldOn(): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.4, undefined, 1)) return;
  // Rising shimmer — a wall of charge snapping into place.
  osc('sine', 300, 900, 0.18, 0.22, g);
  osc('triangle', 600, 1800, 0.22, 0.1, g);
  noise(0.15, 0.12, g, 'bandpass', 2000, 5000, 1.2);
}

export function shieldHit(): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.12, undefined, 1)) return;
  // Metallic ping + absorbed thud — energy taking the punch.
  osc('sine', 1500, 900, 0.07, 0.2, g);
  noise(0.06, 0.15, g, 'highpass', 3000);
}

export function shieldBreak(): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.4, undefined, 1)) return;
  // Falling shimmer — the bubble collapsing.
  osc('sine', 900, 180, 0.28, 0.25, g);
  noise(0.2, 0.18, g, 'bandpass', 4000, 600, 1.4);
}

export function mendOn(): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.35, undefined, 1)) return;
  // Warm rising hum — the field knitting you back together.
  osc('sine', 400, 800, 0.2, 0.2, g);
  osc('triangle', 800, 1200, 0.25, 0.08, g);
}

export function mendOff(): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.25, undefined, 1)) return;
  osc('sine', 800, 350, 0.18, 0.15, g);
}

/** CTF flag stingers — the cue has to read the event AND whose flag it is
 *  in under a second, before the frag callout is even parsed.
 *  taken: enemy snatch = urgent rising alarm; ours grabbed = dread drop.
 *  dropped: muted mid-thud — chase is on.
 *  returned: clean rising resolve. captured: chime for us, heavy toll for them. */
export function flagCue(kind: 'taken' | 'dropped' | 'returned' | 'captured', mine: boolean): void {
  const bus = audio.uiBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.6, undefined, 2)) return;
  const t0 = c.currentTime;
  const note = (f: number, dt: number, dur: number, peak: number, type: OscillatorType = 'triangle') => {
    const o = c.createOscillator(); const g2 = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t0 + dt);
    env(g2, t0 + dt, peak, dur);
    o.connect(g2).connect(g);
    o.start(t0 + dt); o.stop(t0 + dt + dur + 0.05);
  };
  if (kind === 'taken') {
    if (mine) { note(620, 0, 0.14, 0.22); note(310, 0.12, 0.3, 0.2, 'sine'); } // sinking dread — ours is gone
    else { note(880, 0, 0.08, 0.18); note(1175, 0.08, 0.14, 0.16); }          // rising alarm — we took theirs
  } else if (kind === 'dropped') {
    note(200, 0, 0.12, 0.2, 'sine'); noise(0.08, 0.12, g, 'lowpass', 500, 150);
  } else if (kind === 'returned') {
    note(520, 0, 0.09, 0.16); note(780, 0.09, 0.15, 0.14);
  } else { // captured
    if (mine) { note(210, 0, 0.35, 0.3, 'sine'); note(140, 0.12, 0.4, 0.28, 'sine'); } // they scored — heavy toll
    else { for (const [f, dt] of [[523, 0], [659, 0.08], [784, 0.16], [1047, 0.26]] as const) note(f, dt, 0.2, 0.16); }
  }
}

/** Match-boundary horn. start: single rising brass blast — the kickoff
 *  whistle. end: win = bright two-note resolve; loss/draw = a low flat
 *  buzzer so "we lost" doesn't need the banner to read. */
export function matchHorn(kind: 'start' | 'win' | 'end'): void {
  const bus = audio.uiBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 1, undefined, 2)) return;
  const t0 = c.currentTime;
  const note = (f: number, dt: number, dur: number, peak: number, type: OscillatorType = 'sawtooth') => {
    const o = c.createOscillator(); const g2 = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t0 + dt);
    env(g2, t0 + dt, peak, dur);
    o.connect(g2).connect(g);
    o.start(t0 + dt); o.stop(t0 + dt + dur + 0.05);
  };
  if (kind === 'start') {
    note(392, 0, 0.5, 0.12); note(392 * 1.5, 0, 0.5, 0.06); // octave-fifth brass
  } else if (kind === 'win') {
    note(523, 0, 0.18, 0.14); note(784, 0.18, 0.5, 0.15);
  } else {
    note(196, 0, 0.7, 0.14); note(185, 0, 0.7, 0.1); // detuned low buzzer
  }
}

export function killConfirm(): void {
  const bus = audio.uiBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.5, undefined, 2)) return;
  // The payoff: a frag should read as IMPACT, not a menu ding. Meaty low
  // thunk + a metallic frag-bell clang + punch transient, then a short
  // two-note chime on top so the "confirmed" rise survives the hit.
  if (layer(g, [
    ['slam_thud', 0.8, 0.85, 900, 0.3],
    ['hg_clang', 0.55, 1.5, undefined, 0.22, 0.02],
    ['punch', 0.4, 1.2, 2500, 0.08],
  ])) {
    // chime below still runs — the reward notes on top of the impact
  } else {
    osc('sine', 140, 60, 0.22, 0.35, g); // fallback body when the bank's dry
  }
  // Rising two-note chime — scheduled manually since osc() has no delay arg
  const t0 = c.currentTime;
  for (const [f, dt, dur, peak] of [[740, 0.02, 0.09, 0.16], [1110, 0.1, 0.16, 0.14]] as const) {
    const o = c.createOscillator(); const g2 = c.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(f, t0 + dt);
    env(g2, t0 + dt, peak, dur);
    o.connect(g2).connect(g);
    o.start(t0 + dt); o.stop(t0 + dt + dur + 0.05);
  }
}
