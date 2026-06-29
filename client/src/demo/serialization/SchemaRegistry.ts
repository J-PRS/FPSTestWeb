import { DemoFile } from '../types/DemoFile.js';

/**
 * Schema definition for a demo format version.
 */
export interface SchemaDefinition {
  /** Version number (major.minor.patch) */
  version: string;
  /** Format version (integer) */
  formatVersion: number;
  /** Minimum reader version that can read this format */
  minReaderVersion: number;
  /** Description of changes in this version */
  description: string;
  /** Whether this version is deprecated */
  deprecated: boolean;
}

/**
 * Migration function to convert data from one version to another.
 */
export interface MigrationFunction {
  /** Source version */
  fromVersion: number;
  /** Target version */
  toVersion: number;
  /** Migration function */
  migrate: (data: DemoFile) => DemoFile;
}

/**
 * Registry for demo format schemas and migrations.
 * Manages version compatibility and migration chains.
 */
export class SchemaRegistry {
  private schemas: Map<number, SchemaDefinition> = new Map();
  private migrations: Map<number, MigrationFunction> = new Map();
  private currentFormatVersion: number = 1;

  constructor() {
    this.registerDefaultSchemas();
  }

  /**
   * Register a schema definition.
   */
  registerSchema(schema: SchemaDefinition): void {
    this.schemas.set(schema.formatVersion, schema);
  }

  /**
   * Register a migration function.
   */
  registerMigration(migration: MigrationFunction): void {
    this.migrations.set(migration.fromVersion, migration);
  }

  /**
   * Get schema definition for a format version.
   */
  getSchema(formatVersion: number): SchemaDefinition | undefined {
    return this.schemas.get(formatVersion);
  }

  /**
   * Get migration function for a source version.
   */
  getMigration(fromVersion: number): MigrationFunction | undefined {
    return this.migrations.get(fromVersion);
  }

  /**
   * Get the current format version.
   */
  getCurrentFormatVersion(): number {
    return this.currentFormatVersion;
  }

  /**
   * Set the current format version.
   */
  setCurrentFormatVersion(version: number): void {
    this.currentFormatVersion = version;
  }

  /**
   * Check if a version is deprecated.
   */
  isDeprecated(formatVersion: number): boolean {
    const schema = this.schemas.get(formatVersion);
    return schema?.deprecated ?? false;
  }

  /**
   * Get all registered format versions.
   */
  getAllVersions(): number[] {
    return Array.from(this.schemas.keys()).sort((a, b) => a - b);
  }

  /**
   * Check if a version can be read by the current reader.
   */
  canRead(formatVersion: number): boolean {
    const schema = this.schemas.get(formatVersion);
    if (!schema) {
      return false;
    }
    return schema.minReaderVersion <= this.currentFormatVersion;
  }

  /**
   * Register default schemas for version 1.
   */
  private registerDefaultSchemas(): void {
    this.registerSchema({
      version: '1.0.0',
      formatVersion: 1,
      minReaderVersion: 1,
      description: 'Initial demo format with frame recording and keyframe events',
      deprecated: false,
    });
  }
}
