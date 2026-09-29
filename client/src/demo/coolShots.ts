// Cool-shot subsystem: watches recorded hits, extracts buffered clips after
// the post-hit window elapses, keeps a top-N recent/best list, and syncs
// clips with the demo server (upload on save, list/download on demand).
// DemoManager owns mode/playback/UI; this owns everything clip-shaped.

import { DemoRecorder } from './DemoRecorder.js';
import { DemoSerializer } from './DemoSerializer.js';
import type { DemoFile } from './types.js';
import { ChildLogger } from '../core/Logger.js';
import { feedShot } from '../ui/shotFeed.js';

const logger = new ChildLogger('Demo');

// Shape of a demo record in the server's GET /demos JSON response
interface ServerDemoRecord {
  filename: string;
  projectileLifetime: number;
  timestamp: number;
  description: string;
}

export interface CoolShotEntry {
  id: string;
  filename?: string; // server-side filename
  projectileLifetime: number;
  timestamp: number;
  description: string;
  clipData?: DemoFile; // only set for locally-generated clips
}

interface PendingClip {
  extractAt: number;
  clipStart: number;
  clipEnd: number;
  projectileLifetime: number;
  /** Recording time when the (first) shot was fired — for the battle log. */
  shotTime: number;
  description: string;
  chainCount: number;
  bestLifetime: number;
}

export interface CoolShotDeps {
  recorder(): DemoRecorder;
  isRecording(): boolean;
  // Playback + UI side effects live in DemoManager — clips only request them
  setStatus(status: string): void;
  playDemoData(data: DemoFile): void;
  downloadDemoFile(data: DemoFile, filename: string): void;
  timestampStr(): string;
}

export class CoolShotManager {
  private pendingClips: PendingClip[] = [];
  private coolShots: CoolShotEntry[] = [];
  private serverUrl = '';
  private uploadFailureCount = 0;
  private static MAX_UPLOAD_WARNINGS = 3;

  onChanged?: (shots: CoolShotEntry[]) => void;

  constructor(private deps: CoolShotDeps) {}

  setServerUrl(url: string): void {
    this.serverUrl = url.replace(/\/$/, '');
  }

  get list(): CoolShotEntry[] {
    return this.coolShots;
  }

  // A new recording abandons the buffer pending clips were waiting on
  clearPending(): void {
    if (this.pendingClips.length > 0) {
      logger.debug(`Clearing ${this.pendingClips.length} pending clip(s) from previous recording`);
      this.pendingClips = [];
    }
  }

  // Recording stops mid-wait — extract now with whatever buffer exists
  flushPending(): void {
    if (this.pendingClips.length === 0) return;
    const pending = this.pendingClips;
    this.pendingClips = [];
    for (const p of pending) this.extractPendingClip(p);
  }

  // Auto-clip: called when a projectile hits something.
  // If projectileLifetime > minLifetime, schedules a clip extraction
  // bufferAfter seconds after the hit so post-hit footage is captured.
  // If a new cool shot happens during an existing pending clip's wait period,
  // the clips are merged into one longer clip (chain combo).
  // minLifetime is 0.2s during testing phase so clips are easy to trigger. Raise to ~2.0s for production.
  onHit(projectileLifetime: number, minLifetime: number = 0.2, bufferBefore: number = 5.0, bufferAfter: number = 5.0, hitTime?: number): void {
    if (!this.deps.isRecording()) return;
    if (projectileLifetime < minLifetime) return;

    const actualHitTime = hitTime ?? this.deps.recorder().duration;
    const shotTime = actualHitTime - projectileLifetime;

    // Merge into a pending clip whose wait period hasn't elapsed yet
    for (const pending of this.pendingClips) {
      if (actualHitTime < pending.extractAt) {
        pending.clipEnd = actualHitTime + bufferAfter;
        pending.extractAt = actualHitTime + bufferAfter;
        pending.chainCount = (pending.chainCount ?? 1) + 1;
        pending.bestLifetime = Math.max(pending.bestLifetime ?? pending.projectileLifetime, projectileLifetime);
        const totalDur = pending.clipEnd - pending.clipStart;
        pending.description = `Combo x${pending.chainCount} (best ${pending.bestLifetime.toFixed(2)}s air, ${totalDur.toFixed(1)}s clip)`;
        logger.debug(`[CoolShot] Chain x${pending.chainCount}! Extending clip to ${totalDur.toFixed(1)}s — extracting in ${bufferAfter}s...`);
        return;
      }
    }

    const clipStart = shotTime - bufferBefore;
    const clipEnd = actualHitTime + bufferAfter;
    const totalClipDuration = projectileLifetime + bufferBefore + bufferAfter;
    const desc = `Cool shot (${projectileLifetime.toFixed(2)}s air, ${totalClipDuration.toFixed(1)}s clip)`;

    // Defer extraction until bufferAfter seconds have elapsed so post-hit footage is in the buffer
    this.pendingClips.push({
      extractAt: actualHitTime + bufferAfter,
      clipStart,
      clipEnd,
      projectileLifetime,
      shotTime,
      description: desc,
      chainCount: 1,
      bestLifetime: projectileLifetime,
    });
    logger.debug(`[CoolShot] Clip scheduled: ${desc} — extracting in ${bufferAfter}s...`);
  }

