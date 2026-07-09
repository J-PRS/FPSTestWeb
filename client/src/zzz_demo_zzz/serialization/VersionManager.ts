import { DemoFile } from '../types/DemoFile.js';
import { SchemaRegistry, MigrationFunction } from './SchemaRegistry.js';

/**
 * Manages version migration for demo files.
 * Handles automatic migration from older versions to current version.
 */
export class VersionManager {
  private registry: SchemaRegistry;

  constructor(registry: SchemaRegistry) {
    this.registry = registry;
  }

  /**
   * Migrate a demo file to the target version.
   * @param demo - Demo file to migrate
   * @param targetVersion - Target format version
   * @returns Migrated demo file
   */
  migrate(demo: DemoFile, targetVersion: number): DemoFile {
    let current = demo;
    const sourceVersion = current.header.formatVersion;

    if (sourceVersion === targetVersion) {
      return current; // No migration needed
    }

    if (sourceVersion > targetVersion) {
      // Downgrade - not supported, return as-is
      console.warn(
        `[VersionManager] Cannot downgrade from v${sourceVersion} to v${targetVersion}`
      );
      return current;
    }

    // Upgrade through migration chain
    while (current.header.formatVersion < targetVersion) {
      const migration = this.registry.getMigration(current.header.formatVersion);

      if (!migration) {
        console.warn(
          `[VersionManager] No migration found from v${current.header.formatVersion}`
        );
        break;
      }

      if (migration.toVersion > targetVersion) {
        // Migration would overshoot target
        break;
      }

      current = migration.migrate(current);
      current.header.formatVersion = migration.toVersion;
    }

    return current;
  }

  /**
   * Migrate a demo file to the current version.
   * @param demo - Demo file to migrate
   * @returns Migrated demo file
   */
  migrateToCurrent(demo: DemoFile): DemoFile {
    return this.migrate(demo, this.registry.getCurrentFormatVersion());
  }

  /**
   * Check if a demo file needs migration.
   * @param demo - Demo file to check
   * @returns True if migration is needed
   */
  needsMigration(demo: DemoFile): boolean {
    return demo.header.formatVersion !== this.registry.getCurrentFormatVersion();
  }

  /**
   * Check if a demo file can be read by the current version.
   * @param demo - Demo file to check
   * @returns True if readable
   */
  canRead(demo: DemoFile): boolean {
    return this.registry.canRead(demo.header.formatVersion);
  }

  /**
   * Get the minimum reader version for a demo file.
   * @param demo - Demo file to check
   * @returns Minimum reader version
   */
  getMinReaderVersion(demo: DemoFile): number {
    const schema = this.registry.getSchema(demo.header.formatVersion);
    return schema?.minReaderVersion ?? 1;
  }

  /**
   * Register a custom migration function.
   * @param migration - Migration function to register
   */
  registerMigration(migration: MigrationFunction): void {
    this.registry.registerMigration(migration);
  }

  /**
   * Get the schema registry.
   */
  getRegistry(): SchemaRegistry {
    return this.registry;
  }
}
