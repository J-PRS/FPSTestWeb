import type * as THREE from 'three';

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
    isOnGround: (): boolean => p.onGround,
    aimDir: (): THREE.Vector3 => p.getAimDir(),
    syncMovement: (): void => p.syncMovement(),
    markTeleport: (): void => p.markTeleport(),
    blinkFrame: (): void => {
      p.movement.setState({ pos: p.pos, vel: p.vel, yaw: p.yaw, pitch: p.pitch, onGround: false });
      p.visuals.updateCamera(p.camera, terrain, { pos: p.pos, yaw: p.yaw, pitch: p.pitch });
      p.visuals.updateShadowBlob(terrain, p.pos);
    },
    emitBlink: (a, b): void | undefined => p.onBlink?.(a, b),
    emitDash: (a, b): void | undefined => p.onDash?.(a, b),
    emitWarpThrow: (a, b): void | undefined => p.onWarpThrow?.(a, b),
    emitWarpTick: (a): void | undefined => p.onWarpTick?.(a),
    emitWarp: (a, b): void | undefined => p.onWarp?.(a, b),
    emitSlam: (a, b): void | undefined => p.onSlam?.(a, b),
    emitBounce: (a, b): void | undefined => p.onBounce?.(a, b),
    emitCloak: (on): void => p.status.setCloaked(on),
    emitShield: (on): void => p.status.setShielded(on),
    emitMend: (on): void => p.status.setMending(on),
    healSelf: (hp): void => { p.health = Math.min(p.maxHealth, p.health + hp); },
    netHeals: (): boolean => p.serverOwnsHealth?.() ?? false,
    shieldAbsorb: (dmg): void => { p.energy = Math.max(0, p.energy - dmg); if (p.energy <= 0) {p.status.setShielded(false);} },
    energy: (): number => p.energy,
    spendEnergy: (n): boolean => { if (p.energy < n) {return false;} p.energy -= n; return true; },
    skillUsed: (): void | undefined => p.onSkillUse?.(),
    drainEnergy: (n): void => { p.energy = Math.max(0, p.energy - n); },
  };
}

export function buildInputCtx(p: Player): PlayerInputHandlers {
  return {
    isSpectating: (): boolean => p.status.spectating,
    isDead: (): boolean => p.isDead,
    isDeadSpectating: (): boolean => p.deadSpectateIdx >= 0 || (p.spectateAnchor !== undefined && performance.now() < p.spectateAnchorUntil),
    deadSpectateCycle: (dir): void => p.deadSpectateCycle(dir),
    toggleSpectator: (): void => p.toggleSpectator(),
    melee: (): void => p.tryMelee(),
    toggleCamera: (): void => {
      p.thirdPerson = !p.thirdPerson;
      p.model?.setVisible(p.thirdPerson && !p.isDead);
      // Own bubble exists for spectators/remote eyes only — FP is the
      // gun shell + vignette, so it flips with the camera toggle.
      p.status.syncBubbleVisibility();
    },
    skillPress: (): void => p.skills.press(p.skill),
    skillRelease: (): void => p.skills.release(p.skill),
    sidearmWid: (): number => p.sidearmWid,
    secondaryDown: (wid): void => p.armory.secondaryDown(wid),
    secondaryUp: (): void => p.armory.secondaryUp(),
    deploy: (): void => { p.model?.weaponThrow(); p.onDeploy?.(); },
    respawn: (): void | undefined => p.onRespawn?.(),
    dieSpectate: (): void => p.dieSpectate(),
    throwFlag: (): void | undefined => p.onThrowFlag?.(),
    selectSlot: (i): void => p.armory.selectSlot(i),
    cycleWeapon: (step): void => p.armory.cycleWeapon(step),
    look: (dx, dy): void => {
      p.yaw -= dx * 0.002 * p.input.sensitivity;
      p.pitch += dy * 0.002 * p.input.sensitivity * (p.input.invertY ? 1 : -1);
      p.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, p.pitch));
    },
    orbitLook: (dx, dy): void => {
      p.orbit.yaw -= dx * 0.002 * p.input.sensitivity;
      p.orbit.pitch += dy * 0.002 * p.input.sensitivity * (p.input.invertY ? 1 : -1);
      p.orbit.pitch = Math.max(-1.4, Math.min(1.4, p.orbit.pitch));
    },
  };
}
