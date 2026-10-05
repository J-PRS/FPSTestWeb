// VGS voice — SAM (Software Automatic Mouth, 1982 C64 synth) via sam-js.
// ~21KB bundled, zero assets, pure JS — the era-correct robot voice for a
// Tribes-alike. buf32() hands us raw PCM so the whole radio FX chain
// (clip → ring-mod → bandpass → slapback → squelch) still applies.
//
// Voice casting: each playerId maps deterministically to pitch/speed/
// mouth/throat — a "voice pack" per speaker, stable across sessions.
// Typed chat can opt into plain system TTS (CHAT TTS toggle) — the two
// channels deliberately sound different.

import SamJs from 'sam-js';
import { audio } from './audio.js';
import { settings } from './settings.js';

const SAM_RATE = 22050; // sam-js renders at a fixed 22050Hz

// Per-speaker SAM voices — pitch/mouth/throat sweeps around the default
// 64/72/128-ish register. Divergent enough to tell speakers apart,
// constrained enough that everything still reads as "the same radio".
const VOICES: ReadonlyArray<{ pitch: number; speed: number; mouth: number; throat: number }> = [
  { pitch: 64, speed: 72, mouth: 128, throat: 128 }, // stock SAM
  { pitch: 48, speed: 74, mouth: 150, throat: 110 }, // low buzz
  { pitch: 82, speed: 70, mouth: 110, throat: 150 }, // reedy
  { pitch: 56, speed: 78, mouth: 128, throat: 170 }, // throaty drone
  { pitch: 90, speed: 80, mouth: 140, throat: 120 }, // tinny fast
  { pitch: 40, speed: 66, mouth: 160, throat: 140 }, // gravelpit
  { pitch: 72, speed: 76, mouth: 100, throat: 100 }, // clipped light
  { pitch: 60, speed: 70, mouth: 170, throat: 128 }, // wide mouth
];

const samCache = new Map<number, SamJs>();

function samFor(who?: string): SamJs {
  let idx = 0;
  if (who) {
    let h = 0;
    for (let i = 0; i < who.length; i++) {h = (h * 31 + who.charCodeAt(i)) | 0;}
    idx = Math.abs(h) % VOICES.length;
  }
  let s = samCache.get(idx);
  if (!s) { s = new SamJs(VOICES[idx]); samCache.set(idx, s); }
  return s;
}

function speakSystem(text: string, pitch = 0.85): void {
  if (typeof speechSynthesis === 'undefined') {return;}
  if (speechSynthesis.pending || speechSynthesis.speaking) {speechSynthesis.cancel();}
  const u = new SpeechSynthesisUtterance(text.replace(/!/g, ''));
  u.rate = 1.05;
  u.pitch = pitch;
  u.volume = 0.9;
  speechSynthesis.speak(u);
}

/** Speak a VGS line through the C64 robot. `who` picks the throat. */
export function speakVgs(text: string, who?: string): void {
  const bus = audio.uiBus;
  const ctx = bus?.context;
  if (!bus || !ctx) {return;}
  let pcm: unknown; // sam-js returns Float32Array | Boolean
  try {
    pcm = samFor(who).buf32(text);
  } catch {
    speakSystem(text); // reciter hiccup → degrade to system voice
    return;
  }
  // buf32 returns false (not throws) on unparseable text — apostrophes,
  // stray symbols — degrade to the system voice rather than silent.
  if (!(pcm instanceof Float32Array) || !pcm.length) { speakSystem(text); return; }
  const buf = ctx.createBuffer(1, pcm.length, SAM_RATE);
  buf.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
  playRadioVoice(ctx, bus, buf);
}

/** Typed chat read-aloud — deliberately the plain system voice, NOT the
 *  robot, so typed messages and VGS calls sound like different channels.
 *  Pitch jitters per speaker so voices differ by who typed. */
export function speakChat(text: string, who?: string): void {
  let h = 0;
  if (who) {for (let i = 0; i < who.length; i++) h = (h * 31 + who.charCodeAt(i)) | 0;}
  speakSystem(text, 0.7 + (Math.abs(h) % 8) * 0.08); // 0.70–1.26
}

/** True when the CHAT TTS option is on — the call sites read through
 *  this so the toggle applies live, no reload. */
export function chatTtsEnabled(): boolean {
  return settings.get('fps-tts-chat');
}

/** Radio-comms chain for the robot voice:
 *    squelch click → src → soft-clip → ring-mod mix → bandpass → slapback → bus
 *  SAM raw is a dry robot; the metallic ring + squelch is what makes it
 *  sound like a battlesuit comm instead of a C64 demo. */
function playRadioVoice(ctx: BaseAudioContext, bus: AudioNode, buf: AudioBuffer): void {
  const t = ctx.currentTime;

  // Soft clip — cheap grit, evens the synth's level swings too.
  const clip = ctx.createWaveShaper();
  if (!_clipCurve) {
    _clipCurve = new Float32Array(new ArrayBuffer(256 * 4));
    for (let i = 0; i < 256; i++) { const x = i / 128 - 1; _clipCurve[i] = Math.tanh(x * 2.2); }
  }
  clip.curve = _clipCurve;

  // Ring mod at 45Hz = metallic sidebands, mixed ~35% wet — SAM is
  // already robotic; too much ring just smears the words.
  const dry = ctx.createGain(); dry.gain.value = 0.65;
  const wet = ctx.createGain(); wet.gain.value = 0.35;
  const ring = ctx.createGain(); ring.gain.value = 0;
  const carrier = ctx.createOscillator();
  carrier.frequency.value = 45;
  carrier.connect(ring.gain);

  // Speech-band bandpass — comm-radio tint under the game mix.
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 1300; bp.Q.value = 0.5;

  // Slapback: short feedback delay = cockpit/radio spaciousness.
  const dly = ctx.createDelay(0.2); dly.delayTime.value = 0.07;
  const fb = ctx.createGain(); fb.gain.value = 0.18;
  const dlyWet = ctx.createGain(); dlyWet.gain.value = 0.25;
  dly.connect(fb); fb.connect(dly);

  const out = ctx.createGain(); out.gain.value = 0.9;
  const src = ctx.createBufferSource(); src.buffer = buf;
  src.connect(clip);
  clip.connect(dry); dry.connect(bp);
  clip.connect(ring); ring.connect(wet); wet.connect(bp);
  bp.connect(out);
  bp.connect(dly); dly.connect(dlyWet); dlyWet.connect(out);
  out.connect(bus);

  // Squelch click at the head — the press-to-talk key-up.
  const sq = ctx.createBufferSource();
  sq.buffer = squelchBuf(ctx);
  const sqG = ctx.createGain(); sqG.gain.value = 0.25;
  const sqBp = ctx.createBiquadFilter(); sqBp.type = 'bandpass'; sqBp.frequency.value = 1800; sqBp.Q.value = 2;
  sq.connect(sqBp); sqBp.connect(sqG); sqG.connect(out);

  carrier.start(t); sq.start(t); src.start(t);
  carrier.stop(t + buf.duration + 0.3);
}

let _clipCurve: Float32Array<ArrayBuffer> | null = null;
let _squelch: AudioBuffer | null = null;

/** Tiny white-noise pip, highpassed — press-to-talk squelch. */
function squelchBuf(ctx: BaseAudioContext): AudioBuffer {
  if (_squelch) {return _squelch;}
  const n = Math.floor(ctx.sampleRate * 0.035);
  const b = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < n; i++) {d[i] = (Math.random() * 2 - 1) * (1 - i / n);}
  _squelch = b;
  return b;
}
