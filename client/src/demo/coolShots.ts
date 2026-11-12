// Cool-shot subsystem: watches recorded hits, extracts buffered clips after
// the post-hit window elapses, keeps a top-N recent/best list, and syncs
// clips with the demo server (upload on save, list/download on demand).
// DemoManager owns mode/playback/UI; this owns everything clip-shaped.

import type { DemoRecorder } from './DemoRecorder.js';
import type { DemoFile } from './types.js';
import * as net from './coolShotsNet.js';
import { DemoVault } from './demoVault.js';
import { ChildLogger } from '../core/Logger.js';
import { feedShot, feedShotPending, type PendingFeed } from '../ui/shotFeed.js';

const logger = new ChildLogger('Demo');

// Shape of a demo record in the server's GET /demos JSON response
export interface CoolShotEntry {
  id: string;
  filename?: string; // server-side filename
  projectileLifetime: number;
  timestamp: number;
  description: string;
  weapon?: string;   // displayName of the weapon that scored the hit
  distance?: number; // shot-origin → hit-point travel distance (m)
  score?: number;    // in-game shot score (acc · dist · air) - the TOP sort key
  mp4Name?: string;  // vault clip name when an mp4 was cut for this shot
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
  weapon?: string;
  distance?: number;
  score?: number;
  /** Bottom-right toast whose fill bar tracks the remaining save wait. */
  feed?: PendingFeed;
}

export interface CoolShotDeps {
  recorder(): DemoRecorder;
  isRecording(): boolean;
  // Playback + UI side effects live in DemoManager — clips only request them
  setStatus(status: string): void;
  playDemoData(data: DemoFile): void;
  downloadDemoFile(data: DemoFile, filename: string): void;
  timestampStr(): string;
  /** Same clip window (demo-recorder seconds) cut from the rolling video
   *  buffer — wired only while the canvas recorder is on. Returns the
   *  saved mp4's clip name so the entry can badge/menu-download it. */
  videoClip?(clipStart: number, clipEnd: number, lifetime: number): string | null;
  /** False when the cool-shot demo toggle is off — the pending clip still
   *  extracts so the mp4 lane can cut, but no .demo entry is minted. */
  demoEnabled?(): boolean;
}

export class CoolShotManager {
  private pendingClips: PendingClip[] = [];
  private vault = new DemoVault();
  // Feed pre-buffer: the clip feed fetches the NEXT clip during playback
  // so a swipe lands with zero network gap. Consumed once on play.
  private prefetched = new Map<string, DemoFile>();
  private vaultLoaded = false;
  // Play-race guard: vault.get is async, so rapid tile clicks resolve
  // out of order — last-click must win, not last-resolve.
  private playSeq = 0;
  coolShots: CoolShotEntry[] = [];
  serverUrl = '';
  uploadFailureCount = 0;
  /** Consecutive /demos fetch failures + backoff — a server without the
   *  endpoint (dev box, CORS) must not warn-spam every poll. */
  fetchFailureCount = 0;
  fetchRetryAt = 0;
  private static MAX_UPLOAD_WARNINGS = 3;

  onChanged?: (shots: CoolShotEntry[]) => void;

