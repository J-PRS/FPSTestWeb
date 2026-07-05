import { DemoFile } from '../types/DemoFile.js';
import { DemoSerializer } from '../serialization/DemoSerializer.js';

/**
 * Export formats for demo files.
 */
export enum ExportFormat {
  Binary = 'binary',
  JSON = 'json',
  CSV = 'csv',
}

/**
 * Export options.
 */
export interface ExportOptions {
  format: ExportFormat;
  includeEvents: boolean;
  includeFrames: boolean;
  compress: boolean;
}

/**
 * Import demo from external format.
 */
export interface ImportOptions {
  format: ExportFormat;
  validate: boolean;
  migrate: boolean;
}

/**
 * Demo export and import utilities.
 * Supports multiple formats for sharing and analysis.
 */
export class DemoExporter {
  /**
   * Export a demo file to a specific format.
   * @param demo - Demo file to export
   * @param options - Export options
   * @returns Exported data as string or Uint8Array
   */
  static export(demo: DemoFile, options: ExportOptions): string | Uint8Array {
    switch (options.format) {
      case ExportFormat.Binary:
        return DemoExporter.exportBinary(demo, options.compress);
      case ExportFormat.JSON:
        return DemoExporter.exportJSON(demo, options.includeEvents, options.includeFrames);
      case ExportFormat.CSV:
        return DemoExporter.exportCSV(demo);
      default:
        throw new Error(`Unsupported export format: ${options.format}`);
    }
  }

  /**
   * Export to binary format.
   * @param demo - Demo file
   * @param compress - Whether to compress
   * @returns Binary data
   */
  private static exportBinary(demo: DemoFile, compress: boolean): Uint8Array {
    const data = DemoSerializer.serialize(demo);

    if (compress) {
      // Compression is optional, skip for now to avoid dynamic import issues
      // In production, use: import('../serialization/DemoCompressor.js').then(m => m.DemoCompressor.compress(data))
      return data;
    }

    return data;
  }

  /**
   * Export to JSON format.
   * @param demo - Demo file
   * @param includeEvents - Whether to include events
   * @param includeFrames - Whether to include frames
   * @returns JSON string
   */
  private static exportJSON(demo: DemoFile, includeEvents: boolean, includeFrames: boolean): string {
    const exportData: any = {
      header: demo.header,
      playerStartPosition: demo.playerStartPosition,
      playerStartRotation: demo.playerStartRotation,
      playerStartVelocity: demo.playerStartVelocity,
    };

    if (includeEvents) {
      exportData.projectileEvents = demo.projectileEvents;
      exportData.targetEvents = demo.targetEvents;
    }

    if (includeFrames) {
      exportData.frames = demo.frames;
    }

    return JSON.stringify(exportData, null, 2);
  }

  /**
   * Export to CSV format (events only).
   * @param demo - Demo file
   * @returns CSV string
   */
  private static exportCSV(demo: DemoFile): string {
    const lines: string[] = [];

    // Header
    lines.push('type,timestamp,id,x,y,z,vx,vy,vz');

    // Projectile events
    for (const event of demo.projectileEvents) {
      lines.push(
        `projectile,${event.timestamp.toFixed(3)},${event.projectileId},` +
        `${event.position.x.toFixed(2)},${event.position.y.toFixed(2)},${event.position.z.toFixed(2)},` +
        `${event.velocity.x.toFixed(2)},${event.velocity.y.toFixed(2)},${event.velocity.z.toFixed(2)}`
      );
    }

    // Target events
    for (const event of demo.targetEvents) {
      lines.push(
        `target,${event.timestamp.toFixed(3)},${event.targetId},` +
        `${event.position.x.toFixed(2)},${event.position.y.toFixed(2)},${event.position.z.toFixed(2)},` +
        `${event.velocity.x.toFixed(2)},${event.velocity.y.toFixed(2)},${event.velocity.z.toFixed(2)}`
      );
    }

    return lines.join('\n');
  }

  /**
   * Import a demo file from data.
   * @param data - Data to import
   * @param options - Import options
   * @returns Demo file
   */
  static async import(data: string | Uint8Array, options: ImportOptions): Promise<DemoFile> {
    switch (options.format) {
      case ExportFormat.Binary:
        return DemoExporter.importBinary(data as Uint8Array, options.validate, options.migrate);
      case ExportFormat.JSON:
        return DemoExporter.importJSON(data as string, options.validate);
      case ExportFormat.CSV:
        throw new Error('CSV import not supported');
      default:
        throw new Error(`Unsupported import format: ${options.format}`);
    }
  }

  /**
   * Import from binary format.
   * @param data - Binary data
   * @param validate - Whether to validate
   * @param migrate - Whether to migrate
   * @returns Demo file
   */
  private static async importBinary(data: Uint8Array, validate: boolean, migrate: boolean): Promise<DemoFile> {
    // Skip decompression for now to avoid dynamic import issues
    let demo = DemoSerializer.deserialize(data);

    if (validate) {
      const { DemoValidator } = await import('../serialization/DemoValidator.js');
      const result = DemoValidator.validate(demo);
      if (!result.isValid) {
        console.error('[DemoExporter] Validation failed:', result.errors);
        throw new Error('Demo validation failed');
      }
    }

    if (migrate) {
      const { VersionManager } = await import('../serialization/VersionManager.js');
      const { SchemaRegistry } = await import('../serialization/SchemaRegistry.js');
      const registry = new SchemaRegistry();
      const versionManager = new VersionManager(registry);

      if (versionManager.needsMigration(demo)) {
        demo = versionManager.migrateToCurrent(demo);
      }
    }

    return demo;
  }

  /**
   * Import from JSON format.
   * @param data - JSON string
   * @param validate - Whether to validate
   * @returns Demo file
   */
  private static async importJSON(data: string, validate: boolean): Promise<DemoFile> {
    const parsed = JSON.parse(data);

    const demo: DemoFile = {
      header: parsed.header,
      frames: parsed.frames || [],
      projectileEvents: parsed.projectileEvents || [],
      targetEvents: parsed.targetEvents || [],
      playerStartPosition: parsed.playerStartPosition,
      playerStartRotation: parsed.playerStartRotation,
      playerStartVelocity: parsed.playerStartVelocity,
    };

    if (validate) {
      const { DemoValidator } = await import('../serialization/DemoValidator.js');
      const result = DemoValidator.validate(demo);
      if (!result.isValid) {
        console.error('[DemoExporter] Validation failed:', result.errors);
        throw new Error('Demo validation failed');
      }
    }

    return demo;
  }

  /**
   * Export demo as a downloadable file.
   * @param demo - Demo file
   * @param filename - Output filename
   * @param options - Export options
   */
  static async download(demo: DemoFile, filename: string, options: ExportOptions): Promise<void> {
    const data = DemoExporter.export(demo, options);
    const mimeType = options.format === ExportFormat.Binary ? 'application/octet-stream' : 'text/plain';

    let blob: Blob;
    if (data instanceof Uint8Array) {
      blob = new Blob([data.buffer.slice(0) as ArrayBuffer], { type: mimeType });
    } else {
      blob = new Blob([data], { type: mimeType });
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Get file extension for export format.
   * @param format - Export format
   * @returns File extension
   */
  static getFileExtension(format: ExportFormat): string {
    switch (format) {
      case ExportFormat.Binary:
        return '.demo';
      case ExportFormat.JSON:
        return '.json';
      case ExportFormat.CSV:
        return '.csv';
      default:
        return '.demo';
    }
  }
}
