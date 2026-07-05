/**
 * Generic circular buffer for efficient continuous recording.
 * Automatically overwrites old data when full, maintaining a fixed-size window.
 * Zero-allocation operation for maximum performance.
 */
export class CircularBuffer<T> {
  private readonly buffer: T[];
  private head: number = 0;
  private tail: number = 0;
  private count: number = 0;
  private readonly capacity: number;

  constructor(capacity: number) {
    if (capacity <= 0) {
      throw new Error('Capacity must be greater than 0');
    }
    this.capacity = capacity;
    this.buffer = new Array<T>(capacity);
  }

  /**
   * Get the buffer capacity.
   */
  getCapacity(): number {
    return this.capacity;
  }

  /**
   * Get the current number of items in the buffer.
   */
  getCount(): number {
    return this.count;
  }

  /**
   * Check if the buffer is full.
   */
  isFull(): boolean {
    return this.count === this.capacity;
  }

  /**
   * Check if the buffer is empty.
   */
  isEmpty(): boolean {
    return this.count === 0;
  }

  /**
   * Add an item to the buffer. Overwrites oldest if full.
   */
  add(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;

    if (this.count < this.capacity) {
      this.count++;
    } else {
      // Buffer is full, tail moves forward (overwrites oldest)
      this.tail = (this.tail + 1) % this.capacity;
    }
  }

  /**
   * Get item at specific index (0 = oldest, count-1 = newest).
   */
  get(index: number): T {
    if (index < 0 || index >= this.count) {
      throw new Error(`Index ${index} out of range [0, ${this.count - 1}]`);
    }

    const actualIndex = (this.tail + index) % this.capacity;
    return this.buffer[actualIndex];
  }

  /**
   * Get item without bounds checking (for performance).
   * Use only when you know the index is valid.
   */
  getUnsafe(index: number): T {
    const actualIndex = (this.tail + index) % this.capacity;
    return this.buffer[actualIndex];
  }

  /**
   * Peek at the newest item without removing it.
   */
  peekNewest(): T {
    if (this.count === 0) {
      throw new Error('Buffer is empty');
    }

    const newestIndex = (this.head - 1 + this.capacity) % this.capacity;
    return this.buffer[newestIndex];
  }

  /**
   * Peek at the oldest item without removing it.
   */
  peekOldest(): T {
    if (this.count === 0) {
      throw new Error('Buffer is empty');
    }

    return this.buffer[this.tail];
  }

  /**
   * Clear the buffer.
   */
  clear(): void {
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }

  /**
   * Extract a range of items as an array.
   * @param startIndex - Start index (0 = oldest)
   * @param length - Number of items to extract
   */
  extractRange(startIndex: number, length: number): T[] {
    if (startIndex < 0 || startIndex >= this.count) {
      throw new Error(`Start index ${startIndex} out of range`);
    }

    if (length <= 0 || startIndex + length > this.count) {
      throw new Error(`Invalid length ${length} for range starting at ${startIndex}`);
    }

    const result: T[] = new Array(length);
    for (let i = 0; i < length; i++) {
      result[i] = this.get(startIndex + i);
    }
    return result;
  }

  /**
   * Extract the newest N items.
   */
  extractNewest(count: number): T[] {
    if (count > this.count) {
      count = this.count;
    }

    return this.extractRange(this.count - count, count);
  }

  /**
   * Extract all items and clear the buffer.
   */
  extractAll(): T[] {
    const result = this.extractRange(0, this.count);
    this.clear();
    return result;
  }

  /**
   * Copy buffer contents to a target array.
   * More efficient than extractRange for large operations.
   */
  copyTo(target: T[], targetOffset: number, startIndex: number, length: number): void {
    if (target === null) {
      throw new Error('Target array cannot be null');
    }

    if (startIndex < 0 || startIndex >= this.count) {
      throw new Error(`Start index ${startIndex} out of range`);
    }

    if (length <= 0 || startIndex + length > this.count) {
      throw new Error(`Invalid length ${length} for range starting at ${startIndex}`);
    }

    if (targetOffset + length > target.length) {
      throw new Error('Target array too small');
    }

    for (let i = 0; i < length; i++) {
      target[targetOffset + i] = this.get(startIndex + i);
    }
  }

  /**
   * Get the index of the newest item that is older than a given timestamp.
   * Assumes items are added in chronological order.
   * @param timestamp - Timestamp to compare against
   * @param timestampSelector - Function to extract timestamp from T
   * @returns Index of the oldest item newer than timestamp, or -1 if none
   */
  findIndexAfterTimestamp(timestamp: number, timestampSelector: (item: T) => number): number {
    for (let i = 0; i < this.count; i++) {
      if (timestampSelector(this.getUnsafe(i)) > timestamp) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Get the index of the item closest to a given timestamp.
   * @param timestamp - Timestamp to find
   * @param timestampSelector - Function to extract timestamp from T
   * @returns Index of the closest item, or -1 if buffer is empty
   */
  findClosestTimestampIndex(timestamp: number, timestampSelector: (item: T) => number): number {
    if (this.count === 0) {
      return -1;
    }

    let closestIndex = 0;
    let closestDiff = Math.abs(timestampSelector(this.getUnsafe(0)) - timestamp);

    for (let i = 1; i < this.count; i++) {
      const diff = Math.abs(timestampSelector(this.getUnsafe(i)) - timestamp);
      if (diff < closestDiff) {
        closestDiff = diff;
        closestIndex = i;
      }
    }

    return closestIndex;
  }
}
