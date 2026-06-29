import { DemoFile } from '../types/DemoFile.js';
import { DemoSerializer } from '../serialization/DemoSerializer.js';
import { VersionManager } from '../serialization/VersionManager.js';
import { SchemaRegistry } from '../serialization/SchemaRegistry.js';

/**
 * Demo file metadata.
 */
export interface DemoInfo {
  /** File path or ID */
  id: string;
  /** Demo name */
  name: string;
  /** File size in bytes */
  size: number;
  /** Recording timestamp */
  timestamp: number;
  /** Duration in seconds */
  duration: number;
  /** Number of frames */
  frameCount: number;
  /** Number of projectile events */
  projectileEvents: number;
  /** Number of target events */
  targetEvents: number;
  /** Description */
  description: string;
  /** Format version */
  formatVersion: number;
}

/**
 * Manages demo file operations.
 * Handles saving, loading, browsing, and cleanup of demo files.
 * Uses IndexedDB for browser storage.
 */
export class DemoManager {
  private schemaRegistry: SchemaRegistry;
  private versionManager: VersionManager;
  private demoCache: DemoInfo[] = [];
  private dbName: string = 'DemoStorage';
  private storeName: string = 'demos';
  private db: IDBDatabase | null = null;

  // Configuration
  private maxDemosToKeep: number = 50;
  private maxStorageBytes: number = 50 * 1024 * 1024; // 50 MB
  private autoDeleteOldDemos: boolean = true;
  private demoRetentionDays: number = 30;

  constructor(schemaRegistry?: SchemaRegistry) {
    this.schemaRegistry = schemaRegistry || new SchemaRegistry();
    this.versionManager = new VersionManager(this.schemaRegistry);
  }

  /**
   * Initialize the demo manager and open IndexedDB.
   */
  async initialize(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);

      request.onerror = () => {
        reject(new Error(`Failed to open IndexedDB: ${request.error}`));
      };

