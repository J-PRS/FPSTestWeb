/**
 * Client-side state snapshot utility for debugging desync issues
 */

export interface EntityState {
  id: string;
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  health: number;
  isDead: boolean;
  rotation?: { yaw: number; pitch: number };
}

export interface GameStateSnapshot {
  timestamp: number;
  source: 'server' | 'client';
  players: Map<string, EntityState>;
  projectiles: Array<{
    id: string;
    ownerId: string;
    position: { x: number; y: number; z: number };
    velocity: { x: number; y: number; z: number };
  }>;
  hash: string;
}

export class StateSnapshot {
  private static snapshotBuffer: GameStateSnapshot[] = [];
  private static maxBufferSize = 50; // Keep last 50 snapshots

  /**
   * Compute a simple hash of the game state
   */
  static computeHash(snapshot: Omit<GameStateSnapshot, 'hash'>): string {
    const sortedPlayerIds = Array.from(snapshot.players.keys()).sort();
    const playerData = sortedPlayerIds.map(id => {
      const player = snapshot.players.get(id)!;
      return `${id}:${player.position.x},${player.position.y},${player.position.z}:${player.health}:${player.isDead}`;
    }).join('|');

    const projectileData = snapshot.projectiles
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(p => `${p.id}:${p.ownerId}:${p.position.x},${p.position.y},${p.position.z}`)
      .join('|');

    const combined = `${snapshot.timestamp}:${playerData}:${projectileData}`;
    
    // Simple hash function (djb2)
    let hash = 5381;
    for (let i = 0; i < combined.length; i++) {
      hash = ((hash << 5) + hash) + combined.charCodeAt(i);
    }
    return (hash >>> 0).toString(16);
  }

  /**
   * Create a snapshot from current game state
   */
  static create(
    players: Map<string, any>,
    projectiles: Map<string, any> | any[],
    source: 'server' | 'client'
  ): GameStateSnapshot {
    const playerMap = new Map<string, EntityState>();
    
    for (const [id, player] of players) {
      playerMap.set(id, {
        id,
        position: { ...player.position },
        velocity: { ...player.velocity },
        health: player.health,
        isDead: player.isDead,
        rotation: player.rotation ? { ...player.rotation } : undefined
      });
    }

    // Handle both Map and array for projectiles
    const projectileArray = projectiles instanceof Map 
      ? Array.from(projectiles.values())
      : projectiles;
    
    const projectileData = projectileArray.map(p => ({
      id: p.id,
      ownerId: p.ownerId,
      position: { ...p.position },
      velocity: { ...p.velocity }
    }));

    const snapshot: Omit<GameStateSnapshot, 'hash'> = {
      timestamp: Date.now(),
      source,
      players: playerMap,
      projectiles: projectileData
    };

    const hash = this.computeHash(snapshot);

    return {
      ...snapshot,
      hash
    };
  }

  /**
   * Save snapshot to buffer
   */
  static save(snapshot: GameStateSnapshot): void {
    this.snapshotBuffer.push(snapshot);
    
    // Keep buffer size limited
    if (this.snapshotBuffer.length > this.maxBufferSize) {
      this.snapshotBuffer.shift();
    }
  }

  /**
   * Get all buffered snapshots
   */
  static getSnapshots(): GameStateSnapshot[] {
    return [...this.snapshotBuffer];
  }

  /**
   * Export snapshots as a downloadable file
   */
  static exportSnapshots(): void {
    const data = {
      snapshots: this.snapshotBuffer.map(s => ({
        ...s,
        players: Array.from(s.players.entries())
      }))
    };
    
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `client-snapshots-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Compare two snapshots and return differences
   */
  static compare(snapshot1: GameStateSnapshot, snapshot2: GameStateSnapshot): {
    hashMatch: boolean;
    playerDifferences: string[];
    projectileDifferences: string[];
  } {
    const hashMatch = snapshot1.hash === snapshot2.hash;
    const playerDifferences: string[] = [];
    const projectileDifferences: string[] = [];

    // Compare players
    const allPlayerIds = new Set([
      ...snapshot1.players.keys(),
      ...snapshot2.players.keys()
    ]);

    for (const id of allPlayerIds) {
      const p1 = snapshot1.players.get(id);
      const p2 = snapshot2.players.get(id);

      if (!p1) {
        playerDifferences.push(`Player ${id} missing in snapshot1`);
        continue;
      }
      if (!p2) {
        playerDifferences.push(`Player ${id} missing in snapshot2`);
        continue;
      }

      if (p1.position.x !== p2.position.x || 
          p1.position.y !== p2.position.y || 
          p1.position.z !== p2.position.z) {
        playerDifferences.push(
          `Player ${id} position: ${JSON.stringify(p1.position)} vs ${JSON.stringify(p2.position)}`
        );
      }
      if (p1.health !== p2.health) {
        playerDifferences.push(`Player ${id} health: ${p1.health} vs ${p2.health}`);
      }
      if (p1.isDead !== p2.isDead) {
        playerDifferences.push(`Player ${id} isDead: ${p1.isDead} vs ${p2.isDead}`);
      }
    }

    // Compare projectiles
    const p1Ids = new Set(snapshot1.projectiles.map(p => p.id));
    const p2Ids = new Set(snapshot2.projectiles.map(p => p.id));

    for (const id of p1Ids) {
      if (!p2Ids.has(id)) {
        projectileDifferences.push(`Projectile ${id} missing in snapshot2`);
      }
    }
    for (const id of p2Ids) {
      if (!p1Ids.has(id)) {
        projectileDifferences.push(`Projectile ${id} missing in snapshot1`);
      }
    }

    return {
      hashMatch,
      playerDifferences,
      projectileDifferences
    };
  }
}
