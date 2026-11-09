import { SHOOT_REVEAL_S } from '../../../shared/status.js';
import type { RemotePlayer } from './RemotePlayer.js';

// Visibility gate - who can currently see this remote. Two independent
// hides: staleness (socket stopped updating; backgrounded tabs keep the
// socket but stop simulating, auto-reshow on resume) and the
// server-authoritative cloak (separate flag: a decloak restores
// visibility even while a stale socket stays hidden). Plus the
// fire-shimmer ghost: shooting from stealth briefly reveals the model.

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

export function setStaleVis(p: RemotePlayer, hidden: boolean): void {
  if (hidden === p.staleHidden) {return;}
  p.staleHidden = hidden;
  if (hidden) {hideRemote(p);} else if (!p.cloakHidden) {showRemote(p);}
}

export function setCloakVis(p: RemotePlayer, hidden: boolean): void {
  if (hidden === p.cloakHidden) {return;}
  p.cloakHidden = hidden;
  if (hidden) {
    // Recloaking mid-reveal doesn't wash the shot — the shimmer (and
    // HUD marker, via ghostT) owes the window its remainder.
    if (p.revealT > 0 && p._loaded) { p.ghostT = p.revealT; p._model.setGhost(true); p.model.setVisible(true); return; }
    hideRemote(p);
  } else if (!p.staleHidden) {showRemote(p);}
}

// Friendly cloak: a teammate's held cloak renders as the ghost shimmer,
// not an empty space — only enemies are fully invisible. The flag just
// swaps the model's materials, so stale/frustum/dead gates keep owning
// real visibility and a decloak restores the skin untouched.
export function setCloakGhost(p: RemotePlayer, on: boolean): void {
  if (on === p.cloakGhost) {return;}
  p.cloakGhost = on;
  p._model.setGhost(on);
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
  else if (!p.staleHidden && !p.cloakHidden && !p.isDead) { p.model.setSceneDetached(false); p.model.setVisible(true); p.auras.show(); }
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
  p._model.setGhost(false);
  if (p.cloakHidden || p.staleHidden || p.isDead) {p.model.setVisible(false);}
}
