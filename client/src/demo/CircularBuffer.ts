// Generic circular buffer - fixed-size, overwrites oldest data when full.
// Zero-allocation during operation for maximum performance.

export class CircularBuffer<T> {
  private buffer: T[];
  private head = 0;
  private tail = 0;
  private count = 0;
  private capacity: number;

  constructor(capacity: number) {
    if (capacity <= 0) throw new Error('Capacity must be > 0');
    this.capacity = capacity;
    this.buffer = Array.from({ length: capacity });
  }

  get Capacity(): number { return this.capacity; }
  get Count(): number { return this.count; }
  get IsFull(): boolean { return this.count === this.capacity; }
  get IsEmpty(): boolean { return this.count === 0; }

  add(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    } else {
      this.tail = (this.tail + 1) % this.capacity;
    }
  }

  get(index: number): T {
    if (index < 0 || index >= this.count) {
      throw new Error(`Index ${index} out of range [0, ${this.count - 1}]`);
    }
    return this.buffer[(this.tail + index) % this.capacity];
  }

  // Get without bounds checking - for hot paths
  getUnsafe(index: number): T {
    return this.buffer[(this.tail + index) % this.capacity];
  }

  peekNewest(): T {
    if (this.count === 0) throw new Error('Buffer is empty');
    return this.buffer[(this.head - 1 + this.capacity) % this.capacity];
  }

  peekOldest(): T {
    if (this.count === 0) throw new Error('Buffer is empty');
    return this.buffer[this.tail];
  }

  clear(): void {
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }

  extractRange(startIndex: number, length: number): T[] {
    if (startIndex < 0 || startIndex >= this.count) {
      throw new Error(`Start index ${startIndex} out of range`);
    }
    if (length <= 0 || startIndex + length > this.count) {
      throw new Error(`Invalid length ${length} for range starting at ${startIndex}`);
    }
    const result = Array.from<T>({ length });
    for (let i = 0; i < length; i++) {
      result[i] = this.get(startIndex + i);
    }
    return result;
  }

  extractNewest(count: number): T[] {
    if (count > this.count) count = this.count;
    return this.extractRange(this.count - count, count);
  }

  extractAll(): T[] {
    const result = this.extractRange(0, this.count);
    this.clear();
    return result;
  }

  // Find index of oldest item newer than given timestamp.
  // Uses binary search since buffer items are timestamp-ordered.
  findIndexAfterTimestamp(timestamp: number, selector: (item: T) => number): number {
    if (this.count === 0) return -1;
    // Check if newest is still <= timestamp (nothing qualifies)
    if (selector(this.getUnsafe(this.count - 1)) <= timestamp) return -1;

    let lo = 0, hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (selector(this.getUnsafe(mid)) <= timestamp) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }
}
