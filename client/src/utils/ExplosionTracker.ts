import type * as THREE from 'three';

import { FRAG_MESSAGE_DURATION } from '../core/config.js';

interface ExplosionInfo {
  position: THREE.Vector3;
  force: number;
  timestamp: number;
  shooterId: string;
}

export class ExplosionTracker {
  private recentExplosions: ExplosionInfo[] = [];
  /** Server shoves that arrived before their blast edge (lane reorder —
   *  the knockback rides the reliable lane ahead of the explode event).
   *  A blast landing within the horizon consumes them; expiry is the
   *  caller's anomaly, not ours. */
  private pendingShoves: { x: number; y: number; z: number; t: number; force: number; pull: boolean }[] = [];

  static readonly SHOVE_GRACE_MS = 600;

  addExplosion(pos: THREE.Vector3, force: number, shooterId: string): void {
    // A poisoned entry leaks NaN into gib impulse math at kill time.
    if (!Number.isFinite(pos.x + pos.y + pos.z + force)) {return;}
    const now = Date.now();
    // A late blast edge redeems its earlier knockback — drop the shove.
    for (let i = this.pendingShoves.length - 1; i >= 0; i -= 1) {
      const s = this.pendingShoves[i]!;
      const dx = pos.x - s.x; const dy = pos.y - s.y; const dz = pos.z - s.z;
      if (now - s.t > ExplosionTracker.SHOVE_GRACE_MS || dx * dx + dy * dy + dz * dz < 144) {this.pendingShoves.splice(i, 1);}
    }
    this.recentExplosions.push({
      position: pos.clone(),
      force,
      timestamp: now,
      shooterId,
    });
    this.cleanup();
  }

  /** Server shove with no rendered blast yet — hold for the edge. */
  shoveArrived(x: number, y: number, z: number, force: number, pull: boolean): void {
    this.pendingShoves.push({ x, y, z, t: Date.now(), force, pull });
  }

  /** Shoves whose grace expired without a matching blast — anomaly. */
  expiredShoves(now: number): { x: number; y: number; z: number; t: number; force: number; pull: boolean }[] {
    const out = this.pendingShoves.filter((s): boolean => now - s.t > ExplosionTracker.SHOVE_GRACE_MS);
    this.pendingShoves = this.pendingShoves.filter((s): boolean => now - s.t <= ExplosionTracker.SHOVE_GRACE_MS);
    return out;
  }

  getRecentExplosions(): ExplosionInfo[] {
    this.cleanup(); // reads must not serve entries expired since the last add
    return this.recentExplosions;
  }

  private cleanup(): void {
    const cutoff = Date.now() - FRAG_MESSAGE_DURATION;
    // Entries are append-ordered by timestamp — find the first live one
    // and drop the whole expired prefix in one splice; shift() per entry
    // is O(n) per add under a burst.
    let live = 0;
    while (live < this.recentExplosions.length && this.recentExplosions[live].timestamp < cutoff) {live += 1;}
    if (live > 0) {this.recentExplosions.splice(0, live);}
  }
}
