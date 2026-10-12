// Binary serializer for demo files.
// Uses DataView for efficient binary read/write.
// Format: magic(1) + version(4) + header fields + frames + events

import type { DemoFile } from './types.js';
import { serializeDemo } from './demoWriter.js';
import { deserializeDemo } from './demoReader.js';

// Facade — the codec halves live in demoWriter.ts (record encoders,
// crc32, record sizes) and demoReader.ts (bounds-checked cursor).
// oxlint-disable-next-line no-namespace -- grouped statics are the public API shape
export namespace DemoSerializer {
  export function serialize(data: DemoFile): ArrayBuffer {
    return serializeDemo(data);
  }

  export function deserialize(buffer: ArrayBuffer): DemoFile {
    return deserializeDemo(buffer);
  }

  // Serialize to Blob for file download
  export function toBlob(data: DemoFile): Blob {
    const buffer = serialize(data);
    return new Blob([buffer], { type: 'application/octet-stream' });
  }
}
