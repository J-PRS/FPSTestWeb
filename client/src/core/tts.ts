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

let _squelch: AudioBuffer | null = null;

const SAM_RATE = 22_050; // sam-js renders at a fixed 22050Hz

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
    // oxlint-disable-next-line prefer-math-trunc -- int32 wrap is the point
    for (let i = 0; i < who.length; i += 1) {h = (h * 31 + who.charCodeAt(i)) | 0;}
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

/** Speak a VGS line through the C64 robot. `who` picks the throat.
 *  A fresh line from the same speaker hard-stops their in-flight sample
 *  — the mechanism under the era's "VGS combo" hack ("I am the—
 *  SHAZBOT!"): the splice lives in the audio channel, not the text.
 *
 *  The cut doesn't fire on arrival — it snaps to the live line's
 *  last-word boundary, measured exactly by rendering the head text
 *  through the same voice (sam-js exposes no word timing, so we
 *  synthesize it: buf32(head).length/SAM_RATE). Arrival-time slop and
 *  per-voice speed differences stop mattering: "I am the— SHAZBOT!"
 *  always splices at "the", and a late tail still cuts mid-word like a
 *  mistimed human combo. */
interface LiveVoice { src: AudioBufferSourceNode; carrier: OscillatorNode; startT: number; boundaryS: number }
const liveVoice = new Map<string, LiveVoice>();

/** Seconds at which the splice point lands in `who`'s voice — the last-
 *  word boundary for multi-word lines, a measured mid-word clip for
 *  single-word ones. Cached per speaker+line: canon lines repeat a lot. */
const boundaryCache = new Map<string, number>();
/** Where a single-word line clips for the combo splice — the syllable
 *  SAM can't report. Only canon words that actually combo need entries;
 *  anything else falls back to a mid-string render. */
const SPLICE_HEADS: Record<string, string> = {
  anytime: 'any',       // "Any— SHAZBOT"
  awesome: 'aweso',     // "Aweso— SHAZBOT"
  woohoo: 'woo',        // "Woo— SHAZBOT" / "Woo— I AM THE GREATEST"
  ooops: 'oo',          // "Oo— SHAZBOT"
  shazbot: 'shaz',      // "Shaz— SHAZBOT" machine-gun chain
  quiet: 'qui',         // "Qui— SHAZBOT"
  yes: 'ye',            // "Ye— NO"
  no: 'n',              // "N— YES"
  hi: 'hi',             // "Hi— BYE" / "Hi— SHAZBOT" (cuts at word end)
  bye: 'bye',           // "Bye— HI"
};
function wordBoundary(text: string, who: string | undefined, fullDurS: number): number {
  const words = text.trim().split(/\s+/);
  const cacheKey = `${who ?? ''}|${text}`;
  const hit = boundaryCache.get(cacheKey);
  if (hit !== undefined) {return hit;}
  let boundary = words.length < 2 ? fullDurS * 0.45 : fullDurS * 0.7; // parse-failure fallbacks
  try {
    // One word → splice mid-word too ("Any— SHAZBOT"): canon lines get an
    // explicit head to cut after (the syllable SAM can't report), unknown
    // words fall back to rendering the first half of the string.
    const word = words[0]!;
    const headText = words.length < 2 ? SPLICE_HEADS[word.toLowerCase()] ?? word.slice(0, Math.ceil(word.length / 2))
                                      : words.slice(0, -1).join(' ');
    const head = samFor(who).buf32(headText);
    if (head instanceof Float32Array && head.length > 0) {boundary = head.length / SAM_RATE;}
  } catch { /* keep fallback */ }
  if (boundaryCache.size > 256) {boundaryCache.clear();}
  boundaryCache.set(cacheKey, boundary);
  return boundary;
}

/** Radio-comms chain for the robot voice:
 *    squelch click → src → soft-clip → ring-mod mix → bandpass → slapback → bus
 *  SAM raw is a dry robot; the metallic ring + squelch is what makes it
 *  sound like a battlesuit comm instead of a C64 demo. */
function playRadioVoice(ctx: BaseAudioContext, bus: AudioNode, buf: AudioBuffer, startAt?: number): { src: AudioBufferSourceNode; carrier: OscillatorNode } {
  const t = startAt ?? ctx.currentTime;

  // Soft clip — cheap grit, evens the synth's level swings too.
  const clip = ctx.createWaveShaper();
  if (!_clipCurve) {
    _clipCurve = new Float32Array(new ArrayBuffer(256 * 4));
    for (let i = 0; i < 256; i += 1) { const x = i / 128 - 1; _clipCurve[i] = Math.tanh(x * 2.2); }
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
  return { src, carrier };
}



export function speakVgs(text: string, who?: string): void {
  const bus = audio.uiBus;
  const ctx = bus?.context;
  if (!bus || !ctx) {return;}
  const key = who ?? '';
  const t = ctx.currentTime;
  let startAt = t;
  const live = liveVoice.get(key);
  if (live) {
    // Snap the kill to the live line's last-word boundary — the "perfect
    // splice" is measured, not timed. Past the boundary already = a
    // mistimed combo, which cuts instantly like era spam.
    const delay = Math.min(Math.max(live.startT + live.boundaryS - t, 0), 1.2);
    try { live.src.stop(t + delay); live.carrier.stop(t + delay); } catch { /* already ended */ }
    liveVoice.delete(key);
    startAt = t + delay;
  }
  // oxlint-disable-next-line init-declarations -- set by sam-js
  let pcm!: unknown; // sam-js returns Float32Array | Boolean
  try {
    pcm = samFor(who).buf32(text);
  } catch {
    speakSystem(text); // reciter hiccup → degrade to system voice
    return;
  }
  // buf32 returns false (not throws) on unparseable text — apostrophes,
  // stray symbols — degrade to the system voice rather than silent.
  if (!(pcm instanceof Float32Array) || pcm.length === 0) { speakSystem(text); return; }
  const buf = ctx.createBuffer(1, pcm.length, SAM_RATE);
  buf.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
  const src = playRadioVoice(ctx, bus, buf, startAt);
  liveVoice.set(key, Object.assign({}, src, {startT: startAt,boundaryS: wordBoundary(text, who, buf.duration)}));
  src.src.addEventListener('ended', (): void => { if (liveVoice.get(key)?.src === src.src) {liveVoice.delete(key);} });
}

/** Typed chat read-aloud — deliberately the plain system voice, NOT the
 *  robot, so typed messages and VGS calls sound like different channels.
 *  Pitch jitters per speaker so voices differ by who typed. */
export function speakChat(text: string, who?: string): void {
  let h = 0;
  // oxlint-disable-next-line prefer-math-trunc -- int32 wrap is the point
  if (who) {for (let i = 0; i < who.length; i += 1) {h = (h * 31 + who.charCodeAt(i)) | 0;}}
  speakSystem(text, 0.7 + (Math.abs(h) % 8) * 0.08); // 0.70–1.26
}

/** True when the CHAT TTS option is on — the call sites read through
 *  this so the toggle applies live, no reload. */
export function chatTtsEnabled(): boolean {
  return settings.get('fps-tts-chat');
}

/** Tiny white-noise pip, highpassed — press-to-talk squelch. */
function squelchBuf(ctx: BaseAudioContext): AudioBuffer {
  if (_squelch) {return _squelch;}
  const n = Math.floor(ctx.sampleRate * 0.035);
  const b = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < n; i += 1) {d[i] = (Math.random() * 2 - 1) * (1 - i / n);}
  _squelch = b;
  return b;
}


let _clipCurve: Float32Array<ArrayBuffer> | null = null;
