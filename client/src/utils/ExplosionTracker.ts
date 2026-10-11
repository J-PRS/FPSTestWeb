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

  addExplosion(pos: THREE.Vector3, force: number, shooterId: string): void {
    // A poisoned entry leaks NaN into gib impulse math at kill time.
    if (!Number.isFinite(pos.x + pos.y + pos.z + force)) {return;}
    this.recentExplosions.push({
      position: pos.clone(),
      force,
      timestamp: Date.now(),
      shooterId,
    });
    this.cleanup();
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
