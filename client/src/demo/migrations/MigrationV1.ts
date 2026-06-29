import { DemoFile } from '../types/DemoFile.js';
import { MigrationFunction } from '../serialization/SchemaRegistry.js';

/**
 * Migration from version 1 to version 2.
 * Example migration that adds a new field to the header.
 * 
 * Version 1: Initial format
 * Version 2: Added mapName field to header
 */
export const MigrationV1ToV2: MigrationFunction = {
  fromVersion: 1,
  toVersion: 2,
  migrate: (demo: DemoFile): DemoFile => {
    // Add new field with default value
    demo.header = {
      ...demo.header,
      // @ts-ignore - Adding new field that doesn't exist in v1
      mapName: 'Unknown',
    };

    // Update format version
    demo.header.formatVersion = 2;

    console.log('[MigrationV1ToV2] Migrated demo from v1 to v2');
    return demo;
  },
};

/**
 * Migration from version 2 to version 1 (downgrade).
 * Removes the mapName field.
 */
export const MigrationV2ToV1: MigrationFunction = {
  fromVersion: 2,
  toVersion: 1,
  migrate: (demo: DemoFile): DemoFile => {
    // Remove new field
    const { mapName, ...headerWithoutMapName } = demo.header as any;
    demo.header = headerWithoutMapName;

    // Update format version
    demo.header.formatVersion = 1;

    console.log('[MigrationV2ToV1] Migrated demo from v2 to v1');
    return demo;
  },
};
