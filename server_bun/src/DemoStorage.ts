// Server-side demo file storage.
// Saves uploaded demo clips to the demos/ directory and maintains a JSON index.

import { join } from 'node:path';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { logger } from './logger.ts';

export interface DemoMeta {
  filename: string;
  projectileLifetime: number;
  timestamp: number;
  description: string;
  fileSize: number;
}

const INDEX_FILE = 'index.json';
const MAX_DEMOS = 100;

export class DemoStorage {
  private demosDir: string;
  private index: DemoMeta[] = [];

  constructor(demosDir: string) {
    this.demosDir = demosDir;
    this.ensureDir();
    this.loadIndex();
  }

  private async ensureDir(): Promise<void> {
    if (!existsSync(this.demosDir)) {
      await mkdir(this.demosDir, { recursive: true });
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
    } catch (e: any) {
      logger.warn('Failed to load demo index', { error: e?.message ?? String(e) });
      this.index = [];
    }
  }

  private async saveIndex(): Promise<void> {
    try {
      const indexPath = join(this.demosDir, INDEX_FILE);
      await writeFile(indexPath, JSON.stringify(this.index, null, 2));
    } catch (e: any) {
      logger.warn('Failed to save demo index', { error: e?.message ?? String(e) });
    }
  }

  // Parse the demo binary header to extract metadata
  private parseDemoHeader(buf: ArrayBuffer): { projectileLifetime: number; description: string; duration: number } {
    const view = new DataView(buf);
    let offset = 0;

    const magic = view.getUint8(offset++);
    if (magic !== 0x44) throw new Error('Invalid demo magic');

    offset += 4; // skip formatVersion

    // Read gameVersion string
    const gvLen = view.getUint16(offset, true); offset += 2;
    offset += gvLen; // skip string bytes

    offset += 8; // skip timestamp
    const duration = view.getFloat32(offset, true); offset += 4;
    offset += 4; // skip totalFrames
    offset += 4; // skip projEventCount
    offset += 4; // skip targetEventCount
    offset += 4; // skip checksum

    // Read description string
    const descLen = view.getUint16(offset, true); offset += 2;
    const descBytes = new Uint8Array(buf, offset, descLen);
    const description = new TextDecoder().decode(descBytes);

    // The projectile lifetime is encoded in the description: "Cool shot (X.XXs air, ...)"
    let projectileLifetime = 0;
    const match = description.match(/([\d.]+)s air/);
    if (match && match[1]) {
      projectileLifetime = parseFloat(match[1]);
    }

    return { projectileLifetime, description, duration };
  }

  async saveDemo(data: ArrayBuffer): Promise<{ filename: string; projectileLifetime: number; description: string }> {
    const header = this.parseDemoHeader(data);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const filename = `clip_${ts}_${header.projectileLifetime.toFixed(1)}s.demo`;

    const filePath = join(this.demosDir, filename);
    await writeFile(filePath, new Uint8Array(data));

    const meta: DemoMeta = {
      filename,
      projectileLifetime: header.projectileLifetime,
      timestamp: Date.now(),
      description: header.description,
      fileSize: data.byteLength,
    };

    this.index.push(meta);
    this.index.sort((a, b) => b.projectileLifetime - a.projectileLifetime);

    // Cap at MAX_DEMOS, remove oldest excess entries
    if (this.index.length > MAX_DEMOS) {
      const removed = this.index.splice(MAX_DEMOS);
      for (const r of removed) {
        const rmPath = join(this.demosDir, r.filename);
        await unlink(rmPath).catch(() => {});
      }
    }

    await this.saveIndex();
    logger.info('Demo saved', { filename, lifetime: header.projectileLifetime, size: data.byteLength });

    return { filename, projectileLifetime: header.projectileLifetime, description: header.description };
  }

  listDemos(): DemoMeta[] {
    // Return top 10 by lifetime
    return this.index.slice(0, 10);
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
    return data.buffer as ArrayBuffer;
  }
}