  constructor(public deps: CoolShotDeps) {}

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
      for (const p of this.pendingClips) {p.feed?.discard();}
      this.pendingClips = [];
    }
  }

  // Recording stops mid-wait — extract now with whatever buffer exists
  flushPending(): void {
    if (this.pendingClips.length === 0) {return;}
    const pending = this.pendingClips;
    this.pendingClips = [];
    for (const p of pending) {this.extractPendingClip(p);}
  }

  // Auto-clip: called when a projectile hits something.
  // If projectileLifetime > minLifetime, schedules a clip extraction
  // bufferAfter seconds after the hit so post-hit footage is captured.
  // If a new cool shot happens during an existing pending clip's wait period,
  // the clips are merged into one longer clip (chain combo).
  // minLifetime is 0.2s during testing phase so clips are easy to trigger. Raise to ~2.0s for production.
  onHit(projectileLifetime: number, minLifetime = 0.2, bufferBefore = 5, bufferAfter = 5, hitTime?: number, meta?: { weapon?: string; distance?: number; score?: number }): void {
    if (!this.deps.isRecording()) {return;}
    if (projectileLifetime < minLifetime) {return;}

    const actualHitTime = hitTime ?? this.deps.recorder().duration;
    const shotTime = actualHitTime - projectileLifetime;

    // Merge into a pending clip whose wait period hasn't elapsed yet
    for (const pending of this.pendingClips) {
      if (actualHitTime < pending.extractAt) {
        pending.clipEnd = actualHitTime + bufferAfter;
        pending.extractAt = actualHitTime + bufferAfter;
        pending.chainCount = (pending.chainCount ?? 1) + 1;
        pending.bestLifetime = Math.max(pending.bestLifetime ?? pending.projectileLifetime, projectileLifetime);
        // Meta follows the best hit — the tile credits the shot that earned it
        if (projectileLifetime >= pending.bestLifetime) {
          pending.weapon = meta?.weapon;
          pending.distance = meta?.distance;
          pending.score = meta?.score;
        }
        const totalDur = pending.clipEnd - pending.clipStart;
        pending.description = `Combo x${pending.chainCount} (best ${pending.bestLifetime.toFixed(2)}s air, ${totalDur.toFixed(1)}s clip)`;
        pending.feed?.extend(bufferAfter);
        logger.debug(`[CoolShot] Chain x${pending.chainCount}! Extending clip to ${totalDur.toFixed(1)}s — extracting in ${bufferAfter}s...`);
        return;
      }
    }

    const clipStart = shotTime - bufferBefore;
    const clipEnd = actualHitTime + bufferAfter;
    const totalClipDuration = projectileLifetime + bufferBefore + bufferAfter;
    const desc = `Best shot (${projectileLifetime.toFixed(2)}s air, ${totalClipDuration.toFixed(1)}s clip)`;

    // Defer extraction until bufferAfter seconds have elapsed so post-hit footage is in the buffer
    this.pendingClips.push({
      extractAt: actualHitTime + bufferAfter,
      clipStart,
      clipEnd,
      projectileLifetime,
      shotTime,
      description: desc,
      feed: feedShotPending(bufferAfter),
      chainCount: 1,
      bestLifetime: projectileLifetime,
      weapon: meta?.weapon,
      distance: meta?.distance,
      score: meta?.score,
    });
    logger.debug(`[CoolShot] Clip scheduled: ${desc} — extracting in ${bufferAfter}s...`);
  }

  // Called every frame while recording
  tick(): void {
    if (this.pendingClips.length === 0) {return;}
    const now = this.deps.recorder().duration;
    for (let i = this.pendingClips.length - 1; i >= 0; i -= 1) {
      const pending = this.pendingClips[i];
      if (now < pending.extractAt) {continue;}
      this.pendingClips.splice(i, 1);
      this.extractPendingClip(pending);
    }
  }

  private extractPendingClip(pending: PendingClip): void {
    if (this.deps.demoEnabled && !this.deps.demoEnabled()) {return;}
    const clipData = this.deps.recorder().extractClip(pending.clipStart, pending.clipEnd, pending.description, pending.bestLifetime);
    if (!clipData) {
      logger.warn('Auto-clip: not enough buffer for this clip');
      return;
    }
    // Only after the demo clip exists — an orphan mp4 with no demo entry
    // is unwatchable vault litter.
    const mp4Name = this.deps.videoClip?.(pending.clipStart, pending.clipEnd, pending.bestLifetime) ?? null;

    const filename = `clip_${this.deps.timestampStr()}_${pending.bestLifetime.toFixed(1)}s.demo`;

    const entry: CoolShotEntry = {
      id: `clip_${Date.now()}_${pending.bestLifetime.toFixed(1)}`,
      filename,
      projectileLifetime: pending.bestLifetime,
      timestamp: Date.now(),
      description: pending.description,
      weapon: pending.weapon,
      distance: pending.distance,
      score: pending.score,
      mp4Name: mp4Name ?? undefined,
      clipData,
    };
    // Upload to server; on success, use the server-assigned filename and free local clipData
    this.uploadClipToServer(clipData).then((serverFilename): void => {
      if (serverFilename) {
        entry.filename = serverFilename;
        entry.clipData = undefined;
        // A fetchFromServer that ran before this upload resolved already
        // merged the server-side copy under the server filename (the
        // local entry still carried its minted name, so dedup missed
        // it) — the same clip would render twice in the panel.
        this.coolShots = this.coolShots.filter((s): boolean => s === entry || s.filename !== serverFilename);
        this.onChanged?.(this.coolShots);
      }
    return; }).catch((error): void => {
      // Upload failing must not eat the local copy — it stays downloadable.
      logger.warn('Clip upload failed', error);
    });
    this.coolShots.push(entry);
    this.trimList();
    // Vault is the durable copy — memory clipData frees after upload,
    // vault keeps the clip downloadable/playbackable across sessions.
    this.vault.put({ id: entry.id, timestamp: entry.timestamp, description: entry.description, projectileLifetime: entry.projectileLifetime, weapon: entry.weapon, distance: entry.distance, score: entry.score, mp4Name: entry.mp4Name, data: clipData });
    this.onChanged?.(this.coolShots);

    logger.debug(`Auto-saved clip: ${filename} (best lifetime ${pending.bestLifetime.toFixed(2)}s, chain x${pending.chainCount})`);
    this.deps.setStatus(`Clip saved! ${pending.bestLifetime.toFixed(1)}s air${pending.chainCount > 1 ? ` x${pending.chainCount}` : ''}`);
    if (pending.feed) {pending.feed.done(pending.shotTime, pending.bestLifetime, pending.chainCount);}
    else {feedShot(pending.shotTime, pending.bestLifetime, pending.chainCount);}
  }

  // Keep top 10 by lifetime + recent 10 by timestamp (may overlap)
  trimList(): void {
    // toSorted returns a copy — it used to be discarded, so "top by
    // lifetime" quietly kept insertion order instead.
    const topIds = new Set([...this.coolShots].toSorted((a, b): number => (b.score ?? b.projectileLifetime) - (a.score ?? a.projectileLifetime)).slice(0, 10).map(s => s.id));
    const recentIds = new Set([...this.coolShots].toSorted((a, b): number => b.timestamp - a.timestamp).slice(0, 10).map(s => s.id));
    this.coolShots = this.coolShots.filter((s): boolean => topIds.has(s.id) || recentIds.has(s.id));
  }

  // Rehydrate the list from the vault: entries restored across
  // sessions carry no clipData — play/download pulls it back lazily.
  async loadVault(): Promise<void> {
    if (this.vaultLoaded) {return;}
    this.vaultLoaded = true;
    const meta = await this.vault.list();
    if (meta.length === 0) {return;}
    const have = new Set(this.coolShots.map((s): string => s.id));
    for (const m of meta) {
      if (have.has(m.id)) {continue;}
      this.coolShots.push({ id: m.id, timestamp: m.timestamp, description: m.description, projectileLifetime: m.projectileLifetime, weapon: m.weapon, distance: m.distance, score: m.score, mp4Name: m.mp4Name });
    }
    this.trimList();
    this.onChanged?.(this.coolShots);
  }

  playAt(index: number): void {
    if (index < 0 || index >= this.coolShots.length) {return;}
    const entry = this.coolShots[index];
    this.playSeq += 1;
    const seq = this.playSeq;
    if (entry.clipData) {
      this.deps.playDemoData(entry.clipData);
      logger.debug(`Playing cool shot: ${entry.description}`);
    } else {
      this.vault.get(entry.id).then((data): void => {
        if (seq !== this.playSeq) {return;} // a newer play request superseded us
        if (data) {
          this.deps.playDemoData(data);
          logger.debug(`Playing cool shot from vault: ${entry.description}`);
          return;
        }
        const cached = entry.filename ? this.prefetched.get(entry.filename) : undefined;
        if (cached) {
          this.prefetched.delete(entry.filename!);
          this.deps.playDemoData(cached);
          return;
        }
        if (entry.filename) {
          this.playFromServer(entry.filename);
        }
      return; }).catch((): void => undefined);
    }
  }

  playById(id: string): void {
    const index = this.coolShots.findIndex((s): boolean => s.id === id);
    if (index !== -1) {this.playAt(index);}
  }

  /** Feed pre-buffer: warm a server clip into memory; playAt consumes it.
   *  Skips that never play leave the entry behind, so the map is capped —
   *  the feed only ever needs the neighbor clips warm. */
  private static readonly PREFETCH_CAP = 4;
  async prefetchClip(filename: string): Promise<void> {
    if (!filename || this.prefetched.has(filename)) {return;}
    const data = await net.fetchDemo(this, filename);
    if (data) {
      if (this.prefetched.size >= CoolShotManager.PREFETCH_CAP) {
        this.prefetched.delete(this.prefetched.keys().next().value!);
      }
      this.prefetched.set(filename, data);
    }
  }

  /** Resolve an entry to its DemoFile without playing it — memory →
   *  vault → prefetch cache → network. The clip feed mounts neighbors
   *  through this so a swipe's incoming frame is real, not a blank slide. */
  async resolveClipData(entry: CoolShotEntry): Promise<DemoFile | null> {
    if (entry.clipData) {return entry.clipData;}
    const data = await this.vault.get(entry.id);
    if (data) {return data;}
    if (entry.filename) {
      // Consume the warm slot: a played clip can't be replayed from the
      // same prefetch, and holding it just burns the capped stash.
      const warm = this.prefetched.get(entry.filename);
      if (warm) {this.prefetched.delete(entry.filename); return warm;}
      return net.fetchDemo(this, entry.filename);
    }
    return null;
  }

  async downloadById(id: string): Promise<void> {
    const entry = this.coolShots.find((s): boolean => s.id === id);
    if (!entry) {
      logger.warn('Cool shot not found:', id);
      return;
    }

    const data = entry.clipData ?? await this.vault.get(entry.id);
    if (data) {
      const filename = `clip_${entry.projectileLifetime.toFixed(1)}s_${this.deps.timestampStr()}.demo`;
      this.deps.downloadDemoFile(data, entry.filename ?? filename);
      this.deps.setStatus('Downloaded!');
      logger.debug(`Downloaded cool shot: ${entry.description}`);
    } else if (entry.filename) {
      const fromServer = await this.fetchDemo(entry.filename);
      if (fromServer) {
        this.deps.downloadDemoFile(fromServer, entry.filename);
        this.deps.setStatus('Downloaded!');
        logger.debug(`Downloaded cool shot from server: ${entry.filename}`);
      }
    }
  }

  private async fetchDemo(filename: string): Promise<DemoFile | null> { return net.fetchDemo(this, filename); }
  private async playFromServer(filename: string): Promise<void> { return net.playFromServer(this, filename); }
  private async uploadClipToServer(clipData: DemoFile): Promise<string | null> { return net.uploadClipToServer(this, clipData); }

  async fetchFromServer(): Promise<void> { return net.fetchFromServer(this); }
}
