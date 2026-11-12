import { SHOOT_REVEAL_S } from '../../../shared/status.js';
import type { RemotePlayer } from './RemotePlayer.js';

// Visibility gate - who can currently see this remote. Staleness is a
// server-declared GHOST (the feed went quiet; body stays rendered and
// hittable — a hidden live body was an invisible target, the worst
// outcome). The server-authoritative cloak is the only real hide here.
// Plus the fire-shimmer ghost: shooting from stealth briefly reveals.

export function hideRemote(p: RemotePlayer): void {
  p.model.setVisible(false);
  p.gizmo?.hide();
  p.auras.hide();
}

export function showRemote(p: RemotePlayer): void {
  // Dead bodies never come back through the vis paths — a stale-socket
  // resume, decloak, or frustum re-add firing after the kill funnel's
  // hide is how a corpse stays posed standing for the whole dead
  // window. Respawn clears isDead before it shows, so this can't eat
  // a legal restore.
  if (p.isDead) {return;}
  p.model.setVisible(true);
  // Only add collider if model is loaded (colliderGizmo exists)
  if (p.loaded) {p.model.addColliderGizmo();}
  p.gizmo?.attach();
  p.auras.show();
}

// Server-declared stale feed (playerStale edge): ghost shimmer, never a
// hide — the body keeps dead-reckoning and stays a valid target until the
// server's own reap/despawn removes it.
export function setStaleVis(p: RemotePlayer, stale: boolean): void {
  if (stale === p.staleHidden) {return;}
  p.staleHidden = stale;
  p._model.setGhost(stale || p.cloakGhost);
}

export function setCloakVis(p: RemotePlayer, hidden: boolean): void {
  if (hidden === p.cloakHidden) {return;}
  p.cloakHidden = hidden;
  if (hidden) {
    // Recloaking mid-reveal doesn't wash the shot — the shimmer (and
    // HUD marker, via ghostT) owes the window its remainder.
    if (p.revealT > 0 && p._loaded) { p.ghostT = p.revealT; p._model.setGhost(true); p.model.setVisible(true); return; }
    hideRemote(p);
  } else {showRemote(p);}
}

// Friendly cloak: a teammate's held cloak renders as the ghost shimmer,
// not an empty space — only enemies are fully invisible. The flag just
// swaps the model's materials, so stale/frustum/dead gates keep owning
// real visibility and a decloak restores the skin untouched.
export function setCloakGhost(p: RemotePlayer, on: boolean): void {
  if (on === p.cloakGhost) {return;}
  p.cloakGhost = on;
  p._model.setGhost(on || p.staleHidden); // stale shimmer outlives the cloak flag
}

// Frustum hide: an offscreen rig is detached outright — visible=false
// still gets walked by updateMatrixWorld/projectObject (~300 nodes, most
// of them bones). The anim gate already skips its mixer; stale/cloak
// hides only need visible=false because their costs don't include the
// traversal they never had. Re-add re-syncs matrices on the next pass.
export function setFrustumVis(p: RemotePlayer, hidden: boolean): void {
  if (hidden === p.frustumHidden) {return;}
  p.frustumHidden = hidden;
  if (hidden) { p.model.setSceneDetached(true); p.auras.hide(); }
  // isDead gate like showRemote: a corpse frustum-re-add must not
  // resurrect the body the kill funnel hid - the standing-dead bug.
  else if (!p.cloakHidden && !p.isDead) { p.model.setSceneDetached(false); p.model.setVisible(true); p.auras.show(); }
  else {p.model.setSceneDetached(false);}
}

// Firing decloaks: the window anchors to the shot itself, so a cloak
// raised (or already up) owes the same 2s of ghost-shimmer visibility.
export function shootReveal(p: RemotePlayer): void {
  p.revealT = SHOOT_REVEAL_S;
  if (p.cloakHidden && p._loaded) {
    p.ghostT = p.revealT;
    p._model.setGhost(true);
    p.model.setVisible(true);
  }
}

export function tickGhostF(p: RemotePlayer, dt: number): void {
  if (p.revealT > 0) {p.revealT -= dt;}
  if (p.ghostT <= 0) {return;}
  p.ghostT -= dt;
  if (p.ghostT > 0) {return;}
  p._model.setGhost(p.staleHidden || p.cloakGhost); // reveal expiring doesn't wash the stale/cloak shimmer
  if (p.cloakHidden || p.isDead) {p.model.setVisible(false);}
}
