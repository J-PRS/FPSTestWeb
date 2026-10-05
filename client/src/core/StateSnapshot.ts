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

export interface ProjectileSnapshotEntry {
  id: string;
  ownerId: string;
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
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

export namespace StateSnapshot {
  const snapshotBuffer: GameStateSnapshot[] = [];
  const MAX_SNAPSHOTS = 50; // Keep last 50 snapshots

  /**
   * Compute a simple hash of the game state
   */
  export function computeHash(snapshot: Omit<GameStateSnapshot, 'hash'>): string {
    const sortedPlayerIds = Array.from(snapshot.players.keys()).toSorted();
    const playerData = sortedPlayerIds.map(id => {
      const player = snapshot.players.get(id)!;
      return `${id}:${player.position.x},${player.position.y},${player.position.z}:${player.health}:${player.isDead}`;
    }).join('|');

    const projectileData = snapshot.projectiles
      .toSorted((a, b) => a.id.localeCompare(b.id))
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
  export function create(
    players: Map<string, Omit<EntityState, 'id'>>,
    projectiles: Map<string, ProjectileSnapshotEntry> | ProjectileSnapshotEntry[],
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

    const hash = computeHash(snapshot);

    return {
      ...snapshot,
      hash
    };
  }

  /**
   * Save snapshot to buffer
   */
  export function save(snapshot: GameStateSnapshot): void {
    snapshotBuffer.push(snapshot);
    
    // Keep buffer size limited
    if (snapshotBuffer.length > MAX_SNAPSHOTS) {
      snapshotBuffer.shift();
    }
  }

  /**
   * Get all buffered snapshots
   */
  export function getSnapshots(): GameStateSnapshot[] {
    return [...snapshotBuffer];
  }

  /**
   * Export snapshots as a downloadable file
   */
  export function exportSnapshots(): void {
    const data = {
      snapshots: snapshotBuffer.map(s => ({ ...s, players: Array.from(s.players.entries())}))
    };
    
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `client-snapshots-${new Date().toISOString().split('T')[0]}.json`;
    document.body.append(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Compare two snapshots and return differences
   */
  export function compare(snapshot1: GameStateSnapshot, snapshot2: GameStateSnapshot): {
    hashMatch: boolean;
    playerDifferences: string[];
    projectileDifferences: string[];
  } {
    return {
      hashMatch: snapshot1.hash === snapshot2.hash,
      playerDifferences: comparePlayers(snapshot1, snapshot2),
      projectileDifferences: compareProjectiles(snapshot1, snapshot2),
    };
  }

  function comparePlayers(s1: GameStateSnapshot, s2: GameStateSnapshot): string[] {
    const diffs: string[] = [];
    const allPlayerIds = new Set([...s1.players.keys(), ...s2.players.keys()]);

    for (const id of allPlayerIds) {
      const p1 = s1.players.get(id);
      const p2 = s2.players.get(id);

      if (!p1 || !p2) {
        diffs.push(`Player ${id} missing in ${p1 ? 'snapshot2' : 'snapshot1'}`);
        continue;
      }

      if (p1.position.x !== p2.position.x ||
          p1.position.y !== p2.position.y ||
          p1.position.z !== p2.position.z) {
        diffs.push(
          `Player ${id} position: ${JSON.stringify(p1.position)} vs ${JSON.stringify(p2.position)}`
        );
      }
      if (p1.health !== p2.health) {
        diffs.push(`Player ${id} health: ${p1.health} vs ${p2.health}`);
      }
      if (p1.isDead !== p2.isDead) {
        diffs.push(`Player ${id} isDead: ${p1.isDead} vs ${p2.isDead}`);
      }
    }
    return diffs;
  }

  function compareProjectiles(s1: GameStateSnapshot, s2: GameStateSnapshot): string[] {
    const diffs: string[] = [];
    const p1Ids = new Set(s1.projectiles.map(p => p.id));
    const p2Ids = new Set(s2.projectiles.map(p => p.id));

    for (const id of p1Ids) {
      if (!p2Ids.has(id)) {diffs.push(`Projectile ${id} missing in snapshot2`);}
    }
    for (const id of p2Ids) {
      if (!p1Ids.has(id)) {diffs.push(`Projectile ${id} missing in snapshot1`);}
    }
    return diffs;
  }
}
