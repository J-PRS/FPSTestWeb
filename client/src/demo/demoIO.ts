/**
 * demoIO — the file side of DemoManager: saving the recorder's buffer to a
 * .demo download, loading demos from File/ArrayBuffer, and painting the
 * seekbar's shot/hit markers from a loaded file's projectile events.
 * Extracted so DemoManager stays orchestration-only.
 */
import { DemoSerializer } from './DemoSerializer.js';
import { ProjectileEventType } from './types.js';
import type { DemoFile } from './types.js';
import type { DemoRecorder } from './DemoRecorder.js';
import type { DemoPlayer } from './DemoPlayer.js';
import type { DemoUI } from './DemoUI.js';
import type { CoolShotManager } from './coolShots.js';
import { ChildLogger } from '../core/Logger.js';

const logger = new ChildLogger('Demo');

/** The sliver of DemoManager state the IO family mutates. */
export interface DemoIOHost {
  recorder: DemoRecorder;
  player: DemoPlayer;
  ui: DemoUI;
  coolShotMgr: CoolShotManager;
  setMode(m: 'idle' | 'recording' | 'playing' | 'paused'): void;
}

export function downloadDemoFile(data: DemoFile, filename: string): void {
  const blob = DemoSerializer.toBlob(data);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function timestampStr(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
}

// Save current recording to file
export function saveDemo(h: DemoIOHost): void {
  if (h.recorder.frameCount === 0) {
    logger.warn('No frames to save');
    return;
  }
  const data = h.recorder.buildDemoFile();
  downloadDemoFile(data, `demo_${timestampStr()}.demo`);
}

// Load demo from file
export async function loadDemo(h: DemoIOHost, file: File): Promise<void> {
  try {
    const buffer = await file.arrayBuffer();
    const data = DemoSerializer.deserialize(buffer);
    finishLoad(h, data);
    h.ui.setStatus(`Loaded: ${data.frames.length} frames, ${data.header.duration.toFixed(1)}s`);
  } catch (e) {
    logger.error('Failed to load demo:', e);
    h.ui.setStatus(`Load error: ${(e as Error).message}`);
  }
}

// Load demo from ArrayBuffer (for programmatic loading)
export function loadDemoFromBuffer(h: DemoIOHost, buffer: ArrayBuffer): void {
  try {
    finishLoad(h, DemoSerializer.deserialize(buffer));
  } catch (e) {
    logger.error('Failed to load demo:', e);
    h.ui.setStatus(`Load error: ${(e as Error).message}`);
  }
}

// Shared post-load: parked at 0, not playing — differs from playDemoData
// which starts playback immediately.
export function finishLoad(h: DemoIOHost, data: DemoFile): void {
  if (h.recorder.isRecording) {
    h.coolShotMgr.flushPending();
    h.recorder.stop();
    h.ui.setRecording(false);
    h.ui.setStatus('');
  }
  h.player.load(data);
  h.setMode('idle');
  h.ui.setPlaying(false);
  h.ui.setTime(0, data.header.duration);
  updateHitMarkers(h, data);
}

export function updateHitMarkers(h: DemoIOHost, data: DemoFile): void {
  // Collect all fired and hit timestamps, paired by projectileId.
  // Shows every shot/hit on the seekbar, not just the best one.
  const firedTimes = new Map<number, number>();
  for (const e of data.projectileEvents) {
    if (e.eventType === ProjectileEventType.Fired) {
      firedTimes.set(e.projectileId, e.timestamp);
    }
  }

  // "Hot" = the shot this clip exists for: fired→hit airtime matching the
  // header's recorded best lifetime (80% band catches float jitter and
  // near-equal combo partners). Full recordings (lifetime 0) show all hot.
  const best = data.header.projectileLifetime;
  const isHot = (lifetime: number) => best <= 0 || lifetime >= best * 0.8;

  const hitTimes: { t: number; hot: boolean }[] = [];
  const shotTimes: { t: number; hot: boolean }[] = [];
  for (const e of data.projectileEvents) {
    if (e.eventType !== ProjectileEventType.Hit) {continue;}
    const firedAt = firedTimes.get(e.projectileId);
    if (firedAt === undefined) {continue;}
    const hot = isHot(e.timestamp - firedAt);
    hitTimes.push({ t: e.timestamp, hot });
    shotTimes.push({ t: firedAt, hot });
  }

  h.ui.setMarkers(hitTimes, shotTimes, data.header.duration);
}
