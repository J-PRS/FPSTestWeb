import type { RemotePlayer } from './RemotePlayer.js';

// Visibility gate — who can currently see this remote. Two independent
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
  p.model.setVisible(true);
  // Only add collider if model is loaded (colliderGizmo exists)
  if (p.loaded) p.model.addColliderGizmo();
  p.gizmo?.attach();
  p.auras.show();
}

export function setStaleVis(p: RemotePlayer, hidden: boolean): void {
  if (hidden === p.staleHidden) return;
  p.staleHidden = hidden;
  if (hidden) hideRemote(p); else if (!p.cloakHidden) showRemote(p);
}

export function setCloakVis(p: RemotePlayer, hidden: boolean): void {
  if (hidden === p.cloakHidden) return;
  p.cloakHidden = hidden;
  if (hidden) hideRemote(p); else if (!p.staleHidden) showRemote(p);
}

// Firing decloaks: a cloaked shooter shimmers visible for a beat.
export function shootReveal(p: RemotePlayer): void {
  if (p.cloakHidden && p._loaded) {
    p.ghostT = 1;
    p._model.setGhost(true);
    p.model.setVisible(true);
  }
}

export function tickGhostF(p: RemotePlayer, dt: number): void {
  if (p.ghostT <= 0) return;
  p.ghostT -= dt;
  if (p.ghostT > 0) return;
  p._model.setGhost(false);
  if (p.cloakHidden || p.staleHidden) p.model.setVisible(false);
}
