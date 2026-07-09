/**
 * CRC32 checksum calculation for demo file integrity.
 * Uses the standard CRC32 polynomial (0xEDB88320).
 */
export class CRC32 {
  private static readonly TABLE: number[] = CRC32.generateTable();

  /**
   * Generate CRC32 lookup table.
   */
  private static generateTable(): number[] {
    const table: number[] = new Array(256);
    for (let i = 0; i < 256; i++) {
      let crc = i;
      for (let j = 0; j < 8; j++) {
        crc = crc & 1 ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1;
      }
      table[i] = crc;
    }
    return table;
  }

  /**
   * Calculate CRC32 checksum for a byte array.
   * @param data - Byte array to checksum
   * @returns CRC32 checksum
   */
  static calculate(data: Uint8Array): number {
    let crc = 0xFFFFFFFF;

    for (let i = 0; i < data.length; i++) {
      crc = (crc >>> 8) ^ CRC32.TABLE[(crc ^ data[i]) & 0xFF];
    }

    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  /**
   * Calculate CRC32 checksum for a string.
   * @param str - String to checksum
   * @returns CRC32 checksum
   */
  static calculateString(str: string): number {
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    return CRC32.calculate(data);
  }

  /**
   * Verify CRC32 checksum.
   * @param data - Byte array to verify
   * @param expectedChecksum - Expected checksum
   * @returns True if checksum matches
   */
  static verify(data: Uint8Array, expectedChecksum: number): boolean {
    const calculated = CRC32.calculate(data);
    return calculated === expectedChecksum;
  }
}
