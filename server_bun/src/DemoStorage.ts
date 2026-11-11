// Server-side demo file storage.
// Saves uploaded demo clips to the demos/ directory and maintains a JSON index.

import { join } from 'node:path';
import { readFile, writeFile, mkdir, unlink, readdir } from 'node:fs/promises';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { logger } from './logger.ts';
import { CONFIG } from './config.ts';
import { wallNow } from './wallClock.ts';

export interface DemoMeta {
  filename: string;
  projectileLifetime: number;
  timestamp: number;
  description: string;
  fileSize: number;
}

const INDEX_FILE = 'index.json';
// Evicted clips gzip into archive/ — write-only, nothing ever deletes
// from it; the operator manages the pile manually.
const ARCHIVE_DIR = 'archive';
const gzipAsync = promisify(gzip);

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class DemoStorage {
  private demosDir: string;
  private index: DemoMeta[] = [];
  /** /demos is a public route — the stale-file sweep below stats every
   *  index entry per request. Cache the listing briefly; uploads and
   *  evictions flow through saveIndex which invalidates it. */
  private listCache: { at: number; rows: DemoMeta[] } | null = null;
  private static LIST_TTL_MS = 5000;

  constructor(demosDir: string) {
    this.demosDir = demosDir;
    this.ensureDir().catch((): void => { /* ensureDir logs its own failure */ });
    this.loadIndex().then((): Promise<void> => this.reconcileIndex()).catch((error): void => {
      logger.warn('DemoStorage index failed to load — starting empty', error);
    });
  }

  private async reconcileIndex(): Promise<void> {
    try {
      const files = await readdir(this.demosDir);
      const demoFiles = files.filter((f): boolean => f.endsWith('.demo'));
      let added = 0;
      for (const filename of demoFiles) {
        // Live membership check, not a snapshot: the ctor doesn't await
        // this reconcile, so a saveDemo in flight writes its file before
        // index.push — a snapshotted 'known' double-indexes it.
        if (this.index.some((m): boolean => m.filename === filename)) {continue;}
        try {
          const data = await readFile(join(this.demosDir, filename));
          const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
          const header = this.parseDemoHeader(ab);
          if (header.projectileLifetime < CONFIG.minDemoLifetime) {continue;}
          // The readFile yield is a race window: a saveDemo landing inside
          // it already pushed this filename — re-check or the index rows
          // outnumber the files on disk.
          if (this.index.some((m): boolean => m.filename === filename)) {continue;}
          this.index.push({
            filename,
            projectileLifetime: header.projectileLifetime,
            timestamp: wallNow(),
            description: header.description,
            fileSize: data.byteLength,
          });
added += 1;
        } catch (error: unknown) {
          logger.warn(`Failed to parse orphaned demo ${filename}`, { error: errMsg(error) });
        }
      }
      if (added > 0) {
        this.index.sort((a, b): number => b.projectileLifetime - a.projectileLifetime);
        await this.saveIndex();
        logger.info(`Reconciled ${added} orphaned demo(s) into index`);
      }
    } catch (error: unknown) {
      logger.warn('Failed to reconcile demo directory', { error: errMsg(error) });
    }
  }

  private async ensureDir(): Promise<void> {
    try {
      if (!existsSync(this.demosDir)) {
        await mkdir(this.demosDir, { recursive: true });
      }
    } catch (error: unknown) {
      // Storage keeps running — every later write reports its own failure.
      logger.warn('Failed to create demos directory', { dir: this.demosDir, error: errMsg(error) });
    }
  }

  private async loadIndex(): Promise<void> {
    try {
      const indexPath = join(this.demosDir, INDEX_FILE);
      if (existsSync(indexPath)) {
        const data = await readFile(indexPath, 'utf-8');
        this.index = JSON.parse(data);
        logger.info(`Demo index loaded: ${this.index.length} demos`);
      }
    } catch (error: unknown) {
      logger.warn('Failed to load demo index', { error: errMsg(error) });
      this.index = [];
    }
  }

  private async saveIndex(): Promise<void> {
    this.listCache = null;
    try {
      const indexPath = join(this.demosDir, INDEX_FILE);
      await writeFile(indexPath, JSON.stringify(this.index, null, 2));
    } catch (error: unknown) {
      logger.warn('Failed to save demo index', { error: errMsg(error) });
    }
  }

  // Parse the demo binary header to extract metadata. Every offset read
  // is bounds-checked — uploads are attacker-controlled bytes, and a
  // truncated body or lying length field would otherwise throw a bare
  // RangeError the route can't distinguish from a write failure.
  private parseDemoHeader(buf: ArrayBuffer): { projectileLifetime: number; description: string; duration: number } {
    const view = new DataView(buf);
    let offset = 0;
    const need = (n: number): void => {
      if (offset + n > view.byteLength) {throw new Error('Malformed demo header');}
    };

    need(1);
    const magic = view.getUint8(((offset += 1) - 1));
    if (magic !== 0x44) {throw new Error('Malformed demo header');}

    need(4);
    const formatVersion = view.getInt32(offset, true); offset += 4;

    // Read gameVersion string
    need(2);
    const gvLen = view.getUint16(offset, true); offset += 2;
    need(gvLen);
    offset += gvLen; // skip string bytes

    need(28);
    offset += 8; // skip timestamp
    const duration = view.getFloat32(offset, true); offset += 4;
    offset += 4; // skip totalFrames
    offset += 4; // skip projEventCount
    offset += 4; // skip targetEventCount
    offset += 4; // skip checksum

    // Read description string
    need(2);
    const descLen = view.getUint16(offset, true); offset += 2;
    need(descLen);
    const descBytes = new Uint8Array(buf, offset, descLen);
    const description = new TextDecoder().decode(descBytes);
    offset += descLen;

    // Skip start position/rotation/velocity (8 * float32 = 32 bytes)
    need(32);
    offset += 32;

    // projectileLifetime is a binary float32 field in format v2+
    let projectileLifetime = 0;
    if (formatVersion >= 2) {
      need(4);
      projectileLifetime = view.getFloat32(offset, true);
    } else {
      // v1 fallback: parse from description string
      const match = description.match(/([\d.]+)s air/);
      if (match && match[1]) {
        projectileLifetime = Number.parseFloat(match[1]);
      }
    }

    return { projectileLifetime, description, duration };
  }

  /** Stream lane: chunked game recordings arrive as sequential
   *  complete .demo files (each extractClip slice is independently
   *  playable). No lifetime gate - the cool-shot floor is a clips
   *  concern, and these skip the index for the same reason. */
  async saveStream(data: ArrayBuffer, session: string, seq: number): Promise<{ filename: string }> {
    const header = this.parseDemoHeader(data); // validates it's a demo at all
    if (!Number.isFinite(header.duration)) {throw new Error('Malformed demo: non-finite duration');}
    const safe = session.replace(/[^\w-]/g, '_').slice(0, 48) || 'anon';
    const filename = `stream_${safe}_${String(seq).padStart(4, '0')}.demo`;
    await mkdir(this.demosDir, { recursive: true });
    await writeFile(join(this.demosDir, filename), new Uint8Array(data));
    logger.info('Demo stream chunk saved', { filename, seq, size: data.byteLength });
    return { filename };
  }

  async saveDemo(data: ArrayBuffer): Promise<{ filename: string; projectileLifetime: number; description: string }> {
    const header = this.parseDemoHeader(data);

    // Reject demos below the cool-shot lifetime threshold — and above the
    // absurd: a crafted Infinity/huge lifetime would sort to the top of
    // the index forever since eviction drops the lowest.
    if (!Number.isFinite(header.projectileLifetime) ||
        header.projectileLifetime < CONFIG.minDemoLifetime ||
        header.projectileLifetime > 300) {
      logger.info('Demo rejected — lifetime out of range', {
        lifetime: header.projectileLifetime.toFixed(2),
        threshold: CONFIG.minDemoLifetime,
        duration: header.duration.toFixed(1),
        desc: header.description,
        size: data.byteLength,
      });
      return { filename: '', projectileLifetime: header.projectileLifetime, description: header.description };
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    // Second-precision stamp + 0.1s lifetime: two uploads in the same
    // second with equal air-time mint the same name and would silently
    // clobber — suffix until the name is free on disk and in the index.
    const base = `clip_${ts}_${header.projectileLifetime.toFixed(1)}s`;
    const taken = new Set(this.index.map((m): string => m.filename));
    let filename = `${base}.demo`;
    for (let n = 2; existsSync(join(this.demosDir, filename)) || taken.has(filename); n += 1) {
      filename = `${base}_${n}.demo`;
    }

    const filePath = join(this.demosDir, filename);
    await writeFile(filePath, new Uint8Array(data));

    const meta: DemoMeta = {
      filename,
      projectileLifetime: header.projectileLifetime,
      timestamp: wallNow(),
      description: header.description,
      fileSize: data.byteLength,
    };

    // The async ctor reconcile may have already adopted this file —
    // pushing unconditionally would index it twice.
    if (!this.index.some((m): boolean => m.filename === meta.filename)) {
      this.index.push(meta);
    }
    this.index.sort((a, b): number => b.projectileLifetime - a.projectileLifetime);

    // Cap the live index — the tail is lowest-lifetime, gzip it to
    // archive rather than delete outright.
    if (this.index.length > CONFIG.demoMaxClips) {
      const removed = this.index.splice(CONFIG.demoMaxClips);
      const archiveDir = join(this.demosDir, ARCHIVE_DIR);
      await mkdir(archiveDir, { recursive: true }).catch((): void => { return; });
      for (const r of removed) {
        try {
          const src = join(this.demosDir, r.filename);
          const gz = await gzipAsync(await readFile(src));
          await writeFile(join(archiveDir, `${r.filename}.gz`), gz);
          await unlink(src);
        } catch { /* eviction failure must not lose the save */ }
      }
    }

    await this.saveIndex();
    logger.info('Demo saved', { filename, lifetime: header.projectileLifetime.toFixed(2), duration: header.duration.toFixed(1), size: data.byteLength, totalDemos: this.index.length });

    return { filename, projectileLifetime: header.projectileLifetime, description: header.description };
  }

  async listDemos(): Promise<DemoMeta[]> {
    const c = this.listCache;
    if (c && wallNow() - c.at < DemoStorage.LIST_TTL_MS) {return c.rows;}
    // Filter out stale entries whose files were deleted
    const valid = this.index.filter((m): boolean => existsSync(join(this.demosDir, m.filename)));
    if (valid.length !== this.index.length) {
      const removed = this.index.length - valid.length;
      logger.info(`Cleaning ${removed} stale demo entries from index`);
      this.index = valid;
      await this.saveIndex();
    }
    // Only list demos that meet the minimum lifetime threshold for "cool shots"
    const cool = this.index.filter((m): boolean => m.projectileLifetime >= CONFIG.minDemoLifetime);
    this.listCache = { at: wallNow(), rows: cool };
    return cool;
  }

  async loadDemo(filename: string): Promise<ArrayBuffer | null> {
    // Sanitize filename - no path traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return null;
    }
    if (!filename.endsWith('.demo')) {
      return null;
    }
    const filePath = join(this.demosDir, filename);
    if (!existsSync(filePath)) {
      return null;
    }
    const data = await readFile(filePath);
    // Buffer.buffer may be a larger pool — slice to exact file bytes
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }
}
