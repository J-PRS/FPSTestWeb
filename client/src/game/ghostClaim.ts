// Predicted-hit ghost claim: when a local shell sweeps a remote body,
// the spot it swept is the best possible drawn-ghost report - the sweep
// pos is already the wire ghost projected to the server's adjudication
// epoch, so the report lands inside the rewind slack by construction.
// aimGhostFor prefers a fresh claim (<~shell transit) over the ray pick.
// Trust model unchanged: this is only a hint - the server still gates
// the spot against rewind/live slack, so a forged claim buys nothing.
export const ghostClaim = { id: '', x: 0, y: 0, z: 0, at: 0 };

export function noteGhostClaim(id: string, x: number, y: number, z: number): void {
  ghostClaim.id = id; ghostClaim.x = x; ghostClaim.y = y; ghostClaim.z = z;
  ghostClaim.at = performance.now();
}
