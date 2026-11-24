/** Pointer-lock-less fallback: browsers without the Pointer Lock API
 *  (Ladybird - requestPointerLock is a NotSupportedError stub) still
 *  deliver movementX/Y on plain mousemoves, so look input can run
 *  degraded: cursor visible, motion dies at the screen edge. Better
 *  than dead input - this is what the "working" games do there. */
let active = false;

export function enableLockFallback(): void { active = true; }

/** True when mouse capture is effectively live: real pointer lock, or
 *  the degraded no-lock fallback after the API proved absent. */
export function pointerEngaged(): boolean {
  return document.pointerLockElement != null || active;
}