  // Called every frame while recording
  tick(): void {
    if (this.pendingClips.length === 0) return;
    const now = this.deps.recorder().duration;
    for (let i = this.pendingClips.length - 1; i >= 0; i--) {
      const pending = this.pendingClips[i];
      if (now < pending.extractAt) continue;
      this.pendingClips.splice(i, 1);
      this.extractPendingClip(pending);
    }
  }

  private extractPendingClip(pending: PendingClip): void {
    const clipData = this.deps.recorder().extractClip(pending.clipStart, pending.clipEnd, pending.description, pending.bestLifetime);
    if (!clipData) {
      logger.warn('Auto-clip: not enough buffer for this clip');
      return;
    }

    const filename = `clip_${this.deps.timestampStr()}_${pending.bestLifetime.toFixed(1)}s.demo`;

    const entry: CoolShotEntry = {
      id: `clip_${Date.now()}_${pending.bestLifetime.toFixed(1)}`,
      filename,
      projectileLifetime: pending.bestLifetime,
      timestamp: Date.now(),
      description: pending.description,
      clipData,
    };
    // Upload to server; on success, use the server-assigned filename and free local clipData
    this.uploadClipToServer(clipData).then((serverFilename) => {
      if (serverFilename) {
        entry.filename = serverFilename;
        entry.clipData = undefined;
        this.onChanged?.(this.coolShots);
      }
    });
    this.coolShots.push(entry);
    this.trimList();
    this.onChanged?.(this.coolShots);

    logger.debug(`Auto-saved clip: ${filename} (best lifetime ${pending.bestLifetime.toFixed(2)}s, chain x${pending.chainCount})`);
    this.deps.setStatus(`Clip saved! ${pending.bestLifetime.toFixed(1)}s air${pending.chainCount > 1 ? ` x${pending.chainCount}` : ''}`);
    feedShot(pending.shotTime, pending.bestLifetime, pending.chainCount);
  }

  // Keep top 10 by lifetime + recent 10 by timestamp (may overlap)
  private trimList(): void {
    this.coolShots.toSorted((a, b) => b.projectileLifetime - a.projectileLifetime);
    const topIds = new Set(this.coolShots.slice(0, 10).map(s => s.id));
    const recentIds = new Set([...this.coolShots].toSorted((a, b) => b.timestamp - a.timestamp).slice(0, 10).map(s => s.id));
    this.coolShots = this.coolShots.filter(s => topIds.has(s.id) || recentIds.has(s.id));
  }

  playAt(index: number): void {
    if (index < 0 || index >= this.coolShots.length) return;
    const entry = this.coolShots[index];
    if (entry.clipData) {
      this.deps.playDemoData(entry.clipData);
      logger.debug(`Playing cool shot: ${entry.description}`);
    } else if (entry.filename) {
      this.playFromServer(entry.filename);
    }
  }

  playById(id: string): void {
    const index = this.coolShots.findIndex(s => s.id === id);
    if (index >= 0) this.playAt(index);
  }

