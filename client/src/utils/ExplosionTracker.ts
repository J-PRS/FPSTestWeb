import * as THREE from 'three';

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
    this.recentExplosions.push({
      position: pos.clone(),
      force,
      timestamp: Date.now(),
      shooterId,
    });
    this.cleanup();
  }

  getRecentExplosions(): ExplosionInfo[] {
    return this.recentExplosions;
  }

  private cleanup(): void {
    const cutoff = Date.now() - FRAG_MESSAGE_DURATION;
    while (this.recentExplosions.length > 0 && this.recentExplosions[0].timestamp < cutoff) {
      this.recentExplosions.shift();
    }
  }
}
