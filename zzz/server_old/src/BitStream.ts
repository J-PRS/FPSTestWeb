/**
 * BitStream - Bit-level packing for efficient network communication
 * Based on Tribes 2 networking model for bandwidth optimization
 * 
 * Allows writing/reading individual bits and variable-length integers
 * to minimize packet size for real-time multiplayer games
 */

export class BitStream {
  private data: Uint8Array;
  private bitPosition: number = 0;
  private byteLength: number;

  constructor(initialSize: number = 256) {
    this.data = new Uint8Array(initialSize);
    this.byteLength = initialSize;
  }

  /**
   * Ensure the buffer has enough capacity for the next write operation
   */
  private ensureCapacity(bitsNeeded: number): void {
    const bytesNeeded = Math.ceil((this.bitPosition + bitsNeeded) / 8);
    if (bytesNeeded > this.byteLength) {
      const newSize = Math.max(this.byteLength * 2, bytesNeeded);
      const newData = new Uint8Array(newSize);
      newData.set(this.data);
      this.data = newData;
      this.byteLength = newSize;
    }
  }

  /**
   * Write a single bit
   */
  writeBit(bit: number): void {
    this.ensureCapacity(1);
    const byteIndex = Math.floor(this.bitPosition / 8);
    const bitIndex = this.bitPosition % 8;
    
    if (bit) {
      this.data[byteIndex] |= (1 << bitIndex);
    } else {
      this.data[byteIndex] &= ~(1 << bitIndex);
    }
    
    this.bitPosition++;
  }

  /**
   * Read a single bit
   */
  readBit(): number {
    const byteIndex = Math.floor(this.bitPosition / 8);
    const bitIndex = this.bitPosition % 8;
    
    if (byteIndex >= this.byteLength) {
      throw new Error('BitStream overflow');
    }
    
    const bit = (this.data[byteIndex] >> bitIndex) & 1;
    this.bitPosition++;
    return bit;
  }

  /**
   * Write a boolean as a single bit
   */
  writeBool(value: boolean): void {
    this.writeBit(value ? 1 : 0);
  }

  /**
   * Read a boolean from a single bit
   */
  readBool(): boolean {
    return this.readBit() === 1;
  }

  /**
   * Write an unsigned integer using specified number of bits
   */
  writeInt(value: number, bits: number): void {
    if (bits < 0 || bits > 32) {
      throw new Error(`Invalid bit count: ${bits}`);
    }
    
    // Handle 32-bit case specially since (1 << 32) = 0 in JavaScript
    const maxValue = bits === 32 ? 0xFFFFFFFF : (1 << bits) - 1;
    if (value < 0 || value > maxValue) {
      throw new Error(`Value ${value} out of range for ${bits} bits (max: ${maxValue})`);
    }
    
    for (let i = 0; i < bits; i++) {
      this.writeBit((value >> i) & 1);
    }
  }

  /**
   * Read an unsigned integer using specified number of bits
   */
  readInt(bits: number): number {
    if (bits < 0 || bits > 32) {
      throw new Error(`Invalid bit count: ${bits}`);
    }
    
    let value = 0;
    for (let i = 0; i < bits; i++) {
      value |= (this.readBit() << i);
    }
    return value;
  }

  /**
   * Write a signed integer using specified number of bits
   * Uses two's complement for negative values
   */
  writeSignedInt(value: number, bits: number): void {
    if (bits < 0 || bits > 32) {
      throw new Error(`Invalid bit count: ${bits}`);
    }

    // Use Math.pow to avoid JavaScript's 32-bit bitwise overflow
    const maxValue = Math.pow(2, bits - 1) - 1;
    const minValue = -Math.pow(2, bits - 1);

    if (value < minValue || value > maxValue) {
      throw new Error("Value " + value + " out of range for " + bits + " signed bits (min: " + minValue + ", max: " + maxValue + ")");
    }
    
    // Convert to unsigned representation
    if (value < 0) {
      value = (1 << bits) + value;
    }
    
    this.writeInt(value, bits);
  }

  /**
   * Read a signed integer using specified number of bits
   */
  readSignedInt(bits: number): number {
    const unsigned = this.readInt(bits);
    const maxValue = (1 << (bits - 1)) - 1;
    
    // Check if negative (two's complement)
    if (unsigned > maxValue) {
      return unsigned - (1 << bits);
    }
    return unsigned;
  }

  /**
   * Write a normalized float (0-1) using specified bits
   * Compresses float to integer range for efficient transmission
   */
  writeFloatNormalized(value: number, bits: number): void {
    if (value < 0 || value > 1) {
      throw new Error(`Normalized float must be between 0 and 1, got ${value}`);
    }
    
    const compressed = Math.floor(value * ((1 << bits) - 1));
    this.writeInt(compressed, bits);
  }

  /**
   * Read a normalized float (0-1) from specified bits
   */
  readFloatNormalized(bits: number): number {
    const compressed = this.readInt(bits);
    return compressed / ((1 << bits) - 1);
  }

  /**
   * Write a float in a specified range using specified bits
   * Useful for angles, positions, etc. with known ranges
   */
  writeFloatRanged(value: number, min: number, max: number, bits: number): void {
    if (value < min || value > max) {
      throw new Error(`Value ${value} out of range [${min}, ${max}]`);
    }
    
    const normalized = (value - min) / (max - min);
    this.writeFloatNormalized(normalized, bits);
  }

