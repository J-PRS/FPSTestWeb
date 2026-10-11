/**
 * Lab bot-agent machinery — a REAL BotBrain mind riding a REAL MoveSim
 * body, shared by every scenario that pits thinking bots against each
 * other (botDuel matchups, flagScrim). Locomotion slews yaw toward the
 * brain's dest and feeds jump/ski/jet through the same input contract a
 * player fills; energy is an honest tank so the brain's skill reads mean
 * something. Extracted from scenarios.ts when flagScrim needed the same
 * rig — keep the duel and the scrim on one mind-body stack.
 */
import * as THREE from 'three';
import { hmHeight } from '../../../shared/heightfield.js';
import { MoveSim, type MoveSurface } from '../../../shared/movement.js';
import { BotBrain, type BotVec } from '../../../shared/botBrain.js';
import { getWeaponStats } from '../../../shared/weapons.js';
import { pickBotWeapon, type BotLoadout } from '../../../shared/botLoadouts.js';
import { LAB_FLAT_FIELD } from './simKit.js';

export const BOT_SURFACE: MoveSurface = {
  getHeight: (x, z): number => hmHeight(LAB_FLAT_FIELD, x, z),
  getNormal: (_x, _z, out) => { out.x = 0; out.y = 1; out.z = 0; return out; },
};
export const BOT_HP = 100;
export const BOT_ENERGY_MAX = 100;

/** Client's locomote() slew — turn toward dest at a wrist-speed rate. */
function slewYaw(cur: number, want: number, k: number): number {
  let d = want - cur;
  while (d > Math.PI) { d -= Math.PI * 2; }
  while (d < -Math.PI) { d += Math.PI * 2; }
  const m = Math.abs(d);
  return cur + (m < k ? d : Math.sign(d) * k);
}

export interface BotAgent {
  brain: BotBrain;
  sim: MoveSim;
  mesh: THREE.Mesh;
  hp: number;
  energy: number;
  yaw: number;
  lastDest: BotVec | null;
  lastMove: { ski?: boolean; jet?: boolean; jump?: boolean } | undefined;
  name: string;
  dead: number; // respawn countdown
  lo: BotLoadout;
}

export function spawnAgent(scene: THREE.Scene, name: string, color: number, x: number, lo: BotLoadout): BotAgent {
  const pos = { x, y: 2, z: 0 };
  const mesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.9, 1.4, 4, 12),
    new THREE.MeshBasicMaterial({ color }),
  );
  scene.add(mesh);
  return {
    brain: new BotBrain({ x: pos.x, y: pos.y, z: pos.z }),
    sim: new MoveSim(BOT_SURFACE, {
      pos: { x: pos.x, y: pos.y, z: pos.z }, vel: { x: 0, y: 0, z: 0 },
      yaw: 0, pitch: 0, onGround: false,
    }),
    mesh, hp: BOT_HP, energy: BOT_ENERGY_MAX, yaw: 0,
    lastDest: null, lastMove: undefined, name, dead: 0, lo,
  };
}

export function respawnAgent(a: BotAgent, x: number): void {
  a.sim.setState({
    pos: { x, y: 2, z: 0 }, vel: { x: 0, y: 0, z: 0 },
    yaw: a.yaw, pitch: 0, onGround: false,
  });
  a.mesh.visible = true;
}

export function locomoteAgent(a: BotAgent, dt: number): void {
  if (!a.lastDest) { return; }
  const s = a.sim.state;
  const md = Math.hypot(a.lastDest.x - s.pos.x, a.lastDest.z - s.pos.z);
  if (md > 0.01) {
    a.yaw = slewYaw(a.yaw, Math.atan2(a.lastDest.x - s.pos.x, a.lastDest.z - s.pos.z), 5 * dt);
    s.yaw = a.yaw;
  }
  const jet = Boolean(a.lastMove?.jet) && a.energy > 0.5;
  a.sim.setInput({
    forward: md > 0.5 ? 1 : 0,
    right: 0,
    jumpHeld: Boolean(a.lastMove?.jump),
    skiHeld: Boolean(a.lastMove?.ski),
    jetHeld: jet,
  });
  a.sim.update(dt);
  // Honest tank: jets burn, regen fills — the brain's skills read this.
  a.energy = Math.min(BOT_ENERGY_MAX, Math.max(0, a.energy + (jet ? -30 : 20) * dt));
}

export const botSpeed = (a: BotAgent): string => Math.hypot(a.sim.state.vel.x, a.sim.state.vel.y, a.sim.state.vel.z).toFixed(1);

/** Weapon the brain would bring to this range — same pick the game host
 *  runs at botBrain.ts think(). Speed 0 (hitscan) means no shell. */
export function pickAtRange(a: BotAgent, d: number): { wt: number; st: ReturnType<typeof getWeaponStats> } {
  const wt = pickBotWeapon(a.lo, d, d);
  return { wt, st: getWeaponStats(wt) };
}
