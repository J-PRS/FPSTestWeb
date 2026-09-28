// Shared context the per-domain wire modules receive. One object — adding a
// handler domain is a new file taking NetCtx, never a new param trail.

import type { NetDeps } from '../netHandlers.js';
import type { Chat } from '../chat.js';
import type { NetworkManager } from '../../networking/NetworkManager.js';
import type { RemotePlayer } from '../../entities/RemotePlayer.js';

export interface NetCtx {
  deps: NetDeps;
  nm(): NetworkManager;
  networkManager: NetworkManager;
  chat: Chat;
  /** Both first-seen-update and respawn-into-missing end up here. */
  ensureRemotePlayer(playerId: string, position: { x: number; y: number; z: number }, via: string): RemotePlayer;
  /** Server-owned pickup meshes — gem/dog-tag renderers. */
  addPickup(id: number, pos: { x: number; y: number; z: number }, kind?: import('../../../../shared/pickups.js').PickupKind): void;
}
