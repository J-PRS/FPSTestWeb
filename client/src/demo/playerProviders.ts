import { InputFlags, JetpackFlags } from './types.js';
import type { IPlayerDataProvider, IInputProvider } from './interfaces.js';
import type { Player } from '../entities/Player.js';
import { weaponDef } from '../weapons.js';

/** Live getters feeding the demo recorder — main.ts just calls this once. */
export function playerProviders(player: Player): { playerData: IPlayerDataProvider; inputData: IInputProvider } {
  return {
    playerData: {
      get posX(): number { return player.pos.x; },
      get posY(): number { return player.pos.y; },
      get posZ(): number { return player.pos.z; },
      get velX(): number { return player.vel.x; },
      get velY(): number { return player.vel.y; },
      get velZ(): number { return player.vel.z; },
      get yaw(): number { return player.yaw; },
      get pitch(): number { return player.pitch; },
      get weaponType() { return weaponDef(player.currentWeapon).weaponType; },
      get health() { return Math.max(0, Math.round(player.health)); },
      get armor() { return Math.max(0, Math.round(player.armor)); },
    },
    inputData: {
      get inputFlags(): number {
        const input = player.getInputState();
        let flags = 0;
        if (input.forward > 0) {flags |= InputFlags.Forward;}
        if (input.forward < 0) {flags |= InputFlags.Backward;}
        if (input.right < 0) {flags |= InputFlags.Left;}
        if (input.right > 0) {flags |= InputFlags.Right;}
        if (input.jumpHeld) {flags |= InputFlags.Jump;}
        if (input.skiHeld) {flags |= InputFlags.Ski;}
        if (input.firePressed) {flags |= InputFlags.Fire;}
        if (input.beltHeld) {flags |= InputFlags.Disc;} // flag name kept for demo-format compat
        return flags;
      },
      get mouseDeltaX(): number { return 0; },
      get mouseDeltaY(): number { return 0; },
      get jetpackFlags(): number {
        return player.getInputState().jetHeld ? JetpackFlags.Active : JetpackFlags.None;
      },
      get jetpackFuel(): number { return player.energy; },
    },
  };
}
