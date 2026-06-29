/**
 * Simple compression for demo files.
 * Uses run-length encoding for frame data compression.
 */
export class DemoCompressor {
  /**
   * Compress a byte array using run-length encoding.
   * @param data - Byte array to compress
   * @returns Compressed byte array
   */
  static compress(data: Uint8Array): Uint8Array {
    if (data.length === 0) {
      return data;
    }

    const compressed: number[] = [];
    let i = 0;

    while (i < data.length) {
      const value = data[i];
      let count = 1;

      // Count consecutive identical bytes
      while (i + count < data.length && data[i + count] === value && count < 255) {
        count++;
      }

      // If we have a run of 3 or more, use RLE
      if (count >= 3) {
        compressed.push(0xFF); // RLE marker
        compressed.push(value);
        compressed.push(count);
        i += count;
      } else {
        // Otherwise, copy as-is
        compressed.push(value);
        i++;
      }
    }

    return new Uint8Array(compressed);
  }

  /**
   * Decompress a run-length encoded byte array.
   * @param data - Compressed byte array
   * @returns Decompressed byte array
   */
  static decompress(data: Uint8Array): Uint8Array {
    if (data.length === 0) {
      return data;
    }

    const decompressed: number[] = [];
    let i = 0;

    while (i < data.length) {
      if (data[i] === 0xFF && i + 2 < data.length) {
        // RLE marker found
        const value = data[i + 1];
        const count = data[i + 2];

        for (let j = 0; j < count; j++) {
          decompressed.push(value);
        }

        i += 3;
      } else {
        // Literal byte
        decompressed.push(data[i]);
        i++;
      }
    }

    return new Uint8Array(decompressed);
  }

  /**
   * Calculate compression ratio.
   * @param original - Original data
   * @param compressed - Compressed data
   * @returns Compression ratio (0-1, lower is better)
   */
  static getCompressionRatio(original: Uint8Array, compressed: Uint8Array): number {
    if (original.length === 0) {
      return 0;
    }
    return compressed.length / original.length;
  }

  /**
   * Estimate if compression will be beneficial.
   * @param data - Data to check
   * @returns True if compression is likely to reduce size
   */
  static shouldCompress(data: Uint8Array): boolean {
    if (data.length < 100) {
      return false; // Too small to benefit
    }

    // Check for repeated patterns
    let repeatedBytes = 0;
    for (let i = 1; i < data.length; i++) {
      if (data[i] === data[i - 1]) {
        repeatedBytes++;
      }
    }

    // If more than 10% of bytes are repeated, compression is likely beneficial
    return repeatedBytes / data.length > 0.1;
  }
}