  async downloadById(id: string): Promise<void> {
    const entry = this.coolShots.find(s => s.id === id);
    if (!entry) {
      logger.warn('Cool shot not found:', id);
      return;
    }

    if (entry.clipData) {
      const filename = `clip_${entry.projectileLifetime.toFixed(1)}s_${this.deps.timestampStr()}.demo`;
      this.deps.downloadDemoFile(entry.clipData, filename);
      logger.debug(`Downloaded cool shot: ${entry.description}`);
    } else if (entry.filename) {
      const data = await this.fetchDemo(entry.filename);
      if (data) {
        this.deps.downloadDemoFile(data, entry.filename);
        this.deps.setStatus('Downloaded!');
        logger.debug(`Downloaded cool shot from server: ${entry.filename}`);
      }
    }
  }

  // GET /demos/<filename> → DemoFile, with status/logging handled
  private async fetchDemo(filename: string): Promise<DemoFile | null> {
    if (!this.serverUrl) {
      logger.warn('No server URL set');
      return null;
    }
    try {
      const resp = await fetch(`${this.serverUrl}/demos/${filename}`);
      if (!resp.ok) {
        logger.warn('Failed to download clip:', resp.status);
        this.deps.setStatus('Download failed');
        return null;
      }
      const buffer = await resp.arrayBuffer();
      return DemoSerializer.deserialize(buffer);
    } catch (e) {
      logger.warn('Failed to download from server:', e);
      this.deps.setStatus('Download failed');
      return null;
    }
  }

  private async playFromServer(filename: string): Promise<void> {
    this.deps.setStatus('Loading clip...');
    const data = await this.fetchDemo(filename);
    if (!data) {
      this.deps.setStatus('Load failed');
      return;
    }
    this.deps.playDemoData(data);
    this.deps.setStatus('');
    logger.debug(`Playing cool shot from server: ${filename}`);
  }

  // Upload clip binary to server. Returns the server-assigned filename, or null on failure.
  private async uploadClipToServer(clipData: DemoFile): Promise<string | null> {
    if (!this.serverUrl) {
      logger.warn('No server URL set, skipping upload');
      return null;
    }
    try {
      const buffer = DemoSerializer.serialize(clipData);
      const resp = await fetch(`${this.serverUrl}/demos/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buffer,
      });
      if (!resp.ok) {
        logger.warn('Server upload failed:', resp.status);
        return null;
      }
      const result = await resp.json();
      this.uploadFailureCount = 0;
      if (result.rejected || !result.filename) {
        logger.debug(`Clip rejected by server: ${result.reason ?? 'no filename returned'}`);
        return null;
      }
      logger.debug(`Clip uploaded to server: ${result.filename}`);
      return result.filename as string;
    } catch (e) {
      this.uploadFailureCount++;
      if (this.uploadFailureCount <= CoolShotManager.MAX_UPLOAD_WARNINGS) {
        logger.warn(`Failed to upload clip (${this.uploadFailureCount}):`, e);
        if (this.uploadFailureCount === CoolShotManager.MAX_UPLOAD_WARNINGS) {
          logger.warn('Suppressing further upload failure warnings. Check server CORS/network.');
        }
      }
      return null;
    }
  }

  // Merge the server's demo list with local clips (by filename)
  async fetchFromServer(): Promise<void> {
    if (!this.serverUrl) return;
    try {
      const resp = await fetch(`${this.serverUrl}/demos`);
      if (!resp.ok) {
        logger.warn(`Failed to fetch cool shots: HTTP ${resp.status}`);
        return;
      }
      const data = await resp.json();
      const serverDemos: CoolShotEntry[] = ((data.demos || []) as ServerDemoRecord[]).map((d) => ({
        id: d.filename,
        filename: d.filename,
        projectileLifetime: d.projectileLifetime,
        timestamp: d.timestamp,
        description: d.description,
      }));
      logger.debug(`Fetched ${serverDemos.length} demos from server`);

      const localFilenames = new Set(this.coolShots.map(s => s.filename));
      for (const sd of serverDemos) {
        if (!localFilenames.has(sd.filename)) {
          this.coolShots.push(sd);
        }
      }
      this.trimList();
      this.onChanged?.(this.coolShots);

      logger.debug(`[CoolShots] ${this.coolShots.length} entries (top: ${this.coolShots[0]?.projectileLifetime.toFixed(2) ?? 'none'}s)`);
    } catch (e) {
      logger.warn('Failed to fetch cool shots from server:', e);
    }
  }
}