      request.onsuccess = () => {
        this.db = request.result;
        console.log('[DemoManager] IndexedDB initialized');
        this.refreshDemoCache().then(resolve).catch(reject);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, { keyPath: 'id' });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('name', 'name', { unique: false });
        }
      };
    });
  }

  /**
   * Save a demo file to storage.
   * @param demo - Demo file to save
   * @param customName - Optional custom name
   * @returns Demo info
   */
  async saveDemo(demo: DemoFile, customName?: string): Promise<DemoInfo> {
    if (!this.db) {
      throw new Error('DemoManager not initialized');
    }

    // Serialize demo
    const data = DemoSerializer.serialize(demo);
    const name = customName || `demo_${Date.now()}`;

    // Create demo info
    const demoInfo: DemoInfo = {
      id: name,
      name,
      size: data.length,
      timestamp: demo.header.timestamp,
      duration: demo.header.duration,
      frameCount: demo.header.totalFrames,
      projectileEvents: demo.header.projectileEvents,
      targetEvents: demo.header.targetEvents,
      description: demo.header.description,
      formatVersion: demo.header.formatVersion,
    };

    // Save to IndexedDB
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);

      const record = {
        id: demoInfo.id,
        name: demoInfo.name,
        data,
        info: demoInfo,
      };

      const request = store.put(record);

      request.onsuccess = () => {
        console.log(`[DemoManager] Saved demo: ${name}`);
        this.refreshDemoCache();
        this.checkStorageLimits();
        resolve(demoInfo);
      };

      request.onerror = () => {
        reject(new Error(`Failed to save demo: ${request.error}`));
      };
    });
  }

  /**
   * Load a demo file from storage.
   * @param id - Demo ID
   * @returns Demo file
   */
  async loadDemo(id: string): Promise<DemoFile> {
    if (!this.db) {
      throw new Error('DemoManager not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.get(id);

      request.onsuccess = () => {
        const record = request.result;
        if (!record) {
          reject(new Error(`Demo not found: ${id}`));
          return;
        }

        // Deserialize demo
        let demo = DemoSerializer.deserialize(record.data);

        // Migrate to current version if needed
        if (this.versionManager.needsMigration(demo)) {
          console.log(`[DemoManager] Migrating demo from v${demo.header.formatVersion}`);
          demo = this.versionManager.migrateToCurrent(demo);
        }

        resolve(demo);
      };

      request.onerror = () => {
        reject(new Error(`Failed to load demo: ${request.error}`));
      };
    });
  }

  /**
   * Delete a demo file from storage.
   * @param id - Demo ID
   */
  async deleteDemo(id: string): Promise<void> {
    if (!this.db) {
      throw new Error('DemoManager not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      const request = store.delete(id);

      request.onsuccess = () => {
        console.log(`[DemoManager] Deleted demo: ${id}`);
        this.refreshDemoCache();
        resolve();
      };

      request.onerror = () => {
        reject(new Error(`Failed to delete demo: ${request.error}`));
      };
    });
  }

  /**
   * Get all demo info.
   * @returns Array of demo info
   */
  getDemos(): DemoInfo[] {
    return [...this.demoCache];
  }

  /**
   * Get demo info by ID.
   * @param id - Demo ID
   * @returns Demo info or undefined
   */
  getDemoInfo(id: string): DemoInfo | undefined {
    return this.demoCache.find((demo) => demo.id === id);
  }

  /**
   * Refresh the demo cache from storage.
   */
  private async refreshDemoCache(): Promise<void> {
    if (!this.db) {
      return;
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.getAll();

      request.onsuccess = () => {
        const records = request.result;
        this.demoCache = records
          .map((record: any) => record.info)
          .sort((a: DemoInfo, b: DemoInfo) => b.timestamp - a.timestamp);
        resolve();
      };

      request.onerror = () => {
        reject(new Error(`Failed to refresh demo cache: ${request.error}`));
      };
    });
  }

  /**
   * Check and enforce storage limits.
   */
  private async checkStorageLimits(): Promise<void> {
    if (!this.autoDeleteOldDemos) {
      return;
    }

    // Check count limit
    if (this.demoCache.length > this.maxDemosToKeep) {
      const toDelete = this.demoCache.slice(this.maxDemosToKeep);
      for (const demo of toDelete) {
        await this.deleteDemo(demo.id);
      }
    }

    // Check size limit
    const totalSize = this.demoCache.reduce((sum, demo) => sum + demo.size, 0);
    if (totalSize > this.maxStorageBytes) {
      // Delete oldest demos until under limit
      let sorted = [...this.demoCache].sort((a, b) => a.timestamp - b.timestamp);
      let currentSize = totalSize;

      while (currentSize > this.maxStorageBytes && sorted.length > 0) {
        const oldest = sorted.shift()!;
        await this.deleteDemo(oldest.id);
        currentSize -= oldest.size;
      }
    }

    // Check retention limit
    const cutoffTime = Date.now() - this.demoRetentionDays * 24 * 60 * 60 * 1000;
    const expired = this.demoCache.filter((demo) => demo.timestamp < cutoffTime);
    for (const demo of expired) {
      await this.deleteDemo(demo.id);
    }
  }

  /**
   * Get total storage used.
   * @returns Total size in bytes
   */
  getTotalStorageUsed(): number {
    return this.demoCache.reduce((sum, demo) => sum + demo.size, 0);
  }

  /**
   * Get storage usage percentage.
   * @returns Percentage (0-100)
   */
  getStorageUsagePercentage(): number {
    return (this.getTotalStorageUsed() / this.maxStorageBytes) * 100;
  }

  /**
   * Clear all demos.
   */
  async clearAllDemos(): Promise<void> {
    if (!this.db) {
      throw new Error('DemoManager not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      const request = store.clear();

      request.onsuccess = () => {
        console.log('[DemoManager] Cleared all demos');
        this.refreshDemoCache();
        resolve();
      };

      request.onerror = () => {
        reject(new Error(`Failed to clear demos: ${request.error}`));
      };
    });
  }

  // Configuration setters
  setMaxDemosToKeep(max: number): void {
    this.maxDemosToKeep = max;
  }

  setMaxStorageBytes(max: number): void {
    this.maxStorageBytes = max;
  }

  setAutoDeleteOldDemos(auto: boolean): void {
    this.autoDeleteOldDemos = auto;
  }

  setDemoRetentionDays(days: number): void {
    this.demoRetentionDays = days;
  }

  /**
   * Close the IndexedDB connection.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