  /**
   * Read a float in a specified range from specified bits
   */
  readFloatRanged(min: number, max: number, bits: number): number {
    const normalized = this.readFloatNormalized(bits);
    return min + normalized * (max - min);
  }

  /**
   * Write a string with length prefix
   * Uses UTF-8 encoding
   */
  writeString(str: string): void {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(str);
    
    // Write length as variable-length integer (up to 2 bytes for now)
    if (bytes.length < 128) {
      this.writeInt(bytes.length, 7);
    } else {
      this.writeInt(1, 1); // Flag for extended length
      this.writeInt(bytes.length, 15);
    }
    
    // Write bytes
    this.ensureCapacity(bytes.length * 8);
    for (const byte of bytes) {
      this.writeInt(byte, 8);
    }
  }

  /**
   * Read a string with length prefix
   */
  readString(): string {
    // Read length
    const flag = this.readBit();
    let length: number;
    
    if (flag === 0) {
      length = this.readInt(6);
    } else {
      length = this.readInt(15);
    }
    
    // Read bytes
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      bytes[i] = this.readInt(8);
    }
    
    const decoder = new TextDecoder();
    return decoder.decode(bytes);
  }

  /**
   * Write raw bytes
   */
  writeBytes(bytes: Uint8Array): void {
    this.writeInt(bytes.length, 16);
    this.ensureCapacity(bytes.length * 8);
    for (const byte of bytes) {
      this.writeInt(byte, 8);
    }
  }

  /**
   * Read raw bytes
   */
  readBytes(): Uint8Array {
    const length = this.readInt(16);
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      bytes[i] = this.readInt(8);
    }
    return bytes;
  }

  /**
   * Write a 32-bit float
   */
  writeFloat32(value: number): void {
    this.ensureCapacity(32);
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true); // little-endian
    const bytes = new Uint8Array(view.buffer);
    for (let i = 0; i < 4; i++) {
      this.writeInt(bytes[i], 8);
    }
  }

  /**
   * Read a 32-bit float
   */
  readFloat32(): number {
    const bytes = new Uint8Array(4);
    for (let i = 0; i < 4; i++) {
      bytes[i] = this.readInt(8);
    }
    const view = new DataView(bytes.buffer);
    return view.getFloat32(0, true); // little-endian
  }

  /**
   * Align to next byte boundary
   * Useful when mixing bit-packing with byte-aligned data
   */
  alignToByte(): void {
    const bitsRemaining = this.bitPosition % 8;
    if (bitsRemaining !== 0) {
      this.bitPosition += (8 - bitsRemaining);
    }
  }

  /**
   * Get the current bit position
   */
  getBitPosition(): number {
    return this.bitPosition;
  }

  /**
   * Set the current bit position (for rewinding)
   */
  setBitPosition(position: number): void {
    if (position < 0 || position > this.byteLength * 8) {
      throw new Error(`Invalid bit position: ${position}`);
    }
    this.bitPosition = position;
  }

  /**
   * Get the current byte length (rounded up)
   */
  getByteLength(): number {
    return Math.ceil(this.bitPosition / 8);
  }

  /**
   * Check if there's data remaining to read
   */
  hasData(): boolean {
    return this.bitPosition < this.byteLength * 8;
  }

  /**
   * Check if there's space for more data
   */
  hasSpace(bitsNeeded: number): boolean {
    const bytesNeeded = Math.ceil((this.bitPosition + bitsNeeded) / 8);
    return bytesNeeded <= this.byteLength;
  }

  /**
   * Get the underlying data as a Uint8Array
   * Only includes used bytes
   */
  getData(): Uint8Array {
    const byteLength = this.getByteLength();
    return this.data.slice(0, byteLength);
  }

  /**
   * Reset the stream for reuse
   */
  reset(): void {
    this.bitPosition = 0;
    // Clear data
    this.data.fill(0);
  }

  /**
   * Set data for reading (creates a new BitStream for reading)
   */
  static fromBuffer(buffer: Uint8Array): BitStream {
    const stream = new BitStream(buffer.length);
    stream.data = new Uint8Array(buffer);
    stream.byteLength = buffer.length;
    stream.bitPosition = 0;
    return stream;
  }
}

/**
 * Simple Huffman-like compression for frequently used strings
 * Can be extended with actual Huffman coding for better compression
 */
export class StringCompressor {
  private dictionary: Map<string, number> = new Map();
  private reverseDictionary: Map<number, string> = new Map();
  private nextId: number = 1;

  /**
   * Add a string to the dictionary
   */
  addString(str: string): void {
    if (!this.dictionary.has(str)) {
      const id = this.nextId++;
      this.dictionary.set(str, id);
      this.reverseDictionary.set(id, str);
    }
  }

  /**
   * Compress a string using the dictionary
   * Returns the ID if in dictionary, otherwise the string
   */
  compress(str: string, stream: BitStream): void {
    const id = this.dictionary.get(str);
    if (id !== undefined) {
      stream.writeBool(true); // Flag: compressed
      stream.writeInt(id, 16);
    } else {
      stream.writeBool(false); // Flag: not compressed
      stream.writeString(str);
    }
  }

  /**
   * Decompress a string from the stream
   */
  decompress(stream: BitStream): string {
    const compressed = stream.readBool();
    if (compressed) {
      const id = stream.readInt(16);
      const str = this.reverseDictionary.get(id);
      if (str === undefined) {
        throw new Error(`Unknown string ID: ${id}`);
      }
      return str;
    } else {
      return stream.readString();
    }
  }
}
