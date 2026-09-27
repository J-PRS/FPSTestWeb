import { InputFlags, JetpackFlags } from './types.js';
import type { IPlayerDataProvider, IInputProvider } from './interfaces.js';
import type { Player } from '../entities/Player.js';

/** Live getters feeding the demo recorder — main.ts just calls this once. */
export function playerProviders(player: Player): { playerData: IPlayerDataProvider; inputData: IInputProvider } {
  return {
    playerData: {
      get posX() { return player.pos.x; },
      get posY() { return player.pos.y; },
      get posZ() { return player.pos.z; },
      get velX() { return player.vel.x; },
      get velY() { return player.vel.y; },
      get velZ() { return player.vel.z; },
      get yaw() { return player.yaw; },
      get pitch() { return player.pitch; },
    },
    inputData: {
      get inputFlags() {
        const input = player.getInputState();
        let flags = 0;
        if (input.forward > 0) flags |= InputFlags.Forward;
        if (input.forward < 0) flags |= InputFlags.Backward;
        if (input.right < 0) flags |= InputFlags.Left;
        if (input.right > 0) flags |= InputFlags.Right;
        if (input.jumpHeld) flags |= InputFlags.Jump;
        if (input.skiHeld) flags |= InputFlags.Ski;
        if (input.firePressed) flags |= InputFlags.Fire;
        if (input.discHeld) flags |= InputFlags.Disc;
        return flags;
      },
      get mouseDeltaX() { return 0; },
      get mouseDeltaY() { return 0; },
      get jetpackFlags() {
        return player.getInputState().jetHeld ? JetpackFlags.Active : JetpackFlags.None;
      },
      get jetpackFuel() { return player.energy; },
    },
  };
}
