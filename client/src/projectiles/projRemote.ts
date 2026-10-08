import type { Terrain } from '../world/terrain.js';
import { sweepTerrain } from './sweep.js';
import type { Projectile } from './Projectile.js';

  // Planted shell: hold full size for the embed window, then shrink away.
  // Remote replica terrain handling. A replica never sweep-hits a target
  // (server owns damage) but terrain is deterministic from spawn state:
  // bounces match the shooter's arc, armed shells die on contact, remote
  // stickies glue on the shared fuse clock. Returns true when the shell
  // exploded this frame.
export function tickRemote(h: Projectile, terrain: Terrain): boolean {
    // A discharged beam still respects terrain — the sweep sets hitPoint
    // so update() pops the slug at contact, not at the range cap.
    if (h.rayFired) {sweepTerrain(h, terrain);}
    if (h.canBounce && sweepTerrain(h, terrain) && !h.collide.bounceOffTerrain(terrain)) {
      h.explode(); // bounce budget/graze exhausted — die like a local shard
      return true;
    }
    if (!h.canBounce && h.config.armTime !== undefined && sweepTerrain(h, terrain)) {
      h.explode(); // armed mortar shell touching terrain on a remote client
      return true;
    }
    // Contact-fused shells (plasma/bolt/disc — no armTime, no bounce, no
    // stick, no embed) die on terrain on remote clients too: the server's
    // destroy edge is a loss-prone hint, and without this sweep a lost
    // edge leaves the replica streaking 800m+ through the ground until
    // ABSOLUTE_TTL_S pops it.
    if (!h.canBounce && !h.config.sticks && h.config.armTime === undefined
        && h.config.embeds === undefined && sweepTerrain(h, terrain)) {
      h.explode();
      return true;
    }
    if (h.config.sticks && sweepTerrain(h, terrain)) {h.glue.stickAt(h.hitPoint);}
    // Embed-capable shells (javelin) die on contact everywhere — the server
    // never sends a destroy for a dirt hit, so the replica must sense it.
    if (h.config.embeds !== undefined && sweepTerrain(h, terrain)) {
      h.explode();
      return true;
    }
    return false;
  }

