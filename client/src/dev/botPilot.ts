import * as THREE from 'three';
import { BotBrain } from '../../../shared/botBrain.js';
import { STATUS } from '../../../shared/status.js';
import { CLASS_STATS } from '../../../shared/botClasses.js';
import { codeFor } from '../core/keybinds.js';
import type { Player } from '../entities/Player.js';
import type { NetworkManager } from '../networking/NetworkManager.js';
import type { WorldState } from '../game/worldState.js';
import type { Terrain } from '../world/terrain.js';
export interface PilotDeps {
  player: Player;
  networkManager: NetworkManager;
  world: WorldState;
  terrain: Terrain;
  /** The entity registry — nuggets carry the loose-token positions. */
  entities: { nuggets: { pos: THREE.Vector3 }[] };
}

// Soak driver: the shared BotBrain steers the LOCAL player through the
// real input fields (keys/jet/mouse/yaw) — prediction, wire inputs, and
// fire paths are identical to a human holding those buttons. Lives behind
// ?autopilot — never constructed in a normal session.

const TICK_MS = 50;      // think+slew cadence — GameBot thinks ~10Hz, 50ms keeps it lively
const SLEW = 5;          // rad/s — the same wrist speed GameBot.locomote uses

function slew(cur: number, want: number, maxDelta: number): number {
  let d = want - cur;
  if (d > Math.PI) {d -= Math.PI * 2;}
  if (d < -Math.PI) {d += Math.PI * 2;}
  return cur + Math.max(-maxDelta, Math.min(maxDelta, d));
}

export function startBotPilot(deps: PilotDeps): () => void {
  const { player, networkManager: nm, world, terrain } = deps;
  const brain = new BotBrain({ x: player.pos.x, y: player.pos.y, z: player.pos.z });
  const fwdKey = codeFor('forward');
  const skiKey = codeFor('ski');
  const aimPoint = new THREE.Vector3();
  let aimFreshUntil = 0;
  let thinkAcc = 0;
  let dest: { x: number; y: number; z: number } | null = null;
  let move: { ski?: boolean; jet?: boolean; jump?: boolean; park?: boolean } | undefined;
  let firing = false;
  let releaseUntil = 0; // semi-auto pulse — needsRelease demands a mouse-up gap
  let cycleNextAt = performance.now() + 8000 + Math.random() * 6000;

  const think = (): void => {
    const p = player;
    // Enemies from the wire roster — same truth the senses render.
    const enemies: { id: string; pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number }; alive: boolean; aimY: number; hpFrac: number }[] = [];
    for (const [id, rec] of nm.getPlayers()) {
      if (world.localTeam && rec.team && rec.team === world.localTeam) {continue;}
      enemies.push({ id, pos: rec.position, vel: rec.velocity, alive: !rec.isDead, aimY: -0.7, hpFrac: (rec.health ?? 100) / 200 });
    }
    // Nearest loose token as the pickup read — headhunt brains chase it.
    let pickup: { x: number; y: number; z: number } | null = null;
    let bestD = Infinity;
    for (const nug of deps.entities.nuggets) {
      const d = Math.hypot(nug.pos.x - p.pos.x, nug.pos.z - p.pos.z);
      if (d < bestD) {bestD = d; pickup = { x: nug.pos.x, y: nug.pos.y, z: nug.pos.z };}
    }
    const out = brain.think(0.1, {
      id: nm.getLocalPlayerId(),
      pos: p.pos,
      vel: p.vel,
      enemies,
      pickup,
      groundY: (x, z): number => terrain.getHeight(x, z),
      now: performance.now(),
      energy: p.energy,
      healthFrac: p.health / p.maxHealth,
      held: p.heldTokens,
      team: world.localTeam || undefined,
    });
    ({ dest, move } = out);
    firing = Boolean(out.fire);
    // Wander the slots like a human scroll — the brain always fires the
    // selection, so slow cycling spreads shots across the simmed weapon
    // table instead of hammering the spawn sidearm all soak.
    if (!firing && performance.now() >= cycleNextAt) {
      cycleNextAt = performance.now() + 8000 + Math.random() * 6000;
      p.armory.cycleWeapon(1);
    }
    if (out.fire) {
      aimPoint.set(out.fire.aim.x, out.fire.aim.y, out.fire.aim.z);
      aimFreshUntil = performance.now() + 1500;
    }
    // Toggle-skill bits the brain claims — same STATUS mask a human's
    // inputMove carries; the player's own tank gates what sticks.
    if (out.status !== undefined) {
      p.status.setCloaked(Boolean(out.status & STATUS.CLOAK));
      p.status.setShielded(Boolean(out.status & STATUS.SHIELD));
      p.status.setMending(Boolean(out.status & STATUS.MEND));
    }
  };

  const drive = (dt: number): void => {
    const p = player;
    // Steer: wrist-speed yaw toward the brain's destination, forward when
    // it's past arm's reach. Same policy as GameBot.locomote.
    if (dest) {
      const mdx = dest.x - p.pos.x, mdz = dest.z - p.pos.z;
      const md = Math.hypot(mdx, mdz);
      if (md > 0.01) {p.yaw = slew(p.yaw, Math.atan2(mdx, mdz), SLEW * dt);}
      p.input.keys[fwdKey] = md > 0.5 && !move?.park;
    }
    p.input.keys[skiKey] = Boolean(move?.ski);
    p.input.jumpHeld = Boolean(move?.jump);
    p.input.jetPending = Boolean(move?.jet) && p.energy > 0;

    // Aim: track the last fire point a beat after the trigger releases.
    if (performance.now() < aimFreshUntil) {
      const eyeY = p.pos.y + CLASS_STATS[p.appliedClass].eyeHeight;
      const ax = aimPoint.x - p.pos.x, ay = aimPoint.y - eyeY, az = aimPoint.z - p.pos.z;
      p.yaw = slew(p.yaw, Math.atan2(ax, az), SLEW * dt);
      p.pitch = slew(p.pitch, Math.atan2(ay, Math.hypot(ax, az)), SLEW * dt);
    }
    // Trigger: autos ride mouseHeld; semi-autos need a release edge or
    // needsRelease pins the second shot — pulse a short up-gap.
    if (firing && performance.now() >= releaseUntil) {
      p.input.mouseHeld = true;
      p.input.firePending = true;
      releaseUntil = performance.now() + 140 + Math.random() * 120;
    }
    if (!firing || p.input.needsRelease) {p.input.mouseHeld = false;}
    if (!firing) {p.input.needsRelease = false;}
  };

  const iv = setInterval((): void => {
    const dt = TICK_MS / 1000;
    const p = player;
    // Human override: pointer lock means a real person took the seat —
    // the InputHandler owns every field we write, so hands entirely off.
    // Unlock hands the keys back and the brain picks up where it left.
    if (document.pointerLockElement) {return;}
    // Dead: hands off — the server respawn timer owns the return.
    if (p.isDead || !nm.isConnected()) {
      p.input.keys[fwdKey] = false; p.input.keys[skiKey] = false;
      p.input.jumpHeld = false; p.input.jetPending = false; p.input.mouseHeld = false;
      return;
    }

    thinkAcc += dt;
    if (thinkAcc >= 0.1) {
      thinkAcc = 0;
      think();
    }
    drive(dt);
  }, TICK_MS);

  return (): void => {
    clearInterval(iv);
    player.input.keys[fwdKey] = false;
    player.input.keys[skiKey] = false;
    player.input.jumpHeld = false;
    player.input.jetPending = false;
    player.input.mouseHeld = false;
  };
}
