import type * as THREE from 'three';
import type { Terrain } from '../world/terrain.js';
import { sweepPlayer, sweepTerrain } from './sweep.js';
import type { Projectile } from './Projectile.js';

  // Planted shell: hold full size for the embed window, then shrink away.
  // Remote replica terrain handling. A replica never CLAIMS a target hit
  // (server owns damage — explode() runs the visual-only path) but it
  // still pops on body contact: a shell tunneling a rendered chest and
  // detonating at the ~1-ping-late destroy edge reads as a pass-through.
  // Terrain is deterministic from spawn state: bounces match the
  // shooter's arc, armed shells die on contact, remote stickies glue on
  // the shared fuse clock. Returns true when the shell exploded this
  // frame.
export function tickRemote(h: Projectile, terrain: Terrain, remotePlayers?: Map<string, THREE.Vector3>, playerClasses?: Map<string, string>): boolean {
    // A discharged beam still respects terrain — the sweep sets hitPoint
    // so update() pops the slug at contact, not at the range cap.
    if (h.rayFired) {sweepTerrain(h, terrain);}
    if (h.canBounce && sweepTerrain(h, terrain) && !h.collide.bounceOffTerrain(terrain)) {
      h.popClass = 'bounce';
      h.explode(); // bounce budget/graze exhausted — die like a local shard
      return true;
    }
    if (!h.canBounce && h.config.armTime !== undefined && sweepTerrain(h, terrain)) {
      h.popClass = 'armed';
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
      h.popClass = 'terrain';
      h.explode();
      return true;
    }
    if (h.config.sticks && sweepTerrain(h, terrain)) {h.glue.stickAt(h.hitPoint);}
    // Embed-capable shells (javelin) die on contact everywhere — the server
    // never sends a destroy for a dirt hit, so the replica must sense it.
    if (h.config.embeds !== undefined && sweepTerrain(h, terrain)) {
      h.popClass = 'embed';
      h.explode();
      return true;
    }
    // Cosmetic body pop — same gates as the live shell's own sweep
    // (unarmed fuse-bombs + MRV carriers phase through bodies by design;
    // stickies wait for the wire glue edge). The explode() is visual-only:
    // no aoeShot, no claims — damage stays a server edge like before.
    if (h.bodiesLive && !h.config.passThroughTargets && !h.config.sticks) {
      const lp = h.sweepLocal?.();
      if (lp && h.shooterId !== 'local' && sweepPlayer(h, lp, 'local', h.localClass?.())) {
        h.popClass = 'body-local';
        h.explode();
        return true;
      }
      if (remotePlayers) {
        for (const [playerId, playerPos] of remotePlayers) {
          if (playerId === h.shooterId) {continue;}
          if (sweepPlayer(h, playerPos, playerId, playerClasses?.get(playerId))) {
            h.popClass = 'body-remote';
            h.explode();
            return true;
          }
        }
      }
    }
    return false;
  }

