// WAV dump page — renders every sfx through OfflineAudioContext so the
// headless pipeline can inspect/attach real audio. Loads only under
// /sfxdump.html on the dev server; never referenced by the game.
import * as THREE from 'three';
import { audio } from './core/audio.js';
import * as sfx from './core/sfx.js';
import { WeaponType } from '../../shared/weapons.js';
import { isDevHost } from './core/params.js';

if (!isDevHost()) {
  document.body.innerHTML = '<div style="color:#cde;font:14px monospace;padding:2em">dev tool — not available on this build.</div>';
  throw new Error('sfxdump: dev-only surface');
}

function floatToWav(data: Float32Array, sampleRate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + data.length * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) {v.setUint8(o + i, s.charCodeAt(i));} };
  w(0, 'RIFF'); v.setUint32(4, 36 + data.length * 2, true); w(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, data.length * 2, true);
  for (let i = 0; i < data.length; i++) {
    const s = Math.max(-1, Math.min(1, data[i]!));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x80_00 : s * 0x7f_ff, true);
  }
  return buf;
}

async function render(name: string, secs: number, fn: () => void): Promise<string> {
  const sr = 22_050;
  const ctx = new OfflineAudioContext(1, Math.ceil(sr * secs), sr);
  await audio.attachOffline(ctx);
  audio.resetVoices();
  fn();
  const buf = await ctx.startRendering();
  const pcm = buf.getChannelData(0);
  const wav = floatToWav(pcm, sr);
  let bin = '';
  const bytes = new Uint8Array(wav);
  for (let i = 0; i < bytes.length; i++) {bin += String.fromCharCode(bytes[i]!);}
  console.log(`rendered ${name} (${pcm.length} samples)`);
  return btoa(bin);
}

const near = new THREE.Vector3(4, 1, 0);   // in-earshot positional spot
const far = new THREE.Vector3(60, 0, 0);   // distance-attenuated spot

const jobs: Array<[string, number, () => void]> = [
  ['shoot_bolt', 1, () => sfx.shoot(WeaponType.BoltLauncher)],
  ['shoot_disc', 1, () => sfx.shoot(WeaponType.Disc)],
  ['shoot_chaingun', 1, () => sfx.shoot(WeaponType.Chaingun)],
  ['shoot_mortar', 1, () => sfx.shoot(WeaponType.Mortar)],
  ['shoot_gl', 1, () => sfx.shoot(WeaponType.GrenadeLauncher)],
  ['shoot_grenade', 1, () => sfx.shoot(WeaponType.Grenade)],
  ['shoot_flak', 1, () => sfx.shoot(WeaponType.Flak)],
  ['shoot_plasma', 1, () => sfx.shoot(WeaponType.PlasmaCannon)],
  ['shoot_railgun', 1, () => sfx.shoot(WeaponType.Railgun)],
  ['shoot_melee', 1, () => sfx.shoot(WeaponType.Melee)],
  ['jump', 0.8, () => sfx.jump()],
  ['land_soft', 0.8, () => sfx.land(8)],
  ['land_hard', 0.8, () => sfx.land(35)],
  ['dash', 0.8, () => sfx.dash()],
  ['bounce', 0.8, () => sfx.bounce()],
  ['blink', 0.8, () => sfx.blink()],
  ['slam', 1, () => sfx.slam()],
  ['hitmarker_direct', 0.5, () => sfx.hitMarker(true)],
  ['hitmarker_splash', 0.5, () => sfx.hitMarker(false)],
  ['player_hurt', 0.8, () => sfx.playerHurt()],
  ['pickup', 0.8, () => sfx.pickup()],
  ['kill_confirm', 0.8, () => sfx.killConfirm()],
  ['explosion_close_big', 1.5, () => sfx.explosionClose(true)],
  ['explosion_close_small', 1.5, () => sfx.explosionClose(false)],
  ['explosion_near', 1.5, () => sfx.explosionAt(near, true)],
  ['explosion_far', 1.5, () => sfx.explosionAt(far, true)],
  ['boom_mortar', 1.5, () => sfx.explosionAt(near, true, WeaponType.Mortar)],
  ['boom_flak', 1.5, () => sfx.explosionAt(near, true, WeaponType.Flak)],
  ['boom_plasma', 1.5, () => sfx.explosionAt(near, true, WeaponType.PlasmaCannon)],
  ['boom_railgun', 1.5, () => sfx.explosionAt(near, true, WeaponType.Railgun)],
  ['cue_pounce', 0.8, () => sfx.enemyCue(near, 'pounce')],
  ['cue_dart', 0.8, () => sfx.enemyCue(near, 'dart')],
  ['cue_zap', 0.8, () => sfx.enemyCue(near, 'zap')],
  ['cue_launch', 0.8, () => sfx.enemyCue(near, 'launch')],
  ['cue_die', 0.8, () => sfx.enemyCue(near, 'die')],
  ['cue_die_far', 0.8, () => sfx.enemyCue(far, 'die')],
  // Disc launch candidates — [name, gain, rate, lowpassHz, cutAfterSec]
  ['disc_e_twang', 1, () => sfx.debugMix([
    ['shot_cannon', 0.9, 0.6, 800, 0.4], ['hg_clang', 0.5, 1.5, undefined, 0.15], ['punch', 0.4, 1.2, undefined, 0.2]])],
  // Bass-forward variants: let the body breathe longer
  ['disc_h_bass', 1, () => sfx.debugMix([
    ['thud_big', 1, 0.65, 500], ['shot_cannon', 0.8, 0.6, 900, 0.5], ['hg_clang', 0.45, 1.6, undefined, 0.15]])],
  ['disc_i_hew', 1, () => sfx.debugMix([
    ['shot_cannon', 1, 0.5, 600, 0.6], ['thud_big', 0.9, 0.8], ['punch', 0.5, 1.1, 2000, 0.2], ['hg_clang', 0.35, 1.8, undefined, 0.12]])],
  ['disc_j_lurch', 1, () => sfx.debugMix([
    ['thud_big', 1, 0.5, 400], ['shot_cannon', 0.8, 0.7, 1000, 0.45], ['sparks', 0.3, 1.4, undefined, 0.15]])],
  ['disc_d_current', 1, () => sfx.debugMix([
    ['shot_cannon', 0.8, 0.55], ['cryst_bang', 0.65, 0.9], ['punch', 0.5, 1.2], ['whistle', 0.3]])],
  // Loops at full intensity — same shapes gameLoop drives live
  ['loop_jet', 1, () => audio.noiseLoop('lowpass', 700)?.set(0.5)],
  ['loop_ski', 1, () => audio.noiseLoop('bandpass', 1400)?.set(0.35)],
  ['loop_wind', 1, () => audio.noiseLoop('lowpass', 900)?.set(0.5)],
];

window.dump = (async () => {
  const out: Record<string, string> = {};
  for (const [name, secs, fn] of jobs) {out[name] = await render(name, secs, fn);}
  return out;
})();
