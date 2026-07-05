/**
 * Demo playlist item.
 */
export interface PlaylistItem {
  /** Demo ID */
  demoId: string;
  /** Demo name */
  name: string;
  /** Order in playlist */
  order: number;
  /** Duration */
  duration: number;
  /** Thumbnail URL (optional) */
  thumbnail?: string;
}

/**
 * Demo playlist.
 */
export interface DemoPlaylist {
  /** Playlist ID */
  id: string;
  /** Playlist name */
  name: string;
  /** Description */
  description: string;
  /** Items */
  items: PlaylistItem[];
  /** Created at */
  createdAt: number;
  /** Updated at */
  updatedAt: number;
  /** Whether to loop */
  loop: boolean;
  /** Whether to shuffle */
  shuffle: boolean;
}

/**
 * Demo playlist system.
 * Organize demos into playlists for sequential playback.
 */
export class DemoPlaylistManager {
  private playlists: Map<string, DemoPlaylist> = new Map();
  private nextId: number = 1;

  /**
   * Create a new playlist.
   * @param name - Playlist name
   * @param description - Description
   * @returns Playlist ID
   */
  createPlaylist(name: string, description: string = ''): string {
    const id = `playlist_${this.nextId++}`;
    const playlist: DemoPlaylist = {
      id,
      name,
      description,
      items: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      loop: false,
      shuffle: false,
    };

    this.playlists.set(id, playlist);
    return id;
  }

  /**
   * Delete a playlist.
   * @param id - Playlist ID
   */
  deletePlaylist(id: string): void {
    this.playlists.delete(id);
  }

  /**
   * Get a playlist by ID.
   * @param id - Playlist ID
   * @returns Playlist or undefined
   */
  getPlaylist(id: string): DemoPlaylist | undefined {
    return this.playlists.get(id);
  }

  /**
   * Get all playlists.
   * @returns Array of playlists
   */
  getAllPlaylists(): DemoPlaylist[] {
    return Array.from(this.playlists.values()).sort((a, b) => a.updatedAt - b.updatedAt);
  }

  /**
   * Add a demo to a playlist.
   * @param playlistId - Playlist ID
   * @param demoId - Demo ID
   * @param name - Demo name
   * @param duration - Demo duration
   * @param thumbnail - Optional thumbnail URL
   */
  addItem(
    playlistId: string,
    demoId: string,
    name: string,
    duration: number,
    thumbnail?: string
  ): void {
    const playlist = this.playlists.get(playlistId);
    if (!playlist) {
      return;
    }

    const item: PlaylistItem = {
      demoId,
      name,
      order: playlist.items.length,
      duration,
      thumbnail,
    };

    playlist.items.push(item);
    playlist.updatedAt = Date.now();
  }

  /**
   * Remove an item from a playlist.
   * @param playlistId - Playlist ID
   * @param demoId - Demo ID
   */
  removeItem(playlistId: string, demoId: string): void {
    const playlist = this.playlists.get(playlistId);
    if (!playlist) {
      return;
    }

    playlist.items = playlist.items.filter((item) => item.demoId !== demoId);
    this.reorderItems(playlistId);
    playlist.updatedAt = Date.now();
  }

  /**
   * Reorder items in a playlist.
   * @param playlistId - Playlist ID
   */
  private reorderItems(playlistId: string): void {
    const playlist = this.playlists.get(playlistId);
    if (!playlist) {
      return;
    }

    playlist.items.forEach((item, index) => {
      item.order = index;
    });
  }

  /**
   * Move an item to a new position.
   * @param playlistId - Playlist ID
   * @param demoId - Demo ID
   * @param newOrder - New order position
   */
  moveItem(playlistId: string, demoId: string, newOrder: number): void {
    const playlist = this.playlists.get(playlistId);
    if (!playlist) {
      return;
    }

    const itemIndex = playlist.items.findIndex((item) => item.demoId === demoId);
    if (itemIndex === -1) {
      return;
    }

    const [item] = playlist.items.splice(itemIndex, 1);
    playlist.items.splice(newOrder, 0, item);
    this.reorderItems(playlistId);
    playlist.updatedAt = Date.now();
  }

  /**
   * Set playlist loop mode.
   * @param playlistId - Playlist ID
   * @param loop - Whether to loop
   */
  setLoop(playlistId: string, loop: boolean): void {
    const playlist = this.playlists.get(playlistId);
    if (playlist) {
      playlist.loop = loop;
      playlist.updatedAt = Date.now();
    }
  }

  /**
   * Set playlist shuffle mode.
   * @param playlistId - Playlist ID
   * @param shuffle - Whether to shuffle
   */
  setShuffle(playlistId: string, shuffle: boolean): void {
    const playlist = this.playlists.get(playlistId);
    if (playlist) {
      playlist.shuffle = shuffle;
      playlist.updatedAt = Date.now();
    }
  }

  /**
   * Get shuffled items for a playlist.
   * @param playlistId - Playlist ID
   * @returns Shuffled items
   */
  getShuffledItems(playlistId: string): PlaylistItem[] {
    const playlist = this.playlists.get(playlistId);
    if (!playlist) {
      return [];
    }

    const shuffled = [...playlist.items];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    return shuffled;
  }

  /**
   * Get total duration of a playlist.
   * @param playlistId - Playlist ID
   * @returns Total duration in seconds
   */
  getTotalDuration(playlistId: string): number {
    const playlist = this.playlists.get(playlistId);
    if (!playlist) {
      return 0;
    }

    return playlist.items.reduce((sum, item) => sum + item.duration, 0);
  }

  /**
   * Update playlist metadata.
   * @param playlistId - Playlist ID
   * @param updates - Partial playlist data
   */
  updatePlaylist(playlistId: string, updates: Partial<DemoPlaylist>): void {
    const playlist = this.playlists.get(playlistId);
    if (playlist) {
      this.playlists.set(playlistId, {
        ...playlist,
        ...updates,
        updatedAt: Date.now(),
      });
    }
  }

  /**
   * Export playlists to JSON.
   * @returns JSON string
   */
  exportToJSON(): string {
    const playlists = this.getAllPlaylists();
    return JSON.stringify(playlists, null, 2);
  }

  /**
   * Import playlists from JSON.
   * @param json - JSON string
   */
  importFromJSON(json: string): void {
    try {
      const playlists: DemoPlaylist[] = JSON.parse(json);
      this.playlists.clear();

      for (const playlist of playlists) {
        this.playlists.set(playlist.id, playlist);
        const idNum = parseInt(playlist.id.replace('playlist_', ''), 10);
        if (idNum >= this.nextId) {
          this.nextId = idNum + 1;
        }
      }
    } catch (e) {
      console.error('[DemoPlaylist] Failed to import playlists:', e);
    }
  }

  /**
   * Get playlist count.
   * @returns Number of playlists
   */
  getCount(): number {
    return this.playlists.size;
  }
}
