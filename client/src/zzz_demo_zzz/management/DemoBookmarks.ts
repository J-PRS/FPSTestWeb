/**
 * Demo bookmark for quick navigation.
 */
export interface DemoBookmark {
  /** Bookmark ID */
  id: string;
  /** Bookmark name */
  name: string;
  /** Timestamp in demo */
  timestamp: number;
  /** Description */
  description: string;
  /** Color for UI */
  color: string;
  /** Created at */
  createdAt: number;
}

/**
 * Demo bookmarking system.
 * Allows users to mark interesting moments in demos for quick navigation.
 */
export class DemoBookmarks {
  private bookmarks: Map<string, DemoBookmark> = new Map();
  private nextId: number = 1;

  /**
   * Add a bookmark.
   * @param timestamp - Timestamp in demo
   * @param name - Bookmark name
   * @param description - Optional description
   * @param color - Optional color
   * @returns Bookmark ID
   */
  addBookmark(
    timestamp: number,
    name: string,
    description: string = '',
    color: string = '#ff0000'
  ): string {
    const id = `bookmark_${this.nextId++}`;
    const bookmark: DemoBookmark = {
      id,
      name,
      timestamp,
      description,
      color,
      createdAt: Date.now(),
    };

    this.bookmarks.set(id, bookmark);
    return id;
  }

  /**
   * Remove a bookmark.
   * @param id - Bookmark ID
   */
  removeBookmark(id: string): void {
    this.bookmarks.delete(id);
  }

  /**
   * Get a bookmark by ID.
   * @param id - Bookmark ID
   * @returns Bookmark or undefined
   */
  getBookmark(id: string): DemoBookmark | undefined {
    return this.bookmarks.get(id);
  }

  /**
   * Get all bookmarks.
   * @returns Array of bookmarks sorted by timestamp
   */
  getAllBookmarks(): DemoBookmark[] {
    return Array.from(this.bookmarks.values()).sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Get bookmarks in a time range.
   * @param startTime - Start time
   * @param endTime - End time
   * @returns Array of bookmarks in range
   */
  getBookmarksInRange(startTime: number, endTime: number): DemoBookmark[] {
    return this.getAllBookmarks().filter(
      (b) => b.timestamp >= startTime && b.timestamp <= endTime
    );
  }

  /**
   * Find the nearest bookmark to a timestamp.
   * @param timestamp - Target timestamp
   * @returns Nearest bookmark or undefined
   */
  findNearestBookmark(timestamp: number): DemoBookmark | undefined {
    const bookmarks = this.getAllBookmarks();
    if (bookmarks.length === 0) {
      return undefined;
    }

    let nearest = bookmarks[0];
    let minDiff = Math.abs(bookmarks[0].timestamp - timestamp);

    for (const bookmark of bookmarks) {
      const diff = Math.abs(bookmark.timestamp - timestamp);
      if (diff < minDiff) {
        minDiff = diff;
        nearest = bookmark;
      }
    }

    return nearest;
  }

  /**
   * Update a bookmark.
   * @param id - Bookmark ID
   * @param updates - Partial bookmark data to update
   */
  updateBookmark(id: string, updates: Partial<DemoBookmark>): void {
    const bookmark = this.bookmarks.get(id);
    if (bookmark) {
      this.bookmarks.set(id, { ...bookmark, ...updates });
    }
  }

  /**
   * Clear all bookmarks.
   */
  clearBookmarks(): void {
    this.bookmarks.clear();
    this.nextId = 1;
  }

  /**
   * Export bookmarks to JSON.
   * @returns JSON string
   */
  exportToJSON(): string {
    const bookmarks = this.getAllBookmarks();
    return JSON.stringify(bookmarks, null, 2);
  }

  /**
   * Import bookmarks from JSON.
   * @param json - JSON string
   */
  importFromJSON(json: string): void {
    try {
      const bookmarks: DemoBookmark[] = JSON.parse(json);
      this.clearBookmarks();

      for (const bookmark of bookmarks) {
        this.bookmarks.set(bookmark.id, bookmark);
        const idNum = parseInt(bookmark.id.replace('bookmark_', ''), 10);
        if (idNum >= this.nextId) {
          this.nextId = idNum + 1;
        }
      }
    } catch (e) {
      console.error('[DemoBookmarks] Failed to import bookmarks:', e);
    }
  }

  /**
   * Get bookmark count.
   * @returns Number of bookmarks
   */
  getCount(): number {
    return this.bookmarks.size;
  }
}
