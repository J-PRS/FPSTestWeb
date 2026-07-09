/**
 * Cloud sync status.
 */
export enum SyncStatus {
  Idle = 'idle',
  Syncing = 'syncing',
  Success = 'success',
  Error = 'error',
}

/**
 * Cloud sync configuration.
 */
export interface CloudSyncConfig {
  /** API endpoint */
  endpoint: string;
  /** API key */
  apiKey: string;
  /** Sync interval in milliseconds */
  syncInterval: number;
  /** Whether to auto-sync */
  autoSync: boolean;
}

/**
 * Demo cloud sync utilities.
 * Sync demos to cloud storage.
 */
export class DemoCloudSync {
  private config: CloudSyncConfig | null = null;
  private status: SyncStatus = SyncStatus.Idle;
  private lastSyncTime: number = 0;
  private syncIntervalId: number | null = null;

  /**
   * Initialize cloud sync.
   * @param config - Sync configuration
   */
  initialize(config: CloudSyncConfig): void {
    this.config = config;

    if (config.autoSync) {
      this.startAutoSync();
    }
  }

  /**
   * Upload a demo to cloud.
   * @param demoId - Demo ID
   * @param demoData - Demo data
   * @returns Promise resolving to upload result
   */
  async uploadDemo(demoId: string, demoData: Uint8Array): Promise<{ success: boolean; url?: string; error?: string }> {
    if (!this.config) {
      return { success: false, error: 'Cloud sync not initialized' };
    }

    this.status = SyncStatus.Syncing;

    try {
      const formData = new FormData();
      formData.append('demo_id', demoId);
      formData.append('demo_data', new Blob([demoData.buffer.slice(0) as ArrayBuffer]), 'demo.demo');
      formData.append('api_key', this.config.apiKey);

      const response = await fetch(`${this.config.endpoint}/upload`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Upload failed: ${response.statusText}`);
      }

      const result = await response.json();
      this.status = SyncStatus.Success;
      this.lastSyncTime = Date.now();

      return { success: true, url: result.url };
    } catch (error) {
      this.status = SyncStatus.Error;
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Download a demo from cloud.
   * @param demoId - Demo ID
   * @returns Promise resolving to demo data
   */
  async downloadDemo(demoId: string): Promise<{ success: boolean; data?: Uint8Array; error?: string }> {
    if (!this.config) {
      return { success: false, error: 'Cloud sync not initialized' };
    }

    this.status = SyncStatus.Syncing;

    try {
      const response = await fetch(`${this.config.endpoint}/download/${demoId}?api_key=${this.config.apiKey}`);

      if (!response.ok) {
        throw new Error(`Download failed: ${response.statusText}`);
      }

      const buffer = await response.arrayBuffer();
      const data = new Uint8Array(buffer);

      this.status = SyncStatus.Success;
      this.lastSyncTime = Date.now();

      return { success: true, data };
    } catch (error) {
      this.status = SyncStatus.Error;
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * List demos in cloud storage.
   * @returns Promise resolving to demo list
   */
  async listDemos(): Promise<{ success: boolean; demos?: Array<{ id: string; name: string; size: number; uploadedAt: number }>; error?: string }> {
    if (!this.config) {
      return { success: false, error: 'Cloud sync not initialized' };
    }

    try {
      const response = await fetch(`${this.config.endpoint}/list?api_key=${this.config.apiKey}`);

      if (!response.ok) {
        throw new Error(`List failed: ${response.statusText}`);
      }

      const result = await response.json();

      return { success: true, demos: result.demos };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Delete a demo from cloud.
   * @param demoId - Demo ID
   * @returns Promise resolving to delete result
   */
  async deleteDemo(demoId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.config) {
      return { success: false, error: 'Cloud sync not initialized' };
    }

    try {
      const response = await fetch(`${this.config.endpoint}/delete/${demoId}?api_key=${this.config.apiKey}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error(`Delete failed: ${response.statusText}`);
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Start auto-sync.
   */
  private startAutoSync(): void {
    if (this.syncIntervalId !== null) {
      clearInterval(this.syncIntervalId);
    }

    this.syncIntervalId = window.setInterval(() => {
      this.syncAll();
    }, this.config!.syncInterval);
  }

  /**
   * Stop auto-sync.
   */
  stopAutoSync(): void {
    if (this.syncIntervalId !== null) {
      clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
  }

  /**
   * Sync all local demos to cloud.
   * @returns Promise resolving to sync result
   */
  async syncAll(): Promise<{ success: boolean; uploaded: number; failed: number; error?: string }> {
    if (!this.config) {
      return { success: false, uploaded: 0, failed: 0, error: 'Cloud sync not initialized' };
    }

    // This would integrate with DemoManager to get all local demos
    // For now, return a placeholder result
    return { success: true, uploaded: 0, failed: 0 };
  }

  /**
   * Get current sync status.
   * @returns Sync status
   */
  getStatus(): SyncStatus {
    return this.status;
  }

  /**
   * Get last sync time.
   * @returns Last sync timestamp
   */
  getLastSyncTime(): number {
    return this.lastSyncTime;
  }

  /**
   * Destroy cloud sync.
   */
  destroy(): void {
    this.stopAutoSync();
    this.config = null;
    this.status = SyncStatus.Idle;
  }
}
