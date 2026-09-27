/**
 * URL params — parsed once. Every `new URLSearchParams(location.search)`
 * call site used to re-parse the same string; this is the single source.
 */

const qp = new URLSearchParams(window.location.search);

export const urlParams = {
  get: (k: string) => qp.get(k),
  has: (k: string) => qp.has(k),
  /** ?mode=nuggets|ctf|dm|classic — game mode selector */
  mode: qp.get('mode'),
  /** classic = solo bounce-and-shoot: balls only, no rage, no roster */
  isClassic: qp.get('mode') === 'classic',
  /** ?spawns=random — no scripted beats, everything rolls from t=0 */
  randomSpawns: qp.get('spawns') === 'random',
  /** ?debug — dev overlays / verbose combat logging */
  debug: qp.has('debug'),
  /** ?p2p=host:CODE|join:CODE — WebRTC duel via /rtc handshake relay */
  p2p: qp.get('p2p'),
};
