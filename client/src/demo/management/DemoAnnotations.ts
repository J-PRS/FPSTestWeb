/**
 * Demo annotation for marking specific moments.
 */
export interface DemoAnnotation {
  /** Annotation ID */
  id: string;
  /** Annotation type */
  type: 'note' | 'highlight' | 'bug' | 'suggestion';
  /** Timestamp in demo */
  timestamp: number;
  /** Title */
  title: string;
  /** Description */
  description: string;
  /** Author */
  author: string;
  /** Created at */
  createdAt: number;
  /** Updated at */
  updatedAt: number;
  /** Tags */
  tags: string[];
  /** Color for UI */
  color: string;
}

/**
 * Demo annotation system.
 * Allows users to add notes, highlights, and feedback to demos.
 */
export class DemoAnnotations {
  private annotations: Map<string, DemoAnnotation> = new Map();
  private nextId: number = 1;

  /**
   * Add an annotation.
   * @param timestamp - Timestamp in demo
   * @param type - Annotation type
   * @param title - Title
   * @param description - Description
   * @param author - Author name
   * @param tags - Optional tags
   * @param color - Optional color
   * @returns Annotation ID
   */
  addAnnotation(
    timestamp: number,
    type: 'note' | 'highlight' | 'bug' | 'suggestion',
    title: string,
    description: string,
    author: string,
    tags: string[] = [],
    color: string = '#ffffff'
  ): string {
    const id = `annotation_${this.nextId++}`;
    const now = Date.now();

    const annotation: DemoAnnotation = {
      id,
      type,
      timestamp,
      title,
      description,
      author,
      createdAt: now,
      updatedAt: now,
      tags,
      color,
    };

    this.annotations.set(id, annotation);
    return id;
  }

  /**
   * Remove an annotation.
   * @param id - Annotation ID
   */
  removeAnnotation(id: string): void {
    this.annotations.delete(id);
  }

  /**
   * Get an annotation by ID.
   * @param id - Annotation ID
   * @returns Annotation or undefined
   */
  getAnnotation(id: string): DemoAnnotation | undefined {
    return this.annotations.get(id);
  }

  /**
   * Get all annotations.
   * @returns Array of annotations sorted by timestamp
   */
  getAllAnnotations(): DemoAnnotation[] {
    return Array.from(this.annotations.values()).sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Get annotations by type.
   * @param type - Annotation type
   * @returns Array of annotations
   */
  getAnnotationsByType(type: 'note' | 'highlight' | 'bug' | 'suggestion'): DemoAnnotation[] {
    return this.getAllAnnotations().filter((a) => a.type === type);
  }

  /**
   * Get annotations by author.
   * @param author - Author name
   * @returns Array of annotations
   */
  getAnnotationsByAuthor(author: string): DemoAnnotation[] {
    return this.getAllAnnotations().filter((a) => a.author === author);
  }

  /**
   * Get annotations by tag.
   * @param tag - Tag name
   * @returns Array of annotations
   */
  getAnnotationsByTag(tag: string): DemoAnnotation[] {
    return this.getAllAnnotations().filter((a) => a.tags.includes(tag));
  }

  /**
   * Get annotations in a time range.
   * @param startTime - Start time
   * @param endTime - End time
   * @returns Array of annotations in range
   */
  getAnnotationsInRange(startTime: number, endTime: number): DemoAnnotation[] {
    return this.getAllAnnotations().filter(
      (a) => a.timestamp >= startTime && a.timestamp <= endTime
    );
  }

  /**
   * Search annotations by text.
   * @param query - Search query
   * @returns Array of matching annotations
   */
  searchAnnotations(query: string): DemoAnnotation[] {
    const lowerQuery = query.toLowerCase();
    return this.getAllAnnotations().filter(
      (a) =>
        a.title.toLowerCase().includes(lowerQuery) ||
        a.description.toLowerCase().includes(lowerQuery) ||
        a.tags.some((t) => t.toLowerCase().includes(lowerQuery))
    );
  }

  /**
   * Update an annotation.
   * @param id - Annotation ID
   * @param updates - Partial annotation data to update
   */
  updateAnnotation(id: string, updates: Partial<DemoAnnotation>): void {
    const annotation = this.annotations.get(id);
    if (annotation) {
      this.annotations.set(id, {
        ...annotation,
        ...updates,
        updatedAt: Date.now(),
      });
    }
  }

  /**
   * Clear all annotations.
   */
  clearAnnotations(): void {
    this.annotations.clear();
    this.nextId = 1;
  }

  /**
   * Export annotations to JSON.
   * @returns JSON string
   */
  exportToJSON(): string {
    const annotations = this.getAllAnnotations();
    return JSON.stringify(annotations, null, 2);
  }

  /**
   * Import annotations from JSON.
   * @param json - JSON string
   */
  importFromJSON(json: string): void {
    try {
      const annotations: DemoAnnotation[] = JSON.parse(json);
      this.clearAnnotations();

      for (const annotation of annotations) {
        this.annotations.set(annotation.id, annotation);
        const idNum = parseInt(annotation.id.replace('annotation_', ''), 10);
        if (idNum >= this.nextId) {
          this.nextId = idNum + 1;
        }
      }
    } catch (e) {
      console.error('[DemoAnnotations] Failed to import annotations:', e);
    }
  }

  /**
   * Get all unique tags.
   * @returns Array of unique tags
   */
  getAllTags(): string[] {
    const tags = new Set<string>();
    for (const annotation of this.annotations.values()) {
      for (const tag of annotation.tags) {
        tags.add(tag);
      }
    }
    return Array.from(tags).sort();
  }

  /**
   * Get annotation count.
   * @returns Number of annotations
   */
  getCount(): number {
    return this.annotations.size;
  }

  /**
   * Get annotation count by type.
   * @returns Object with counts by type
   */
  getCountByType(): Record<string, number> {
    const counts: Record<string, number> = {
      note: 0,
      highlight: 0,
      bug: 0,
      suggestion: 0,
    };

    for (const annotation of this.annotations.values()) {
      counts[annotation.type]++;
    }

    return counts;
  }
}
