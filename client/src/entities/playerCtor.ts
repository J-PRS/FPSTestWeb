import * as THREE from 'three';

import type { Terrain } from '../world/terrain.js';
import type { Player } from './Player.js';
import type { SkillsCtx } from './player/skills.js';
import type { PlayerInputHandlers } from './player/input.js';

// Constructor wire-up — the two ctx objects the Player ctor hands
// PlayerSkills/PlayerInput. Pulled out so the ctor reads as field
// declarations, not a page of closures.

export function buildSkillsCtx(p: Player, terrain: Terrain, scene: THREE.Scene): SkillsCtx {
  return {
    pos: p.pos,
    vel: p.vel,
    scene,
    terrain,
    isOnGround: () => p.onGround,
    aimDir: () => p.getAimDir(),
    syncMovement: () => p.syncMovement(),
    markTeleport: () => p.markTeleport(),
    blinkFrame: () => {
      p.movement.setState({ pos: p.pos, vel: p.vel, yaw: p.yaw, pitch: p.pitch, onGround: false });
      p.visuals.updateCamera(p.camera, terrain, p.pos, p.yaw, p.pitch);
      p.visuals.updateShadowBlob(terrain, p.pos);
    },
    emitBlink: (a, b) => p.onBlink?.(a, b),
    emitDash: (a, b) => p.onDash?.(a, b),
    emitWarpThrow: (a, b) => p.onWarpThrow?.(a, b),
    emitWarpTick: (a) => p.onWarpTick?.(a),
    emitWarp: (a, b) => p.onWarp?.(a, b),
    emitSlam: (a, b) => p.onSlam?.(a, b),
    emitBounce: (a, b) => p.onBounce?.(a, b),
    emitCloak: (on) => p.status.setCloaked(on),
    emitShield: (on) => p.status.setShielded(on),
    emitMend: (on) => p.status.setMending(on),
    healSelf: (hp) => { p.health = Math.min(p.maxHealth, p.health + hp); },
    netHeals: () => p.serverOwnsHealth?.() ?? false,
    shieldAbsorb: (dmg) => { p.energy = Math.max(0, p.energy - dmg); if (p.energy <= 0) p.status.setShielded(false); },
    energy: () => p.energy,
    spendEnergy: (n) => { if (p.energy < n) return false; p.energy -= n; return true; },
    drainEnergy: (n) => { p.energy = Math.max(0, p.energy - n); },
  };
}

export function buildInputCtx(p: Player): PlayerInputHandlers {
  return {
    isSpectating: () => p.status.spectating,
    toggleSpectator: () => p.toggleSpectator(),
    melee: () => p.tryMelee(),
    toggleCamera: () => {
      p.thirdPerson = !p.thirdPerson;
      p.model?.setVisible(p.thirdPerson && !p.isDead && !p.status.cloaked);
      // Own bubble exists for spectators/remote eyes only — FP is the
      // gun shell + vignette, so it flips with the camera toggle.
      p.status.syncBubbleVisibility();
    },
    skillPress: () => p.skills.press(p.skill),
    skillRelease: () => p.skills.release(p.skill),
    sidearmWid: () => p.sidearmWid,
    secondaryDown: (wid) => p.armory.secondaryDown(wid),
    secondaryUp: () => p.armory.secondaryUp(),
    deploy: () => { p.model?.weaponThrow(); p.onDeploy?.(); },
    selectSlot: (i) => p.armory.selectSlot(i),
    cycleWeapon: (step) => p.armory.cycleWeapon(step),
    look: (dx, dy) => {
      p.yaw -= dx * 0.002 * p.input.sensitivity;
      p.pitch += dy * 0.002 * p.input.sensitivity * (p.input.invertY ? 1 : -1);
      p.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, p.pitch));
    },
  };
}
