/**
 * URL params — parsed once. Every `new URLSearchParams(location.search)`
 * call site used to re-parse the same string; this is the single source.
 *
 * The URL is for CONNECTION + headless hooks (server address, p2p code,
 * ?export/?bakedbg/?pixelated screenshot overrides). Gameplay-facing
 * choices — mode, spawn rules, debug — live in the menu settings now:
 * the `urlParams` getters below read the persisted setting so existing
 * call sites don't care where the value came from.
 */

import { settings } from './settings.js';

const qp = new URLSearchParams(window.location.search);

export const urlParams = {
  get: (k: string) => qp.get(k),
  has: (k: string) => qp.has(k),
  /** Game mode — a menu setting ('' | nuggets | ctf | dm | classic). */
  mode: settings.get('fps-mode') || null,
  /** classic = solo bounce-and-shoot: balls only, no rage, no roster */
  isClassic: settings.get('fps-mode') === 'classic',
  /** All-random creature spawns — no scripted beats, everything rolls from t=0 */
  randomSpawns: settings.get('fps-spawns') === 1,
  /** Dev overlays / verbose combat logging — menu toggle OR ?debug (the
   *  param stays as a headless-capture override). */
  debug: qp.has('debug') || settings.get('fps-debug') === 1,
  /** ?p2p=host:CODE|join:CODE — WebRTC duel via /rtc handshake relay */
  p2p: qp.get('p2p'),
  /** ?room=NAME — match room on the server (default: 'default'). Lets two
   *  matches coexist on one server; share the URL to share the room. */
  room: qp.get('room'),
};
