import { ChildLogger } from '../core/Logger.js';
import { DemoSerializer } from './DemoSerializer.js';
import type { DemoFile } from './types.js';
import type { CoolShotManager, CoolShotEntry } from './coolShots.js';

const logger = new ChildLogger('Demo');
const MAX_UPLOAD_WARNINGS = 3;

interface ServerDemoRecord {
  filename: string;
  projectileLifetime: number;
  timestamp: number;
  description?: string;
}

// Cool-shot server I/O: download/upload/list fetch + play-from-server.
// Fetch is the only thing here — clip math stays in coolShots.ts.

  // GET /demos/<filename> → DemoFile, with status/logging handled
export async function fetchDemo(m: CoolShotManager, filename: string): Promise<DemoFile | null> {
    if (!m.serverUrl) {
      logger.warn('No server URL set');
      return null;
    }
    try {
      const resp = await fetch(`${m.serverUrl}/demos/${filename}`);
      if (!resp.ok) {
        logger.warn('Failed to download clip:', resp.status);
        m.deps.setStatus('Download failed');
        return null;
      }
      const buffer = await resp.arrayBuffer();
      return DemoSerializer.deserialize(buffer);
    } catch (error) {
      logger.warn('Failed to download from server:', error);
      m.deps.setStatus('Download failed');
      return null;
    }
  }

export async function playFromServer(m: CoolShotManager, filename: string): Promise<void> {
    m.deps.setStatus('Loading clip...');
    const data = await fetchDemo(m, filename);
    if (!data) {
      m.deps.setStatus('Load failed');
      return;
    }
    m.deps.playDemoData(data);
    m.deps.setStatus('');
    logger.debug(`Playing cool shot from server: ${filename}`);
  }

  // Upload clip binary to server. Returns the server-assigned filename, or null on failure.
export async function uploadClipToServer(m: CoolShotManager, clipData: DemoFile): Promise<string | null> {
    if (!m.serverUrl) {
      logger.warn('No server URL set, skipping upload');
      return null;
    }
    try {
      const buffer = DemoSerializer.serialize(clipData);
      const resp = await fetch(`${m.serverUrl}/demos/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buffer,
      });
      if (!resp.ok) {
        logger.warn('Server upload failed:', resp.status);
        return null;
      }
      const result = await resp.json();
      m.uploadFailureCount = 0;
      if (result.rejected || !result.filename) {
        logger.debug(`Clip rejected by server: ${result.reason ?? 'no filename returned'}`);
        return null;
      }
      logger.debug(`Clip uploaded to server: ${result.filename}`);
      return result.filename as string;
    } catch (error) {
m.uploadFailureCount += 1;
      if (m.uploadFailureCount <= MAX_UPLOAD_WARNINGS) {
        logger.warn(`Failed to upload clip (${m.uploadFailureCount}):`, error);
        if (m.uploadFailureCount === MAX_UPLOAD_WARNINGS) {
          logger.warn('Suppressing further upload failure warnings. Check server CORS/network.');
        }
      }
      return null;
    }
  }

  // Merge the server's demo list with local clips (by filename)
export async function fetchFromServer(m: CoolShotManager): Promise<void> {
    if (!m.serverUrl || performance.now() < m.fetchRetryAt) {return;}
    try {
      const resp = await fetch(`${m.serverUrl}/demos`);
      if (!resp.ok) {
        logger.warn(`Failed to fetch cool shots: HTTP ${resp.status}`);
        return;
      }
      m.fetchFailureCount = 0;
      const data = await resp.json();
      const serverDemos: CoolShotEntry[] = ((data.demos || []) as ServerDemoRecord[]).map((d) => ({
        id: d.filename,
        filename: d.filename,
        projectileLifetime: d.projectileLifetime,
        timestamp: d.timestamp,
        description: d.description ?? '',
      }));
      logger.debug(`Fetched ${serverDemos.length} demos from server`);

      const localFilenames = new Set(m.coolShots.map((s): string | undefined => s.filename));
      for (const sd of serverDemos) {
        if (!localFilenames.has(sd.filename)) {
          m.coolShots.push(sd);
        }
      }
      m.trimList();
      m.onChanged?.(m.coolShots);

      logger.debug(`[CoolShots] ${m.coolShots.length} entries (top: ${m.coolShots[0]?.projectileLifetime.toFixed(2) ?? 'none'}s)`);
    } catch (error) {
      m.fetchFailureCount += 1;
      // Back off exponentially (30s→8min cap): unreachable endpoints are
      // sticky, not transient - and warn only on the first strike.
      m.fetchRetryAt = performance.now() + Math.min(30_000 * 2 ** (m.fetchFailureCount - 1), 480_000);
      if (m.fetchFailureCount === 1) {logger.warn('Failed to fetch cool shots from server:', error);}
    }
  }
